// KödPR review store (M12c/M12d): Zustand vanilla factory with injected deps —
// the same shape as the harness store (src/store/harness.ts). Drives the free
// working-tree review slice: a numstat-first file list (`diff --numstat -z`)
// with lazy per-file diffs (`diff --no-color -- <path>`) loaded only when a row
// is expanded. All parsing lives in src/review/parse.ts; this store only runs
// the allowlisted GitIpc shapes and holds the resulting state for ReviewPane.
//
// M12d (Pro) adds the "branch" scope: the diff range becomes
// `<merge-base sha>...HEAD`, resolved once per load via the allowlisted
// rev-parse/merge-base shapes and threaded into `numstatArgs`/`fileDiffArgs`
// as one range token. It also adds risk-ranked ordering (via review/rank.ts,
// rendered by ReviewPane — this store just exposes the file set) and
// per-file reviewed checkmarks, persisted through the injected `reviewChecks`
// dep (the app document owns the actual storage; see store/projects.ts).
// M12e ("pr" via gh) is the next widening.

import { createStore } from "zustand/vanilla";
import type { ChatReviewTarget } from "../chat/model";
import type { FsChangedEvent, GitIpc, GithubIpc, Unlisten } from "../ipc/contract";
import { parseNumstat, parseUnifiedDiff } from "../review/parse";
import { type FileDiff, type ReviewComment, filePath } from "../review/model";
import { compileFixPrompt } from "../review/prompt";
import { type GithubItem, parseGithubList } from "../github/parse";
import { type PrChecksSummary, type PrView, parsePrChecks, parsePrView } from "./review-gh";

// M12d widened the scope union with a "branch" variant (Pro); M12e adds "pr":
// a GitHub PR reviewed in-app via `gh`, keyed by PR number. Unlike branch/
// worktree (a live git range), PR scope loads the whole `gh pr diff` output
// eagerly, so every file's diff is present without a per-file fetch.
export type ReviewScope =
  | { kind: "worktree" }
  | { kind: "branch"; base: string | null }
  | { kind: "pr"; number: number; title?: string };

// The open-PR picker rows (Pro, M12e): the existing `gh pr list --json` shape,
// reused verbatim so one parser serves both KödPR and the GitHub pane.
export type PrListItem = GithubItem;

// A stored line comment: the pure ReviewComment plus a local id so the UI can
// edit/delete a specific one. Session-local only — never persisted to the app
// document and never sent to GitHub (the plan's read-only handoff model). The
// id is assignable-away when handed to compileFixPrompt (which takes plain
// ReviewComment[]).
export type ReviewCommentEntry = ReviewComment & { id: string };

// The narrow write sink send-to-agent needs: text into one live session's PTY.
// Real impl is the terminal SessionRegistry (registry.write). Kept minimal so
// tests inject a recorder without the whole registry surface, and so this store
// never imports src/terminal directly.
export type TerminalWriter = { write(sessionId: string, data: string): Promise<void> | void };

// Default-branch candidates tried in order when a branch scope's `base` is
// null — first one that verifies wins. Simple and documented, not
// configurable in v1; pass an explicit base to review against something else.
const DEFAULT_BRANCH_CANDIDATES = ["origin/main", "main", "origin/master", "master"];

// Per-file diff load lifecycle. "binary"/"tooLarge" are terminal stat-only
// states — the pane renders them as a stat row, never mounting an editor.
export type FileDiffStatus =
  | "idle"
  | "loading"
  | "loaded"
  | "error"
  | "binary"
  | "tooLarge";

// One changed file: the numstat-derived summary plus its lazily-loaded diff.
export type ReviewFile = {
  path: string; // display path (new path; old path for pure deletes)
  oldPath: string | null; // set for renames/copies
  adds: number | null; // null for binary files ("-\t-")
  dels: number | null;
  binary: boolean;
  renamed: boolean;
  expanded: boolean;
  diff: FileDiff | null; // the parsed per-file diff, once expanded+loaded
  diffStatus: FileDiffStatus;
  diffError: string | null;
  diffBytes: number | null; // raw diff size, for the "tooLarge" stat row
  untracked?: boolean;
};

export type ReviewTotals = { files: number; adds: number; dels: number };

export type ReviewState = {
  scope: ReviewScope;
  projectRoot: string | null;
  chatTarget: ChatReviewTarget | null;
  chatTargetChoices: ChatReviewTarget[];
  files: ReviewFile[];
  totals: ReviewTotals;
  loading: boolean; // the numstat list load is in flight
  loaded: boolean; // a list load has completed at least once for projectRoot
  // Inline message for git-missing / not-a-repo / branch-not-found — surfaced,
  // never thrown.
  error: string | null;
  warnings: string[]; // non-fatal parser warnings from the numstat parse

  // Branch scope's resolved identity (null in worktree scope, or before a
  // branch load has resolved them). `branchBase` is the base ref NAME used
  // (e.g. "main"), not the merge-base sha — the header and the reviewed-
  // checkmarks scope key both want the stable name, not a commit that moves.
  branchBase: string | null;
  headBranch: string | null; // the currently checked-out branch's name

  // Reviewed-file checkmarks for the CURRENT (projectRoot, scope) identity
  // only — reloaded from `reviewChecks` whenever load() resolves a new one.
  reviewed: Record<string, true>;

  // --- PR scope (Pro, M12e) ---
  // Open-PR picker rows, populated by loadPrList(); empty until first loaded.
  prList: PrListItem[];
  prListLoading: boolean;
  // The active PR's header data (title/state/url) and CI summary, for pr scope.
  // Both null outside pr scope or before the header loads (the diff renders
  // regardless — the header is best-effort).
  prView: PrView | null;
  prChecks: PrChecksSummary | null;

  // Line comments for the CURRENT scope (session-local; never persisted, never
  // sent to GitHub). Swapped per scope like `reviewed`, but held in memory only.
  comments: ReviewCommentEntry[];

  // Fetch the open-PR list for the picker (Pro). gh errors land in `error`.
  loadPrList(): Promise<void>;
  // Add a line comment to the current scope. Returns the new entry's id.
  addComment(input: ReviewComment): string;
  // Replace one comment's body (no-op if the id is gone).
  updateComment(id: string, body: string): void;
  // Remove one comment by id.
  deleteComment(id: string): void;
  // Compile the current scope's comments (with their diff excerpts) into one
  // fix prompt and paste it into `sessionId`'s PTY — bracketed-paste framed,
  // no trailing newline, so it lands typed-but-unsent. Rejects if no terminal
  // writer is wired or the session write fails (the pane surfaces it inline).
  sendToSession(sessionId: string): Promise<void>;

  // Build the file list for `projectRoot` (numstat-first). Replaces any prior
  // project's state. Errors (git missing, not a repo, branch not found) land
  // in `error`.
  load(projectRoot: string): Promise<void>;
  // Re-run the current projectRoot's list load (fs-watch / tab activation).
  // No-op when nothing has been loaded yet.
  refresh(): Promise<void>;
  // Deliberately open the requested project's working-tree review. Unlike
  // setScope(), this never reloads the previously selected project's root.
  openWorktree(projectRoot: string): Promise<void>;
  openChatReview(target: ChatReviewTarget): Promise<void>;
  selectChatTarget(target: ChatReviewTarget): Promise<void>;
  associateChatPullRequest(number: number): void;
  // Switch scope (worktree <-> branch) and reload the current project under it.
  setScope(scope: ReviewScope): Promise<void>;
  // Expand/collapse a row. On first expand of a non-binary file, lazily loads
  // its per-file diff; binary/oversized files flip straight to a stat state.
  toggleFile(path: string): Promise<void>;
  // Flip one file's reviewed checkmark and persist the current scope's set.
  toggleReviewed(path: string): void;
  // Mark every currently-loaded file reviewed (the wireframe's "mark all read").
  markAllRead(): void;
  // Subscribe to fs-watch batches and refresh (debounced), exactly the seam
  // filesStore.startWatchingChanges uses. Returns an unlisten for cleanup.
  watchFsChanges(): Promise<Unlisten>;
  // Clear all state (no active project / project removed).
  reset(): void;
};

// The reviewed-checkmarks persistence seam (Pro, M12d). The app document owns
// the actual storage (store/projects.ts's `reviewChecks` field); this store
// never touches disk directly, matching the onTabsChanged-style callback seam
// filesStore/appStore already use for per-project persisted state.
export type ReviewChecksDeps = {
  // Previously reviewed paths for (projectRoot, scopeKey); [] if none saved.
  load(projectRoot: string, scopeKey: string): string[];
  save(projectRoot: string, scopeKey: string, paths: string[]): void;
};

export type ReviewDeps = {
  git: GitIpc;
  // Constrained `gh` access for PR scope (Pro, M12e). Optional so worktree/
  // branch tests need not wire it; PR scope surfaces an inline error if absent.
  github?: GithubIpc;
  // Write sink for send-to-agent (Pro, M12e): compiled fix prompt → a live
  // session's PTY. Optional for the same reason; absent = the action errors.
  terminal?: TerminalWriter;
  // A read-only fs-watch subscription (FilesIpc.onChanged's shape). Kept narrow
  // so tests can inject a mock without the whole FilesIpc surface.
  watch: { onChanged(handler: (e: FsChangedEvent) => void): Promise<Unlisten> };
  // Per-file diff cap: a diff whose raw bytes exceed this renders stat-only
  // rather than parsing/mounting an editor (the plan's ~500 KiB guard).
  maxDiffBytes?: number;
  // fs-watch refresh debounce; injectable so tests can drive it fast.
  debounceMs?: number;
  // Reviewed-checkmarks persistence (Pro). Absent = in-memory only (tests that
  // don't care about persistence), same convention as other optional deps here.
  reviewChecks?: ReviewChecksDeps;
  onChatTargetSelected?(target: ChatReviewTarget): void;
};

const DEFAULT_MAX_DIFF_BYTES = 500 * 1024;
const DEFAULT_DEBOUNCE_MS = 200;

// The reviewed-checkmarks scope key: stable across new commits on the same
// branch (keyed on the base ref's NAME and the checked-out branch's name, not
// the merge-base sha), and just "worktree" for the free scope.
function reviewScopeKey(scope: ReviewScope, headBranch: string | null, branchBase: string | null): string {
  if (scope.kind === "worktree") return "worktree";
  if (scope.kind === "pr") return `pr:${scope.number}`;
  return `branch:${headBranch ?? "HEAD"}:${branchBase ?? scope.base ?? "auto"}`;
}

// Bracketed-paste framing (DEC ?2004): the same convention a terminal emulator
// wraps a real paste in, so an agent CLI in raw mode inserts the multi-line fix
// prompt as literal text WITHOUT submitting on the embedded newlines. No
// trailing newline is added — the prompt lands typed-but-unsent, exactly like a
// user paste (src/terminal has no exported paste-framing helper, so this is
// re-derived minimally here per the M12e edit-boundary note).
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
function framePaste(text: string): string {
  // Untrusted bytes (PR diffs) must not carry control characters into the
  // PTY: stripping C0 (incl. \x1b) except \n/\t makes an interior paste-end
  // sequence unrepresentable, and dropping \r keeps CRLF diffs from
  // submitting the prompt.
  const safe = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return `${PASTE_START}${safe}${PASTE_END}`;
}

// gh argv shapes (must match the Rust allowlist exactly). `pr diff` drives the
// PR file list; `pr view`/`pr checks` fill the header. `pr list` feeds the
// picker. The number is stringified digits — the allowlist rejects anything else.
function prDiffArgs(n: number): string[] {
  return ["pr", "diff", String(n)];
}
function prViewArgs(n: number): string[] {
  return ["pr", "view", String(n), "--json", "number,title,author,state,url,statusCheckRollup"];
}
const CURRENT_PR_VIEW_ARGS = [
  "pr",
  "view",
  "--json",
  "number,title,author,state,url,statusCheckRollup",
];

function parsePullRequestNumber(raw: string): number | null {
  try {
    const value = JSON.parse(raw) as { number?: unknown };
    return typeof value.number === "number" && Number.isSafeInteger(value.number) && value.number > 0
      ? value.number
      : null;
  } catch {
    return null;
  }
}
function prChecksArgs(n: number): string[] {
  return ["pr", "checks", String(n)];
}
const PR_LIST_ARGS = ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,author,labels,updatedAt"];

// Resolve a branch scope's diff range: verify (or auto-detect) the base ref,
// merge-base it against HEAD, and read the checked-out branch's name for the
// header. Returns a range token ("<sha>...HEAD") plus the display names — a
// base equal to HEAD merge-bases to HEAD itself, giving an empty (not
// erroring) range, which the normal empty-numstat path already renders as
// "no changes".
async function resolveBranchRange(
  git: GitIpc,
  projectRoot: string,
  explicitBase: string | null,
): Promise<
  { ok: true; range: string; baseName: string; headBranch: string } | { ok: false; error: string }
> {
  let baseName = explicitBase;
  if (baseName) {
    try {
      await git.run(projectRoot, ["rev-parse", "--verify", baseName]);
    } catch {
      return { ok: false, error: `base branch "${baseName}" not found` };
    }
  } else {
    for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
      try {
        await git.run(projectRoot, ["rev-parse", "--verify", candidate]);
        baseName = candidate;
        break;
      } catch {
        // try the next candidate
      }
    }
    if (!baseName) {
      return {
        ok: false,
        error: "couldn't detect a default branch (tried origin/main, main, origin/master, master)",
      };
    }
  }
  let mergeBase: { stdout: string };
  try {
    mergeBase = await git.run(projectRoot, ["merge-base", baseName, "HEAD"]);
  } catch {
    return { ok: false, error: `no common ancestor with "${baseName}"` };
  }
  const sha = mergeBase.stdout.trim();
  const head = await git.run(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { ok: true, range: `${sha}...HEAD`, baseName, headBranch: head.stdout.trim() };
}

// Allowlisted git argv for a scope's numstat. Worktree = the plain working-tree
// diff (`diff --numstat -z`); branch prepends the resolved "<base>...HEAD" range.
function numstatArgs(scope: ReviewScope, range: string | null): string[] {
  if (scope.kind === "branch" && range) return ["diff", "--numstat", "-z", range];
  // HEAD includes staged and unstaged tracked content in one pass, avoiding a
  // duplicate row when a path has both kinds of edits.
  return ["diff", "--numstat", "-z", "HEAD"];
}

// Allowlisted git argv for one file's diff under a scope. Worktree = the plain
// working-tree per-file diff; branch inserts the resolved "<base>...HEAD" range.
function fileDiffArgs(scope: ReviewScope, range: string | null, path: string): string[] {
  if (scope.kind === "branch" && range) return ["diff", "--no-color", range, "--", path];
  return ["diff", "--no-color", "HEAD", "--", path];
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function toReviewFile(entry: {
  oldPath: string | null;
  newPath: string;
  adds: number | null;
  dels: number | null;
  binary: boolean;
  renamed: boolean;
}): ReviewFile {
  return {
    path: entry.newPath,
    oldPath: entry.oldPath,
    adds: entry.adds,
    dels: entry.dels,
    binary: entry.binary,
    renamed: entry.renamed,
    expanded: false,
    diff: null,
    diffStatus: "idle",
    diffError: null,
    diffBytes: null,
  };
}

// Build a ReviewFile from an already-parsed FileDiff (PR scope: the whole diff
// is loaded up front, so the per-file diff is present eagerly and needs no
// lazy fetch — toggleFile just flips `expanded` since diffStatus is "loaded").
function toReviewFileFromDiff(diff: FileDiff): ReviewFile {
  const path = filePath(diff);
  return {
    path,
    oldPath: diff.status === "renamed" ? diff.oldPath : null,
    adds: diff.binary ? null : diff.adds,
    dels: diff.binary ? null : diff.dels,
    binary: diff.binary,
    renamed: diff.status === "renamed",
    expanded: false,
    diff: diff.binary ? null : diff,
    diffStatus: diff.binary ? "binary" : "loaded",
    diffError: null,
    diffBytes: null,
  };
}

function totalsOf(files: ReviewFile[]): ReviewTotals {
  let adds = 0;
  let dels = 0;
  for (const f of files) {
    adds += f.adds ?? 0;
    dels += f.dels ?? 0;
  }
  return { files: files.length, adds, dels };
}

function worktreeRoots(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter(Boolean);
}

function untrackedPaths(porcelain: string): string[] {
  return porcelain
    .split("\0")
    .filter((record) => record.startsWith("? "))
    .map((record) => record.slice(2))
    .filter((path) => path.length > 0);
}

function isSafeRelativePath(path: string): boolean {
  return !path.startsWith("/") && !path.startsWith("\\") && !path.startsWith(":") &&
    !path.split(/[\\/]/).includes("..");
}

export function createReviewStore(deps: ReviewDeps) {
  const maxDiffBytes = deps.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  // Monotonic generation guard (the github/harness stores' pattern): a slower
  // stale list load can never clobber a newer one's result.
  let generation = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // The current branch scope's resolved "<sha>...HEAD" range, kept out of
  // public state (it's an implementation detail of the argv helpers, not
  // something the pane renders — the pane shows branchBase/headBranch
  // instead). null in worktree scope or before a branch load resolves it.
  let currentRange: string | null = null;
  // Session-local comment stash keyed by scope key, so switching scope and back
  // preserves each scope's comments (they never touch disk). `comments` in
  // public state always mirrors the current scope's stash entry.
  const commentStash = new Map<string, ReviewCommentEntry[]>();
  let commentSeq = 0;

  return createStore<ReviewState>((set, get) => {
    // The current scope's comment-stash key (mirrors reviewScopeKey's identity).
    const commentKey = () => reviewScopeKey(get().scope, get().headBranch, get().branchBase);
    // Swap `comments` to a scope's stashed list (called after load resolves the
    // scope identity, same seam `reviewed` uses).
    const loadComments = () => set({ comments: commentStash.get(commentKey()) ?? [] });

    const discoverPullRequest = async (
      target: ChatReviewTarget,
    ): Promise<ChatReviewTarget> => {
      if (target.pullRequest || !deps.github) return target;
      const root = target.selectedWorktreeRoot ?? target.executionRoot;
      try {
        const out = await deps.github.run(root, CURRENT_PR_VIEW_ARGS);
        const number = parsePullRequestNumber(out.stdout);
        return number ? { ...target, pullRequest: number } : target;
      } catch {
        // Local chat work commonly exists before its PR. Discovery is
        // best-effort and cannot turn a valid working-tree review into an error.
        return target;
      }
    };
    // Write the current scope's comment list to both state and the stash.
    const setComments = (next: ReviewCommentEntry[]) => {
      commentStash.set(commentKey(), next);
      set({ comments: next });
    };

    // Merge a partial update into one file row by path (immutable array swap).
    const patchFile = (path: string, patch: Partial<ReviewFile>) => {
      set((s) => ({
        files: s.files.map((f) => (f.path === path ? { ...f, ...patch } : f)),
      }));
    };

    // Persist the current scope's reviewed-path set (no-op without the dep).
    const persistReviewed = () => {
      const s = get();
      if (!s.projectRoot || !deps.reviewChecks) return;
      const key = reviewScopeKey(s.scope, s.headBranch, s.branchBase);
      deps.reviewChecks.save(s.projectRoot, key, Object.keys(s.reviewed));
    };

    // Load and parse one file's diff, honoring the size cap. Guards against a
    // stale result (project switched, or the row was collapsed) before applying.
    const loadFileDiff = async (path: string) => {
      const gen = generation;
      const root = get().projectRoot;
      const scope = get().scope;
      if (!root) return;
      patchFile(path, { diffStatus: "loading", diffError: null });
      try {
        const out = await deps.git.run(root, fileDiffArgs(scope, currentRange, path));
        // Stale if a newer load superseded this one (scope/project switch), the
        // project changed, or the row collapsed while we awaited.
        if (gen !== generation || get().projectRoot !== root) return;
        const current = get().files.find((f) => f.path === path);
        if (!current || !current.expanded) return;
        const bytes = byteLength(out.stdout);
        if (bytes > maxDiffBytes) {
          patchFile(path, { diffStatus: "tooLarge", diffBytes: bytes, diff: null });
          return;
        }
        const parsed = parseUnifiedDiff(out.stdout);
        const diff =
          parsed.items.find((f) => filePath(f) === path) ?? parsed.items[0] ?? null;
        if (!diff) {
          // No diff section (e.g. the file changed back before we read it).
          patchFile(path, { diffStatus: "loaded", diff: null, diffBytes: bytes });
          return;
        }
        if (diff.binary) {
          patchFile(path, { diffStatus: "binary", diff: null, diffBytes: bytes });
          return;
        }
        patchFile(path, { diffStatus: "loaded", diff, diffBytes: bytes });
      } catch (error) {
        if (gen !== generation || get().projectRoot !== root) return;
        patchFile(path, {
          diffStatus: "error",
          diffError: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Load a PR's header (title/state/url + CI summary) best-effort — a header
    // failure never breaks the already-rendered diff. `pr checks` exits non-zero
    // when checks are failing, so its rejection falls back to the rollup summary
    // parsed from `pr view`.
    const loadPrHeader = async (root: string, n: number, gen: number) => {
      if (!deps.github) return;
      try {
        const viewOut = await deps.github.run(root, prViewArgs(n));
        if (gen !== generation) return;
        set({ prView: parsePrView(viewOut.stdout) });
      } catch {
        // header is best-effort
      }
      try {
        const checksOut = await deps.github.run(root, prChecksArgs(n));
        if (gen !== generation) return;
        set({ prChecks: parsePrChecks(checksOut.stdout) });
      } catch {
        if (gen === generation) set((s) => ({ prChecks: s.prView?.checks ?? s.prChecks }));
      }
    };

    // The PR-scope list load: one `gh pr diff` gives the whole diff, parsed into
    // eager per-file diffs (no lazy fetch). The header loads in the background.
    const loadPr = async (projectRoot: string, scope: Extract<ReviewScope, { kind: "pr" }>, gen: number) => {
      if (!deps.github) {
        set({ loading: false, error: "gh is required for PR review" });
        return;
      }
      currentRange = null;
      const diffOut = await deps.github.run(projectRoot, prDiffArgs(scope.number));
      if (gen !== generation) return;
      const parsed = parseUnifiedDiff(diffOut.stdout);
      const prev = new Map(get().files.map((f) => [f.path, f]));
      const files = parsed.items.map((d) => {
        const next = toReviewFileFromDiff(d);
        const old = prev.get(next.path);
        return old?.expanded ? { ...next, expanded: true } : next;
      });
      const key = reviewScopeKey(scope, null, null);
      const reviewedPaths = deps.reviewChecks?.load(projectRoot, key) ?? [];
      set({
        files,
        totals: totalsOf(files),
        warnings: parsed.warnings,
        loading: false,
        loaded: true,
        branchBase: null,
        headBranch: null,
        prView: null,
        prChecks: null,
        reviewed: Object.fromEntries(reviewedPaths.map((p) => [p, true])),
      });
      loadComments();
      void loadPrHeader(projectRoot, scope.number, gen);
    };

    return {
      scope: { kind: "worktree" },
      projectRoot: null,
      chatTarget: null,
      chatTargetChoices: [],
      files: [],
      totals: { files: 0, adds: 0, dels: 0 },
      loading: false,
      loaded: false,
      error: null,
      warnings: [],
      branchBase: null,
      headBranch: null,
      reviewed: {},
      prList: [],
      prListLoading: false,
      prView: null,
      prChecks: null,
      comments: [],

      async load(projectRoot) {
        const gen = ++generation;
        const scope = get().scope;
        // A different project resets the list; the same project keeps the old
        // rows visible while refreshing (no flash to empty).
        const sameProject = get().projectRoot === projectRoot;
        set({
          projectRoot,
          loading: true,
          error: null,
          ...(sameProject ? {} : { files: [], totals: { files: 0, adds: 0, dels: 0 }, loaded: false }),
        });
        try {
          if (scope.kind === "pr") {
            await loadPr(projectRoot, scope, gen);
            return;
          }
          let branchBase: string | null = null;
          let headBranch: string | null = null;
          if (scope.kind === "branch") {
            const resolved = await resolveBranchRange(deps.git, projectRoot, scope.base);
            if (gen !== generation) return;
            if (!resolved.ok) {
              currentRange = null;
              set({ loading: false, error: resolved.error, branchBase: null, headBranch: null });
              return;
            }
            currentRange = resolved.range;
            branchBase = resolved.baseName;
            headBranch = resolved.headBranch;
          } else {
            currentRange = null;
          }
          const out = await deps.git.run(projectRoot, numstatArgs(scope, currentRange));
          if (gen !== generation) return; // superseded by a newer load
          const parsed = parseNumstat(out.stdout);
          const extraWarnings: string[] = [];
          const untracked: ReviewFile[] = [];
          if (scope.kind === "worktree") {
            const status = await deps.git.run(projectRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
            if (gen !== generation || get().projectRoot !== projectRoot) return;
            for (const path of untrackedPaths(status.stdout)) {
              if (!isSafeRelativePath(path)) {
                extraWarnings.push(`ignored unsafe untracked path: ${JSON.stringify(path)}`);
                continue;
              }
              const diff = await deps.git.run(projectRoot, ["diff", "--no-index", "--no-color", "--", "/dev/null", path]);
              if (gen !== generation || get().projectRoot !== projectRoot) return;
              const parsedDiff = parseUnifiedDiff(diff.stdout).items[0];
              if (!parsedDiff) {
                extraWarnings.push(`could not read untracked file: ${JSON.stringify(path)}`);
                continue;
              }
              untracked.push({ ...toReviewFileFromDiff(parsedDiff), path, untracked: true });
            }
          }
          // Preserve expanded/loaded diff state across a refresh for files that
          // are still present, so an fs-watch tick doesn't collapse open rows.
          const prev = new Map(get().files.map((f) => [f.path, f]));
          const files = [...parsed.items.map((entry) => {
            const next = toReviewFile(entry);
            const old = prev.get(next.path);
            if (old?.expanded) {
              // Re-expand; drop the stale diff so toggle-driven reload refetches.
              return { ...next, expanded: true, diffStatus: "idle" as FileDiffStatus };
            }
            return next;
          }), ...untracked];
          // Reviewed checkmarks belong to this exact (projectRoot, scope)
          // identity — reload them fresh rather than carrying stale entries
          // over from whatever scope was active before.
          const key = reviewScopeKey(scope, headBranch, branchBase);
          const reviewedPaths = deps.reviewChecks?.load(projectRoot, key) ?? [];
          set({
            files,
            totals: totalsOf(files),
            warnings: [...parsed.warnings, ...extraWarnings],
            loading: false,
            loaded: true,
            branchBase,
            headBranch,
            prView: null,
            prChecks: null,
            reviewed: Object.fromEntries(reviewedPaths.map((p) => [p, true])),
          });
          loadComments();
          // Re-fetch diffs for rows that were left expanded across the refresh.
          for (const f of files) {
            if (f.expanded) void loadFileDiff(f.path);
          }
        } catch (error) {
          if (gen !== generation) return;
          set({
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },

      async refresh() {
        const root = get().projectRoot;
        if (!root) return;
        await get().load(root);
      },

      async openWorktree(projectRoot) {
        set({
          scope: { kind: "worktree" },
          branchBase: null,
          headBranch: null,
          error: null,
          chatTarget: null,
          chatTargetChoices: [],
        });
        await get().load(projectRoot);
      },

      async openChatReview(target) {
        let choices = [target];
        try {
          const out = await deps.git.run(target.executionRoot, ["worktree", "list", "--porcelain"]);
          const roots = worktreeRoots(out.stdout).filter((root) => root !== target.executionRoot);
          choices = [target, ...roots.map((root) => ({
            ...target,
            selectedWorktreeRoot: root,
            sharedCheckout: false,
          }))];
        } catch {
          // The subsequent load surfaces the actual Git error inline.
        }
        const selected = await discoverPullRequest(target);
        set({
          scope: { kind: "worktree" },
          projectRoot: selected.selectedWorktreeRoot ?? selected.executionRoot,
          branchBase: null,
          headBranch: null,
          error: null,
          chatTarget: selected,
          chatTargetChoices: choices.length > 1 ? choices : [],
        });
        deps.onChatTargetSelected?.(selected);
        await get().load(selected.selectedWorktreeRoot ?? selected.executionRoot);
      },

      async selectChatTarget(target) {
        const selected = await discoverPullRequest(target);
        set({ chatTarget: selected, chatTargetChoices: [], scope: { kind: "worktree" } });
        deps.onChatTargetSelected?.(selected);
        await get().load(selected.selectedWorktreeRoot ?? selected.executionRoot);
      },

      associateChatPullRequest(number) {
        const target = get().chatTarget;
        if (!target || !Number.isSafeInteger(number) || number < 1) return;
        const next = { ...target, pullRequest: number };
        set({ chatTarget: next });
        deps.onChatTargetSelected?.(next);
      },

      async setScope(scope) {
        if (scope.kind === "branch" && get().chatTarget?.baselineSha) {
          scope = { kind: "branch", base: get().chatTarget!.baselineSha };
        }
        set({ scope, branchBase: null, headBranch: null, error: null });
        const root = get().projectRoot;
        if (root) await get().load(root);
      },

      async toggleFile(path) {
        const file = get().files.find((f) => f.path === path);
        if (!file) return;
        if (file.expanded) {
          patchFile(path, { expanded: false });
          return;
        }
        patchFile(path, { expanded: true });
        // Binary rows never mount an editor — flip straight to a stat state.
        if (file.binary) {
          patchFile(path, { diffStatus: "binary" });
          return;
        }
        // Load once; a subsequent re-expand keeps the cached diff.
        if (file.diffStatus === "idle" || file.diffStatus === "error") {
          await loadFileDiff(path);
        }
      },

      toggleReviewed(path) {
        set((s) => {
          const reviewed = { ...s.reviewed };
          if (reviewed[path]) delete reviewed[path];
          else reviewed[path] = true;
          return { reviewed };
        });
        persistReviewed();
      },

      markAllRead() {
        set((s) => ({ reviewed: Object.fromEntries(s.files.map((f) => [f.path, true as const])) }));
        persistReviewed();
      },

      async loadPrList() {
        const root = get().projectRoot;
        if (!root) return;
        if (!deps.github) {
          set({ error: "gh is required for PR review" });
          return;
        }
        set({ prListLoading: true });
        try {
          const out = await deps.github.run(root, PR_LIST_ARGS);
          if (get().projectRoot !== root) return;
          set({ prList: parseGithubList(out.stdout), prListLoading: false, error: null });
        } catch (error) {
          if (get().projectRoot !== root) return;
          set({
            prListLoading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },

      addComment(input) {
        const id = `c${++commentSeq}`;
        setComments([...get().comments, { ...input, id }]);
        return id;
      },

      updateComment(id, body) {
        setComments(get().comments.map((c) => (c.id === id ? { ...c, body } : c)));
      },

      deleteComment(id) {
        setComments(get().comments.filter((c) => c.id !== id));
      },

      async sendToSession(sessionId) {
        if (!deps.terminal) throw new Error("no terminal session to send to");
        const s = get();
        const files = s.files
          .map((f) => f.diff)
          .filter((d): d is FileDiff => d != null);
        const prompt = compileFixPrompt(s.comments, files);
        await deps.terminal.write(sessionId, framePaste(prompt));
      },

      watchFsChanges() {
        return deps.watch.onChanged(() => {
          if (!get().projectRoot) return;
          // A PR is a remote snapshot — local fs churn never changes it, so skip
          // the debounced refresh (it would re-run `gh pr diff` on every save).
          if (get().scope.kind === "pr") return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void get().refresh();
          }, debounceMs);
        });
      },

      reset() {
        generation++; // orphan any in-flight load
        currentRange = null;
        commentStash.clear();
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        set({
          projectRoot: null,
          chatTarget: null,
          chatTargetChoices: [],
          files: [],
          totals: { files: 0, adds: 0, dels: 0 },
          loading: false,
          loaded: false,
          error: null,
          warnings: [],
          branchBase: null,
          headBranch: null,
          reviewed: {},
          prList: [],
          prListLoading: false,
          prView: null,
          prChecks: null,
          comments: [],
        });
      },
    };
  });
}
