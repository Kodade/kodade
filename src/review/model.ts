// Shared types for the KödPR review engine: the parsed diff model, git
// status/worktree models, ranking output, and review comments. Pure data
// only — no IO, no React, no Tauri. parse.ts/rank.ts/prompt.ts all import
// from here so they can be tested independently without cycles.

export type DiffLineKind = "context" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  // Exact byte content of the line (no marker char, no trailing newline).
  // CRLF source lines keep their trailing "\r" here untouched.
  content: string;
  oldLine: number | null; // null for pure additions
  newLine: number | null; // null for pure deletions
};

export type Hunk = {
  header: string; // raw "@@ -a,b +c,d @@ context" line, byte-preserved
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

export type FileDiff = {
  oldPath: string | null; // null when added
  newPath: string | null; // null when deleted
  status: FileStatus;
  adds: number;
  dels: number;
  binary: boolean;
  hunks: Hunk[];
};

// The path to show for a file: prefer the new path, fall back to old (deletes).
export function filePath(file: FileDiff): string {
  return file.newPath ?? file.oldPath ?? "";
}

export type NumstatEntry = {
  oldPath: string | null; // set only for renames/copies
  newPath: string;
  adds: number | null; // null for binary ("-\t-")
  dels: number | null;
  binary: boolean;
  renamed: boolean;
};

export type StatusEntryKind = "ordinary" | "renamed" | "untracked" | "ignored" | "unmerged";

export type StatusEntry = {
  kind: StatusEntryKind;
  path: string;
  origPath: string | null; // renamed/copied entries only
  indexStatus: string | null; // the X of XY (staged side); null for untracked/ignored
  worktreeStatus: string | null; // the Y of XY (worktree side)
};

export type WorktreeEntry = {
  path: string;
  head: string | null;
  branch: string | null; // null when detached
  bare: boolean;
  detached: boolean;
  locked: string | null; // lock reason ("" if locked with none given); null if not locked
  prunable: string | null; // prunable reason; null if not prunable
};

// Every parser is tolerant: malformed records are skipped, not thrown, and
// collected here so callers can surface them without losing the rest.
export type ParseResult<T> = { items: T[]; warnings: string[] };

export type RiskBucket = "risky" | "routine" | "trivial";

export type RankedFile = {
  path: string;
  bucket: RiskBucket;
  score: number; // higher = riskier; drives ordering within and across buckets
  adds: number;
  dels: number;
  reasons: string[]; // human-readable heuristic hits, in the order they fired
};

export type ReviewComment = {
  path: string;
  // 1-based inclusive line range, addressed against the new-file line numbers
  // (or old-file numbers for a comment on a pure deletion).
  startLine: number;
  endLine: number;
  body: string;
};
