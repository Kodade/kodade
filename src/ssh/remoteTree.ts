// KödSSH remote file tree (M11d): parses the newline-separated output of the
// portable `find` probe (built by buildRemoteListArgv in src/ssh/command.ts)
// into a nested tree. Pure/leaf module — no IPC — so it's unit-testable against fixture
// strings, mirroring src/ssh/config.ts's role for the host-list parser.
//
// Remote paths are always POSIX ('/'-separated) regardless of the local OS,
// so this file does its own splitting rather than reusing src/platform/native-path
// (which follows the LOCAL platform's separator convention).

export type RemoteEntryType = "dir" | "file";

export type RemoteTreeNode = {
  name: string;
  path: string; // absolute remote path
  type: RemoteEntryType;
  children?: RemoteTreeNode[]; // present (possibly empty) only for dirs
};

export type RemoteListing = {
  root: string;
  nodes: RemoteTreeNode[]; // top-level entries directly under root (root itself excluded)
  truncated: boolean; // true when the entry cap or the ssh_exec output cap was hit
};

// Matches one probe line: a single-letter type marker, a colon, then the
// absolute remote path. D = directory, F = regular file, L = symlink (treated
// as a file for preview purposes — see src/store/remoteFiles.ts).
const LINE_RE = /^([DFL]):(.+)$/;

// Turn the raw stdout of the find probe into a nested tree rooted at `root`.
// `entryCap` bounds how many lines are consumed; the probe itself requests
// entryCap+1 lines so a line count over the cap flips `truncated` — same
// n+1 trick used elsewhere for cheap truncation detection without a second
// round trip.
//
// KNOWN LIMITATION: this protocol is line-based (one entry per `\n`), so a
// remote filename containing a literal newline byte cannot be represented —
// it splits into two lines that each fail LINE_RE (or resolve to a bogus
// path) and are dropped defensively. There is no portable NUL-delimited
// alternative (`find -print0` is a GNU/BSD extension, not universal), so this
// is an accepted v1 gap, not a bug: such files simply don't appear in the
// tree rather than corrupting it.
export function parseRemoteFind(root: string, stdout: string, entryCap: number): RemoteListing {
  const rawLines = stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
  const truncated = rawLines.length > entryCap;
  const lines = rawLines.slice(0, entryCap);

  const byPath = new Map<string, RemoteTreeNode>();
  const order: string[] = [];
  const normalizedRoot = stripTrailingSlash(root);

  for (const line of lines) {
    const match = LINE_RE.exec(line);
    if (!match) continue; // malformed/foreign line — drop rather than guess
    const [, marker, rawPath] = match;
    let path = stripTrailingSlash(rawPath);
    // The probe cds into the root and runs `find .`, so entries arrive as
    // `./`-relative paths — rejoin them to the literal pinned root here.
    // This is what makes a `~/…` root work: the remote expands `"$HOME"` in
    // ways this side can't predict, so entries are matched to the root by
    // construction, not by prefix-comparing find's expanded output.
    // Absolute entries (the pre-cd probe shape) still take the old
    // prefix-checked path below.
    if (path === ".") continue; // the root entry itself
    if (path.startsWith("./")) {
      path = normalizedRoot === "/" ? `/${path.slice(2)}` : `${normalizedRoot}/${path.slice(2)}`;
    }
    if (path === "" || path === normalizedRoot) continue; // the root entry itself
    if (!isUnderRemoteRoot(path, normalizedRoot)) continue; // defensive: outside the probed tree
    if (byPath.has(path)) continue; // defensive dedupe (shouldn't happen)
    const type: RemoteEntryType = marker === "D" ? "dir" : "file";
    byPath.set(path, {
      name: remoteBasename(path),
      path,
      type,
      children: type === "dir" ? [] : undefined,
    });
    order.push(path);
  }

  // Attach each node to its parent when the parent was also captured (nesting
  // discovery order is find's own order, which lists a dir before its
  // contents, so parents always exist in byPath before their children need
  // them — but we don't rely on that; a missing/pruned/beyond-cap parent just
  // falls back to top-level so nothing is silently dropped).
  const topLevel: RemoteTreeNode[] = [];
  for (const path of order) {
    const node = byPath.get(path)!;
    const parentPath = remoteDirname(path);
    const parent = parentPath !== normalizedRoot ? byPath.get(parentPath) : undefined;
    if (parent && parent.type === "dir") {
      parent.children!.push(node);
    } else {
      topLevel.push(node);
    }
  }

  sortTree(topLevel);
  return { root: normalizedRoot, nodes: topLevel, truncated };
}

// Dirs first, then alphabetical — the conventional file-tree order (matches
// FileTreePane's local tree). Recurses into every dir's children.
function sortTree(nodes: RemoteTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children) sortTree(node.children);
  }
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function isUnderRemoteRoot(path: string, root: string): boolean {
  // Root "/" must not double the slash: `startsWith("//")` would reject every
  // entry and render a target pinned at / as an empty directory. (The path
  // never equals root here — the caller filters that case first.)
  const prefix = root === "/" ? "/" : `${root}/`;
  return path.startsWith(prefix);
}

// Exported for reuse by the preview pane (src/components/RemotePreviewPane.tsx),
// which needs a bare filename for language detection without pulling in a
// local-platform path splitter that could disagree with POSIX '/' semantics.
export function remoteBasename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function remoteDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}
