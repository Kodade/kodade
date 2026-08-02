// Risk ranking for a diff's file set: transparent local heuristics only, no
// IO and no model calls, so "why did this rank here" is always answerable
// from `reasons`. Accepts either the full unified-diff model (FileDiff, which
// has hunks) or a numstat summary (NumstatEntry, churn counts only) — hunk
// density and new-file detection only fire when hunk data is available.

import type { FileDiff, NumstatEntry, RankedFile, RiskBucket } from "./model";

export type RankOptions = {
  // Extra path patterns treated as security-sensitive, on top of the built-in set.
  securityPatterns?: RegExp[];
  // adds+dels above which a doc file stops counting as automatically trivial.
  hugeLineThreshold?: number;
};

const DEFAULT_HUGE_LINE_THRESHOLD = 400;

// Security-sensitive path fragments: touching these gets bumped to risky
// regardless of how small the diff looks, since a one-line change to an
// allowlist or a guard check can matter more than a large refactor.
const SECURITY_PATTERN =
  /(^|[/_-])(auth|crypto|guard|permission|ipc|allowlist|allow-list|command)/i;

const LOCKFILE_PATTERN =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$/;
const DOCS_PATTERN = /\.(md|mdx|txt)$/i;
const CONFIG_PATTERN =
  /(^|\/)(\.github\/workflows\/|\.circleci\/|\.gitlab-ci\.yml|package\.json|tsconfig[^/]*\.json|vite\.config\.|vitest\.config\.|\.eslintrc|Dockerfile|docker-compose)/;
const TEST_PATTERN = /(\.(test|spec)\.[jt]sx?$)|(^|\/)(tests?|__tests__)\//;
const SOURCE_EXT_PATTERN = /\.(ts|tsx|js|jsx|rs|py|go|rb|java|kt|swift)$/;

type FileKind = "lockfile" | "docs" | "config" | "test" | "source" | "other";

function classify(path: string): FileKind {
  if (LOCKFILE_PATTERN.test(path)) return "lockfile";
  if (TEST_PATTERN.test(path)) return "test";
  if (DOCS_PATTERN.test(path)) return "docs";
  if (CONFIG_PATTERN.test(path)) return "config";
  if (SOURCE_EXT_PATTERN.test(path)) return "source";
  return "other";
}

// Normalized shape both FileDiff and NumstatEntry reduce to before scoring.
type RankInput = {
  path: string;
  adds: number;
  dels: number;
  binary: boolean;
  isNew: boolean; // reliable only from FileDiff (numstat carries no add/delete marker)
  isRenamed: boolean;
  hunkCount: number | null; // null when the input is a numstat summary
};

function isFileDiff(f: FileDiff | NumstatEntry): f is FileDiff {
  return "hunks" in f;
}

function normalize(f: FileDiff | NumstatEntry): RankInput {
  if (isFileDiff(f)) {
    return {
      path: f.newPath ?? f.oldPath ?? "",
      adds: f.adds,
      dels: f.dels,
      binary: f.binary,
      isNew: f.status === "added",
      isRenamed: f.status === "renamed",
      hunkCount: f.hunks.length,
    };
  }
  return {
    path: f.newPath,
    adds: f.adds ?? 0,
    dels: f.dels ?? 0,
    binary: f.binary,
    isNew: false, // numstat alone can't distinguish "added" from "modified"
    isRenamed: f.renamed,
    hunkCount: null,
  };
}

// Does the file set contain a test file that looks like it exercises `path`?
// Matched by shared basename stem, e.g. "src/review/rank.ts" <-> "rank.test.ts".
function hasSiblingTest(path: string, all: RankInput[]): boolean {
  const stem = path.replace(/\.(ts|tsx|js|jsx|rs|py|go|rb)$/, "").split("/").pop();
  if (!stem) return false;
  return all.some((f) => TEST_PATTERN.test(f.path) && f.path.includes(stem));
}

export function rankFiles(files: FileDiff[] | NumstatEntry[], opts: RankOptions = {}): RankedFile[] {
  const hugeLineThreshold = opts.hugeLineThreshold ?? DEFAULT_HUGE_LINE_THRESHOLD;
  const securityPattern = opts.securityPatterns?.length
    ? new RegExp(opts.securityPatterns.map((p) => p.source).concat(SECURITY_PATTERN.source).join("|"), "i")
    : SECURITY_PATTERN;

  const inputs = (files as (FileDiff | NumstatEntry)[]).map(normalize);
  const totalChurn = inputs.reduce((sum, f) => sum + f.adds + f.dels, 0);
  const avgChurn = inputs.length > 0 ? totalChurn / inputs.length : 0;

  const ranked: RankedFile[] = inputs.map((input) => {
    const churn = input.adds + input.dels;
    const kind = classify(input.path);
    const reasons: string[] = [];
    let score = 0;
    let forceRisky = false;

    if (input.binary) {
      reasons.push("binary file");
      score += 2;
    }

    switch (kind) {
      case "lockfile":
        reasons.push("lockfile change");
        score += 1;
        break;
      case "docs":
        if (churn > hugeLineThreshold) {
          reasons.push(`large documentation change (${churn} lines)`);
          score += 15;
        } else {
          reasons.push("documentation change");
          score += 1;
        }
        break;
      case "config":
        reasons.push("config/CI change");
        score += 12;
        break;
      case "test":
        reasons.push("test change");
        score += 8;
        break;
      case "source":
        reasons.push("source change");
        score += 10;
        break;
      case "other":
        score += 6;
        break;
    }

    // Churn size: bigger diffs need more attention, scaled modestly so kind
    // still dominates the baseline.
    if (churn > 0) score += Math.min(churn, 600) * 0.1;

    // Churn concentration: a file carrying much more than its even share of
    // the reviewed set's total churn is disproportionately worth reading first.
    if (inputs.length > 1 && avgChurn > 0 && churn > avgChurn * 3 && churn > 20) {
      reasons.push(`concentrated churn (${churn} of ${totalChurn} lines changed)`);
      score += 10;
    }

    // Dense hunks: many separate hunks in one file means scattered, harder-
    // to-follow changes rather than one contiguous edit.
    if (input.hunkCount !== null && input.hunkCount >= 5) {
      reasons.push(`dense hunks (${input.hunkCount} separate hunks)`);
      score += 8;
    }

    // Source changed with no matching test change in this same review set.
    if (kind === "source" && !hasSiblingTest(input.path, inputs)) {
      reasons.push("source change with no matching test change");
      score += 12;
    }

    // New source file shipped with no tests at all.
    if (input.isNew && kind === "source" && !hasSiblingTest(input.path, inputs)) {
      reasons.push("new file with no tests");
      score += 8;
    }

    // Security-sensitive path: always risky, whatever the churn looks like.
    if (securityPattern.test(input.path)) {
      reasons.push("security-sensitive path");
      score += 30;
      forceRisky = true;
    }

    let bucket: RiskBucket;
    if (forceRisky) bucket = "risky";
    else if (kind === "lockfile" || (kind === "docs" && churn <= hugeLineThreshold)) bucket = "trivial";
    else if (score >= 30) bucket = "risky";
    else if (score >= 12) bucket = "routine";
    else bucket = "trivial";

    return { path: input.path, bucket, score, adds: input.adds, dels: input.dels, reasons };
  });

  const bucketRank: Record<RiskBucket, number> = { risky: 0, routine: 1, trivial: 2 };
  return ranked.sort((a, b) => {
    if (bucketRank[a.bucket] !== bucketRank[b.bucket]) return bucketRank[a.bucket] - bucketRank[b.bucket];
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });
}
