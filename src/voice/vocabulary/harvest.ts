// Pure vocabulary harvest over a repo file listing + package names + user terms.
// The defensible premium: KödWhisper knows the exact symbols in THIS repo, so it
// biases the decode toward them. This function is deliberately side-effect free
// (the public TDD seam) — the store hands it a listing and gets back a Vocabulary.

import type { Vocabulary } from "./types";

export type HarvestInput = {
  // Repo-relative paths (e.g. "src/voice/store.ts"). Order is irrelevant.
  files?: readonly string[];
  // Dependency / package names (e.g. "zustand", "@xterm/xterm").
  packageNames?: readonly string[];
  // User-defined jargon/terms. Always kept, highest priority, never filtered.
  userTerms?: readonly string[];
  // Cap on HARVESTED terms (user terms are always kept on top of this).
  limit?: number;
};

// Whisper's prompt window is small; a few hundred biased terms is already more
// than an initial_prompt can carry, so cap the harvest to keep the later
// prompt-building step honest rather than silently truncating a huge list.
const DEFAULT_LIMIT = 192;

// Extensions worth biasing when a user dictates a file name ("projects dot ts").
// Kept to source-ish files so the list stays focused on real identifiers.
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "rb", "java", "kt", "swift", "c", "h", "cpp", "cc",
  "json", "toml", "yaml", "yml", "md", "css", "scss", "sql", "sh",
]);

// A file under any of these is pure noise — skip the whole path.
const NOISE_DIRS = new Set([
  "node_modules", "dist", "build", "target", "out", "coverage",
  ".git", ".github", "vendor", "__pycache__", ".next", ".cache",
]);

// Common source-root segments worth walking through but not biasing on.
const SKIP_SEGMENTS = new Set(["src", "lib", "test", "tests", "app"]);

// Plain lowercase words whisper already gets right — dropped as bare stems so
// the bias list is the HARD identifiers, not an English dictionary.
const STOP_STEMS = new Set([
  "index", "main", "mod", "types", "type", "utils", "util", "helpers",
  "helper", "config", "readme", "license", "package", "store", "model",
  "models", "app", "core", "common", "shared", "data", "test", "spec",
]);

// An identifier is "interesting" (worth biasing) when whisper is likely to get
// it wrong: it mixes case (camelCase/PascalCase), carries a digit, or uses a
// code separator. Bare lowercase dictionary words are not.
function isInterestingStem(stem: string): boolean {
  if (stem.length < 2) return false;
  const hasUpperInside = /[a-z][A-Z]|[A-Z][a-z].*[A-Z]/.test(stem);
  const hasDigit = /\d/.test(stem);
  const hasSeparator = /[_-]/.test(stem);
  const isAcronym = /^[A-Z]{2,}$/.test(stem);
  return hasUpperInside || hasDigit || hasSeparator || isAcronym;
}

function splitExtension(basename: string): { stem: string; ext: string | null } {
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return { stem: basename, ext: null };
  return { stem: basename.slice(0, dot), ext: basename.slice(dot + 1).toLowerCase() };
}

// Strip a leading npm scope so "@xterm/xterm" contributes "xterm" (the token a
// user actually says) alongside the full package name.
function packageCandidates(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const out = [trimmed];
  const scoped = /^@[^/]+\/(.+)$/.exec(trimmed);
  if (scoped) out.push(scoped[1]);
  return out;
}

// Case-insensitive dedupe that preserves first-seen casing and order.
function dedupe(terms: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

export function harvestVocabulary(input: HarvestInput): Vocabulary {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const harvested: string[] = [];

  for (const raw of input.files ?? []) {
    const path = raw.trim();
    if (!path) continue;
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.some((segment) => NOISE_DIRS.has(segment.toLowerCase()))) continue;
    segments.forEach((segment, index) => {
      if (SKIP_SEGMENTS.has(segment.toLowerCase())) return;
      const isLast = index === segments.length - 1;
      if (isLast) {
        const { stem, ext } = splitExtension(segment);
        // Bias the full file name when it's a code-ish file (dictated as
        // "store dot ts") and the stem when it's a hard identifier.
        if (ext && CODE_EXTENSIONS.has(ext)) harvested.push(segment);
        if (isInterestingStem(stem) && !STOP_STEMS.has(stem.toLowerCase())) {
          harvested.push(stem);
        }
      } else if (
        isInterestingStem(segment) &&
        !STOP_STEMS.has(segment.toLowerCase())
      ) {
        // A directory name like "large-v3-turbo" is worth biasing too.
        harvested.push(segment);
      }
    });
  }

  for (const name of input.packageNames ?? []) {
    for (const candidate of packageCandidates(name)) harvested.push(candidate);
  }

  const cappedHarvest = dedupe(harvested).slice(0, Math.max(0, limit));
  const userTerms = (input.userTerms ?? [])
    .map((term) => term.trim())
    .filter(Boolean);

  // User terms lead and are never filtered; harvested symbols follow.
  return { terms: dedupe([...userTerms, ...cappedHarvest]) };
}
