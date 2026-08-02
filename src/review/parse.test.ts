import { describe, expect, it } from "vitest";
import {
  parseNumstat,
  parseStatusPorcelainV2,
  parseUnifiedDiff,
  parseWorktreeList,
} from "./parse";

// Fixture captured verbatim from `git diff --cached -M` on a real repo with
// an added file, a CRLF-line-ending file, a deletion, a plain modification,
// a detected rename, and a binary file — the exact mix of shapes the review
// engine needs to cover.
const MULTI_FILE_DIFF =
  "diff --git a/add.txt b/add.txt\n" +
  "new file mode 100644\n" +
  "index 0000000..5e86699\n" +
  "--- /dev/null\n" +
  "+++ b/add.txt\n" +
  "@@ -0,0 +1,2 @@\n" +
  "+brand new file\n" +
  "+second line\n" +
  "diff --git a/crlf.txt b/crlf.txt\n" +
  "index fc5a082..f6c87d2 100644\n" +
  "--- a/crlf.txt\n" +
  "+++ b/crlf.txt\n" +
  "@@ -1,3 +1,3 @@\n" +
  " line a\r\n" +
  "-line b\r\n" +
  "+LINE B CHANGED\r\n" +
  " line c\r\n" +
  "diff --git a/del.txt b/del.txt\n" +
  "deleted file mode 100644\n" +
  "index 528557a..0000000\n" +
  "--- a/del.txt\n" +
  "+++ /dev/null\n" +
  "@@ -1 +0,0 @@\n" +
  "-will be deleted\n" +
  "diff --git a/mod.txt b/mod.txt\n" +
  "index faf3c54..cd51808 100644\n" +
  "--- a/mod.txt\n" +
  "+++ b/mod.txt\n" +
  "@@ -1,5 +1,6 @@\n" +
  " keep this line\n" +
  "-old body 1\n" +
  "+NEW body 1\n" +
  " old body 2\n" +
  "-old body 3\n" +
  "+NEW body 3\n" +
  " tail\n" +
  "+extra tail\n" +
  "diff --git a/oldname.txt b/newname.txt\n" +
  "similarity index 83%\n" +
  "rename from oldname.txt\n" +
  "rename to newname.txt\n" +
  "index b15cc47..1707b56 100644\n" +
  "--- a/oldname.txt\n" +
  "+++ b/newname.txt\n" +
  "@@ -3,3 +3,4 @@ bbbb\n" +
  " cccc\n" +
  " dddd\n" +
  " eeee\n" +
  "+ffff\n" +
  "diff --git a/pic.png b/pic.png\n" +
  "index 585d706..f43296b 100644\n" +
  "Binary files a/pic.png and b/pic.png differ\n";

describe("parseUnifiedDiff", () => {
  it("parses added, CRLF-modified, deleted, modified, renamed, and binary files", () => {
    const { items, warnings } = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(6);

    const [add, crlf, del, mod, renamed, binary] = items;

    expect(add).toMatchObject({ oldPath: null, newPath: "add.txt", status: "added", adds: 2, dels: 0 });
    expect(add.hunks[0].lines.map((l) => l.content)).toEqual(["brand new file", "second line"]);

    // CRLF survives exactly: each line's content still ends in "\r".
    expect(crlf.status).toBe("modified");
    expect(crlf.hunks[0].lines.map((l) => l.content)).toEqual([
      "line a\r",
      "line b\r",
      "LINE B CHANGED\r",
      "line c\r",
    ]);
    expect(crlf.hunks[0].lines.map((l) => l.kind)).toEqual(["context", "del", "add", "context"]);

    expect(del).toMatchObject({ oldPath: "del.txt", newPath: null, status: "deleted", adds: 0, dels: 1 });

    expect(mod).toMatchObject({ oldPath: "mod.txt", newPath: "mod.txt", status: "modified", adds: 3, dels: 2 });
    expect(mod.hunks[0].oldStart).toBe(1);
    expect(mod.hunks[0].newStart).toBe(1);
    expect(mod.hunks[0].newLines).toBe(6);

    expect(renamed).toMatchObject({
      oldPath: "oldname.txt",
      newPath: "newname.txt",
      status: "renamed",
      adds: 1,
      dels: 0,
    });
    expect(renamed.hunks[0].header).toBe("@@ -3,3 +3,4 @@ bbbb");

    expect(binary).toMatchObject({
      oldPath: "pic.png",
      newPath: "pic.png",
      status: "binary",
      binary: true,
      adds: 0,
      dels: 0,
      hunks: [],
    });
  });

  it("returns [] for empty input and never throws on malformed hunk headers", () => {
    expect(parseUnifiedDiff("")).toEqual({ items: [], warnings: [] });

    const malformed =
      "diff --git a/x.txt b/x.txt\n" +
      "index 111..222 100644\n" +
      "--- a/x.txt\n" +
      "+++ b/x.txt\n" +
      "@@ not a real header @@\n" +
      " context\n" +
      "+added\n";
    const { items, warnings } = parseUnifiedDiff(malformed);
    expect(items).toHaveLength(1);
    expect(items[0].hunks[0].lines.map((l) => l.content)).toEqual(["context", "added"]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("is tolerant of a trailing newline and of no trailing newline", () => {
    const withTrailing = parseUnifiedDiff(MULTI_FILE_DIFF + "\n");
    const withoutTrailing = parseUnifiedDiff(MULTI_FILE_DIFF.replace(/\n$/, ""));
    expect(withTrailing.items).toHaveLength(6);
    expect(withoutTrailing.items).toHaveLength(6);
  });
});

// Fixture captured verbatim from `git diff --cached --numstat -M -z` for the
// same change set: a plain add, a modification, a deletion, a detected
// rename (empty path field + two NUL-terminated path tokens), and a binary
// entry ("-\t-").
const NUMSTAT_Z =
  "2\t0\tadd.txt\0" +
  "1\t1\tcrlf.txt\0" +
  "0\t1\tdel.txt\0" +
  "3\t2\tmod.txt\0" +
  "1\t0\t\0oldname.txt\0newname.txt\0" +
  "-\t-\tpic.png\0";

describe("parseNumstat", () => {
  it("parses plain, renamed, and binary numstat -z records", () => {
    const { items, warnings } = parseNumstat(NUMSTAT_Z);
    expect(warnings).toEqual([]);
    expect(items).toEqual([
      { oldPath: null, newPath: "add.txt", adds: 2, dels: 0, binary: false, renamed: false },
      { oldPath: null, newPath: "crlf.txt", adds: 1, dels: 1, binary: false, renamed: false },
      { oldPath: null, newPath: "del.txt", adds: 0, dels: 1, binary: false, renamed: false },
      { oldPath: null, newPath: "mod.txt", adds: 3, dels: 2, binary: false, renamed: false },
      { oldPath: "oldname.txt", newPath: "newname.txt", adds: 1, dels: 0, binary: false, renamed: true },
      { oldPath: null, newPath: "pic.png", adds: null, dels: null, binary: true, renamed: false },
    ]);
  });

  it("returns [] for empty input and skips a truncated record with a warning", () => {
    expect(parseNumstat("")).toEqual({ items: [], warnings: [] });
    const { items, warnings } = parseNumstat("not-a-numstat-line\0");
    expect(items).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});

// Fixture captured verbatim from `git status --porcelain=v2 -z`: an added
// (staged) file, a modified file, a deleted file, a staged rename, and an
// untracked file.
const STATUS_V2_Z =
  "1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 5e86699ea2ff6aba1dc8779bbebbfe2cc04bcaf3 add.txt\0" +
  "1 M. N... 100644 100644 100644 fc5a082b85ce94e0d54990bf2231652cb85a60a6 f6c87d2b1cc55c5a9625572db31989155932ba86 crlf.txt\0" +
  "1 D. N... 100644 000000 000000 528557ab3a4211d06fc2e5f8b49f14c1b0a4eac9 0000000000000000000000000000000000000000 del.txt\0" +
  "2 R. N... 100644 100644 100644 b15cc4741f8c3b17a900231c4d4398f0cb28be72 1707b561e5dc833c59672d74e97b4d3aa28c3692 R83 newname.txt\0oldname.txt\0" +
  "? untracked.txt\0";

describe("parseStatusPorcelainV2", () => {
  it("parses ordinary, renamed, and untracked entries", () => {
    const { items, warnings } = parseStatusPorcelainV2(STATUS_V2_Z);
    expect(warnings).toEqual([]);
    expect(items).toEqual([
      { kind: "ordinary", path: "add.txt", origPath: null, indexStatus: "A", worktreeStatus: "." },
      { kind: "ordinary", path: "crlf.txt", origPath: null, indexStatus: "M", worktreeStatus: "." },
      { kind: "ordinary", path: "del.txt", origPath: null, indexStatus: "D", worktreeStatus: "." },
      { kind: "renamed", path: "newname.txt", origPath: "oldname.txt", indexStatus: "R", worktreeStatus: "." },
      { kind: "untracked", path: "untracked.txt", origPath: null, indexStatus: null, worktreeStatus: null },
    ]);
  });

  it("returns [] for empty input and warns on an unrecognized record", () => {
    expect(parseStatusPorcelainV2("")).toEqual({ items: [], warnings: [] });
    const { items, warnings } = parseStatusPorcelainV2("? loose.txt\0garbage-record\0");
    expect(items).toEqual([
      { kind: "untracked", path: "loose.txt", origPath: null, indexStatus: null, worktreeStatus: null },
    ]);
    expect(warnings.length).toBe(1);
  });
});

// Fixture captured verbatim from `git worktree list --porcelain` with a
// primary checkout on a branch and a second detached worktree.
const WORKTREE_LIST =
  "worktree /repo\n" +
  "HEAD 7ad81d58e8f29de4e9e74f21bddb5fc6cf046cc0\n" +
  "branch refs/heads/main\n" +
  "\n" +
  "worktree /repo-wt\n" +
  "HEAD 7ad81d58e8f29de4e9e74f21bddb5fc6cf046cc0\n" +
  "detached\n";

describe("parseWorktreeList", () => {
  it("parses a branch checkout and a detached worktree", () => {
    const { items, warnings } = parseWorktreeList(WORKTREE_LIST);
    expect(warnings).toEqual([]);
    expect(items).toEqual([
      {
        path: "/repo",
        head: "7ad81d58e8f29de4e9e74f21bddb5fc6cf046cc0",
        branch: "refs/heads/main",
        bare: false,
        detached: false,
        locked: null,
        prunable: null,
      },
      {
        path: "/repo-wt",
        head: "7ad81d58e8f29de4e9e74f21bddb5fc6cf046cc0",
        branch: null,
        bare: false,
        detached: true,
        locked: null,
        prunable: null,
      },
    ]);
  });

  it("parses locked and prunable flags with and without reasons", () => {
    const text =
      "worktree /repo-locked\n" +
      "HEAD abc123\n" +
      "branch refs/heads/feature\n" +
      "locked reason text\n" +
      "prunable\n";
    const { items } = parseWorktreeList(text);
    expect(items[0].locked).toBe("reason text");
    expect(items[0].prunable).toBe("");
  });

  it("returns [] for empty input", () => {
    expect(parseWorktreeList("")).toEqual({ items: [], warnings: [] });
  });
});
