// Parsers for raw git output. Every function here is pure text-in,
// typed-data-out: no throwing on malformed input — a bad record is skipped
// and noted in `warnings` so the rest of the parse still succeeds. Byte
// content of diff lines is preserved exactly (including a trailing "\r" on
// CRLF source files) since we only ever split on "\n".

import type {
  DiffLine,
  FileDiff,
  FileStatus,
  Hunk,
  NumstatEntry,
  ParseResult,
  StatusEntry,
  WorktreeEntry,
} from "./model";

// Split on "\n" only (never "\r\n") so CRLF content survives untouched in
// the remainder of each line. Drops the single trailing empty element left
// by a final newline; an empty input yields no lines at all.
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))?\s\+(\d+)(?:,(\d+))?\s@@(.*)$/;

// Parse one hunk starting at `lines[start]` (the "@@ ... @@" line). Returns
// the hunk and the index of the first line after it.
function parseHunk(
  lines: string[],
  start: number,
  warnings: string[],
): { hunk: Hunk; next: number } {
  const header = lines[start];
  const m = HUNK_HEADER.exec(header);
  if (!m) warnings.push(`malformed hunk header: ${JSON.stringify(header)}`);
  const oldStart = m ? Number(m[1]) : 0;
  const oldLines = m && m[2] !== undefined ? Number(m[2]) : 1;
  const newStart = m ? Number(m[3]) : 0;
  const newLines = m && m[4] !== undefined ? Number(m[4]) : 1;

  let oldLine = oldStart;
  let newLine = newStart;
  const dlines: DiffLine[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("@@ ") || l.startsWith("diff --git ")) break;
    if (l.startsWith("\\")) {
      i++; // "\ No newline at end of file" — not a content line
      continue;
    }
    if (l.startsWith("+")) {
      dlines.push({ kind: "add", content: l.slice(1), oldLine: null, newLine });
      newLine++;
    } else if (l.startsWith("-")) {
      dlines.push({ kind: "del", content: l.slice(1), oldLine, newLine: null });
      oldLine++;
    } else if (l.startsWith(" ") || l === "") {
      dlines.push({ kind: "context", content: l === "" ? "" : l.slice(1), oldLine, newLine });
      oldLine++;
      newLine++;
    } else {
      warnings.push(`unrecognized diff line skipped: ${JSON.stringify(l)}`);
    }
    i++;
  }
  return { hunk: { header, oldStart, oldLines, newStart, newLines, lines: dlines }, next: i };
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

// Parse `git diff` / `gh pr diff` unified-diff text (same format either way)
// into a typed model. Preamble/unknown lines outside a "diff --git" section
// are skipped rather than rejected.
export function parseUnifiedDiff(text: string): ParseResult<FileDiff> {
  const warnings: string[] = [];
  const files: FileDiff[] = [];
  const lines = splitLines(text);
  let i = 0;
  while (i < lines.length) {
    const headerMatch = FILE_HEADER.exec(lines[i]);
    if (!headerMatch) {
      i++;
      continue;
    }
    let oldPath: string | null = headerMatch[1];
    let newPath: string | null = headerMatch[2];
    let sawNewFileMode = false;
    let sawDeletedFileMode = false;
    let sawRename = false;
    let binary = false;
    const hunks: Hunk[] = [];
    i++;
    while (i < lines.length && !lines[i].startsWith("diff --git ")) {
      const l = lines[i];
      if (l.startsWith("@@ ")) {
        const parsed = parseHunk(lines, i, warnings);
        hunks.push(parsed.hunk);
        i = parsed.next;
        continue;
      }
      let m: RegExpExecArray | null;
      if (l.startsWith("new file mode")) sawNewFileMode = true;
      else if (l.startsWith("deleted file mode")) sawDeletedFileMode = true;
      else if ((m = /^rename from (.+)$/.exec(l))) {
        oldPath = m[1];
        sawRename = true;
      } else if ((m = /^rename to (.+)$/.exec(l))) {
        newPath = m[1];
        sawRename = true;
      } else if ((m = /^copy from (.+)$/.exec(l))) {
        oldPath = m[1];
        sawRename = true;
      } else if ((m = /^copy to (.+)$/.exec(l))) {
        newPath = m[1];
        sawRename = true;
      } else if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) {
        binary = true;
      } else if ((m = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(l))) {
        oldPath = m[1] ?? null;
      } else if ((m = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(l))) {
        newPath = m[1] ?? null;
      }
      // else: mode/index/similarity/etc. — not needed for the model, ignore
      i++;
    }

    let status: FileStatus;
    if (sawRename) status = "renamed";
    else if (binary) status = "binary";
    else if (sawDeletedFileMode || newPath === null) status = "deleted";
    else if (sawNewFileMode || oldPath === null) status = "added";
    else status = "modified";

    let adds = 0;
    let dels = 0;
    for (const h of hunks) {
      for (const dl of h.lines) {
        if (dl.kind === "add") adds++;
        else if (dl.kind === "del") dels++;
      }
    }

    files.push({ oldPath, newPath, status, adds, dels, binary, hunks });
  }
  return { items: files, warnings };
}

// Parse `git diff --numstat -z` output. Plain entries are one NUL-terminated
// "adds\tdels\tpath" token; renames/copies split the path into an empty
// placeholder followed by two NUL-terminated path tokens (old, then new).
export function parseNumstat(text: string): ParseResult<NumstatEntry> {
  const warnings: string[] = [];
  const items: NumstatEntry[] = [];
  if (text.length === 0) return { items, warnings };
  const tokens = text.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();

  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    const parts = head.split("\t");
    if (parts.length < 3) {
      warnings.push(`malformed numstat record: ${JSON.stringify(head)}`);
      i++;
      continue;
    }
    const [addsRaw, delsRaw, path] = parts;
    const binary = addsRaw === "-" && delsRaw === "-";
    const adds = addsRaw === "-" ? null : Number(addsRaw);
    const dels = delsRaw === "-" ? null : Number(delsRaw);
    if (path === "") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath === undefined || newPath === undefined) {
        warnings.push(`truncated rename numstat record: ${JSON.stringify(head)}`);
        i++;
        continue;
      }
      items.push({ oldPath, newPath, adds, dels, binary, renamed: true });
      i += 3;
    } else {
      items.push({ oldPath: null, newPath: path, adds, dels, binary, renamed: false });
      i += 1;
    }
  }
  return { items, warnings };
}

const STATUS_ORDINARY = /^1 (\S{2}) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/;
const STATUS_RENAMED = /^2 (\S{2}) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/;
const STATUS_UNMERGED = /^u (\S{2}) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/;

// Parse `git status --porcelain=v2 -z` output. Rename/copy records ("2 ...")
// carry the original path as a second NUL-terminated token; every other
// record kind is a single token.
export function parseStatusPorcelainV2(text: string): ParseResult<StatusEntry> {
  const warnings: string[] = [];
  const items: StatusEntry[] = [];
  if (text.length === 0) return { items, warnings };
  const tokens = text.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.startsWith("1 ")) {
      const m = STATUS_ORDINARY.exec(tok);
      if (!m) {
        warnings.push(`malformed status line: ${JSON.stringify(tok)}`);
        i++;
        continue;
      }
      items.push({
        kind: "ordinary",
        path: m[8],
        origPath: null,
        indexStatus: m[1][0],
        worktreeStatus: m[1][1],
      });
      i++;
    } else if (tok.startsWith("2 ")) {
      const m = STATUS_RENAMED.exec(tok);
      const origPath = tokens[i + 1];
      if (!m || origPath === undefined) {
        warnings.push(`malformed status rename line: ${JSON.stringify(tok)}`);
        i++;
        continue;
      }
      items.push({
        kind: "renamed",
        path: m[9],
        origPath,
        indexStatus: m[1][0],
        worktreeStatus: m[1][1],
      });
      i += 2;
    } else if (tok.startsWith("u ")) {
      const m = STATUS_UNMERGED.exec(tok);
      if (!m) {
        warnings.push(`malformed unmerged status line: ${JSON.stringify(tok)}`);
        i++;
        continue;
      }
      items.push({
        kind: "unmerged",
        path: m[9],
        origPath: null,
        indexStatus: m[1][0],
        worktreeStatus: m[1][1],
      });
      i++;
    } else if (tok.startsWith("? ")) {
      items.push({
        kind: "untracked",
        path: tok.slice(2),
        origPath: null,
        indexStatus: null,
        worktreeStatus: null,
      });
      i++;
    } else if (tok.startsWith("! ")) {
      items.push({
        kind: "ignored",
        path: tok.slice(2),
        origPath: null,
        indexStatus: null,
        worktreeStatus: null,
      });
      i++;
    } else if (tok === "") {
      i++;
    } else {
      warnings.push(`unrecognized status v2 record: ${JSON.stringify(tok)}`);
      i++;
    }
  }
  return { items, warnings };
}

// Parse `git worktree list --porcelain` output: blank-line-separated blocks
// of "key value" lines (plus bare "bare"/"detached" flags).
export function parseWorktreeList(text: string): ParseResult<WorktreeEntry> {
  const warnings: string[] = [];
  const items: WorktreeEntry[] = [];
  const trimmed = text.replace(/\n+$/, "");
  if (trimmed.length === 0) return { items, warnings };

  const blocks = trimmed.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let bare = false;
    let detached = false;
    let locked: string | null = null;
    let prunable: string | null = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
      else if (line === "bare") bare = true;
      else if (line === "detached") detached = true;
      else if (line === "locked" || line.startsWith("locked "))
        locked = line === "locked" ? "" : line.slice("locked ".length);
      else if (line === "prunable" || line.startsWith("prunable "))
        prunable = line === "prunable" ? "" : line.slice("prunable ".length);
      else warnings.push(`unrecognized worktree list line: ${JSON.stringify(line)}`);
    }
    if (path === null) {
      warnings.push(`worktree block missing path: ${JSON.stringify(block)}`);
      continue;
    }
    items.push({ path, head, branch, bare, detached, locked, prunable });
  }
  return { items, warnings };
}
