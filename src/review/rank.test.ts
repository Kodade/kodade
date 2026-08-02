import { describe, expect, it } from "vitest";
import type { FileDiff, Hunk, NumstatEntry } from "./model";
import { rankFiles } from "./rank";

// Minimal FileDiff builder: only the fields rank.ts inspects (path/status/
// churn/hunks) need to be realistic — hunk *content* is irrelevant to ranking.
function file(opts: {
  path: string;
  status?: FileDiff["status"];
  oldPath?: string | null;
  adds?: number;
  dels?: number;
  binary?: boolean;
  hunkCount?: number;
}): FileDiff {
  const hunkCount = opts.hunkCount ?? (opts.adds || opts.dels ? 1 : 0);
  const hunks: Hunk[] = Array.from({ length: hunkCount }, (_, i) => ({
    header: `@@ -${i + 1},1 +${i + 1},1 @@`,
    oldStart: i + 1,
    oldLines: 1,
    newStart: i + 1,
    newLines: 1,
    lines: [],
  }));
  return {
    oldPath: opts.oldPath ?? (opts.status === "added" ? null : opts.path),
    newPath: opts.status === "deleted" ? null : opts.path,
    status: opts.status ?? "modified",
    adds: opts.adds ?? 0,
    dels: opts.dels ?? 0,
    binary: opts.binary ?? false,
    hunks,
  };
}

describe("rankFiles", () => {
  it("bumps a security-sensitive path to risky regardless of size", () => {
    const [ranked] = rankFiles([file({ path: "src/auth/session.ts", adds: 2, dels: 1 })]);
    expect(ranked.bucket).toBe("risky");
    expect(ranked.reasons).toContain("security-sensitive path");
  });

  it("keeps a lockfile trivial even with large churn", () => {
    const [ranked] = rankFiles([file({ path: "pnpm-lock.yaml", adds: 500, dels: 400 })]);
    expect(ranked.bucket).toBe("trivial");
    expect(ranked.reasons).toContain("lockfile change");
  });

  it("keeps docs trivial unless huge, then promotes them", () => {
    const small = rankFiles([file({ path: "docs/notes.md", adds: 10, dels: 2 })])[0];
    expect(small.bucket).toBe("trivial");
    const huge = rankFiles([file({ path: "docs/notes.md", adds: 300, dels: 200 })])[0];
    expect(huge.bucket).not.toBe("trivial");
    expect(huge.reasons.some((r) => r.includes("large documentation change"))).toBe(true);
  });

  it("flags a source file with no matching test change in the set", () => {
    const files = [file({ path: "src/review/rank.ts", adds: 40, dels: 5 })];
    const [ranked] = rankFiles(files);
    expect(ranked.reasons).toContain("source change with no matching test change");

    const withTest = [
      file({ path: "src/review/rank.ts", adds: 40, dels: 5 }),
      file({ path: "src/review/rank.test.ts", adds: 20, dels: 0 }),
    ];
    const rankedWithTest = rankFiles(withTest).find((r) => r.path === "src/review/rank.ts")!;
    expect(rankedWithTest.reasons).not.toContain("source change with no matching test change");
  });

  it("flags dense hunks and new files with no tests", () => {
    const dense = rankFiles([file({ path: "src/foo.ts", adds: 20, dels: 20, hunkCount: 6 })])[0];
    expect(dense.reasons.some((r) => r.includes("dense hunks"))).toBe(true);

    const newFile = rankFiles([file({ path: "src/new-thing.ts", status: "added", adds: 30 })])[0];
    expect(newFile.reasons).toContain("new file with no tests");
  });

  it("produces a total ordering: risky before routine before trivial, by score within a bucket", () => {
    const files = [
      file({ path: "pnpm-lock.yaml", adds: 3, dels: 1 }),
      file({ path: "src/ipc/guard.ts", adds: 5, dels: 1 }),
      file({ path: ".github/workflows/ci.yml", adds: 10, dels: 2 }),
      file({ path: "src/components/Widget.tsx", adds: 12, dels: 3 }),
      file({ path: "src/components/Widget.test.tsx", adds: 8, dels: 0 }),
    ];
    const ranked = rankFiles(files);
    const buckets = ranked.map((r) => r.bucket);
    // risky entries all precede routine, which all precede trivial
    const firstRoutine = buckets.indexOf("routine");
    const firstTrivial = buckets.indexOf("trivial");
    expect(buckets.slice(0, firstRoutine).every((b) => b === "risky")).toBe(true);
    if (firstTrivial >= 0) {
      expect(buckets.slice(firstRoutine, firstTrivial).every((b) => b === "routine")).toBe(true);
    }
    expect(ranked.map((r) => r.path)).toContain("pnpm-lock.yaml");
    expect(ranked[ranked.length - 1].path).toBe("pnpm-lock.yaml"); // trivial, lowest score
  });

  it("accepts NumstatEntry input (churn-only, no hunk data)", () => {
    const entries: NumstatEntry[] = [
      { oldPath: null, newPath: "src/auth/token.ts", adds: 4, dels: 1, binary: false, renamed: false },
      { oldPath: null, newPath: "pnpm-lock.yaml", adds: 100, dels: 90, binary: false, renamed: false },
    ];
    const ranked = rankFiles(entries);
    expect(ranked.find((r) => r.path === "src/auth/token.ts")!.bucket).toBe("risky");
    expect(ranked.find((r) => r.path === "pnpm-lock.yaml")!.bucket).toBe("trivial");
  });

  it("returns [] for an empty file set", () => {
    expect(rankFiles([])).toEqual([]);
  });
});
