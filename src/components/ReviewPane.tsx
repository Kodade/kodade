import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { appStore, reviewStore as defaultReviewStore } from "../store/appStore";
import type { PrListItem, ReviewCommentEntry, ReviewFile, ReviewScope, ReviewState } from "../store/review";
import { sessionDisplayName } from "../store/projects";
import { rankFiles } from "../review/rank";
import type { NumstatEntry, RankedFile, RiskBucket } from "../review/model";
import { entitlements as defaultEntitlements, type Entitlements } from "../app/entitlements";
import type { PrChecksSummary, PrView } from "../store/review-gh";
import { DiffView, type DiffCommenting, type DiffViewMode } from "./DiffView";

// KödPR review pane (M12c free / M12d Pro). Free is the working-tree diff
// surface: a numstat-first file list with lazily-expanded, themed CodeMirror
// diffs, file order only. Pro (hasFeature("kodpr.branch")) adds: a branch
// scope pill (reviews the current branch against its merge-base), risk-ranked
// "read first / routine / trivial" grouping via review/rank.ts over
// whichever scope is loaded, and per-file reviewed checkmarks + "mark all
// read" persisted per project+scope. The honest lock footer names the
// remaining Pro surface (PR checks, send-to-agent — M12e) and hides once
// kodpr.branch is entitled, same pattern as HarnessPane's entitlement gating.

export function ReviewPane({
  store = defaultReviewStore,
  entitlements = defaultEntitlements,
}: {
  store?: StoreApi<ReviewState>;
  entitlements?: Entitlements;
}) {
  const state = useStore(store);
  const activeProject = useStore(appStore, (s) =>
    s.projects.find((project) => project.id === s.activeProjectId),
  );
  // Live sessions for the send-to-agent picker (the store's raw array is a
  // stable ref; filter per-project in render). Exited shells are excluded.
  const allSessions = useStore(appStore, (s) => s.sessions);
  const [viewMode, setViewMode] = useState<DiffViewMode>("unified");
  // Pro fills the branch scope + ranking + checkmarks; free stays the flat
  // working-tree list. Branch scope is unreachable without this (the pill is
  // hidden), so ranking effectively only ever shows for entitled sessions.
  const proEntitled = entitlements.hasFeature("kodpr.branch");
  // PR scope + comments → send-to-agent are the M12e Pro surface, gated
  // separately (hide-not-disable, like HarnessPane): the PR pill/picker and the
  // comment+send controls only render for an entitled session.
  const prEntitled = entitlements.hasFeature("kodpr.pr");

  // Load on mount / project change (this is "on tab activation": the pane only
  // mounts while the review tab is active), and subscribe to the fs-watch seam
  // for a debounced refresh. Reset when there's no project so a stale list can't
  // linger under a different one.
  useEffect(() => {
    if (!activeProject && !state.chatTarget) {
      store.getState().reset();
      return;
    }
    const root = state.chatTarget?.selectedWorktreeRoot ?? state.chatTarget?.executionRoot ?? activeProject?.path;
    if (!root) return;
    void store.getState().load(root);
    let unlisten: (() => void) | null = null;
    let stopped = false;
    void store
      .getState()
      .watchFsChanges()
      .then((off) => {
        if (stopped) off();
        else unlisten = off;
      });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [store, activeProject?.id, activeProject?.path, state.chatTarget?.executionRoot, state.chatTarget?.selectedWorktreeRoot]);

  const { files, totals, loading, loaded, error, scope, branchBase, headBranch, reviewed, comments, prView, prChecks } = state;

  // Rank whenever branch/PR scope is active, or the session is Pro (worktree
  // scope still benefits from "what to read first" once entitled). Free stays
  // the flat file-order list from M12c.
  const showRanked = scope.kind !== "worktree" || proEntitled;
  const ranked = useMemo(() => (showRanked ? rankFiles(toNumstatEntries(files)) : []), [showRanked, files]);

  // Comment counts per file path (for the row badges) and the live-session list
  // for the send-to-agent picker.
  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of comments) counts[c.path] = (counts[c.path] ?? 0) + 1;
    return counts;
  }, [comments]);
  const sessions = useMemo(
    () => allSessions.filter((s) => s.projectId === activeProject?.id && !s.exited),
    [allSessions, activeProject?.id],
  );

  // Commenting is wired into the diff whenever the send-to-agent surface is
  // entitled — comments only matter because they compile to a fix prompt.
  const commentingFor = (path: string): DiffCommenting | undefined => {
    if (!prEntitled) return undefined;
    return {
      comments: comments.filter((c) => c.path === path),
      onAdd: (startLine, endLine, body) =>
        store.getState().addComment({ path, startLine, endLine, body }),
      onUpdate: (id, body) => store.getState().updateComment(id, body),
      onDelete: (id) => store.getState().deleteComment(id),
    };
  };

  if (!activeProject && !state.chatTarget) {
    return <Centered>select a project to review its changes</Centered>;
  }

  return (
    <div className="absolute inset-0 overflow-auto bg-bg p-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-sm text-text">review · {activeProject?.name ?? "KödChat"}</h1>
            <p className="mt-1 text-xs text-text-dim">{reviewLabel(state.chatTarget) ?? subtitle(scope, headBranch, branchBase)}</p>
          </div>
          {/* Scope picker: the branch pill only renders when entitled — a
              locked feature is hidden, not shown disabled (HarnessPane's
              ScopeToggle precedent), and the footer below names it instead. */}
          <ScopePicker
            scope={scope}
            proEntitled={proEntitled}
            prEntitled={prEntitled}
            prList={state.prList}
            prListLoading={state.prListLoading}
            onSelect={(next) => void store.getState().setScope(next)}
            onOpenPrPicker={() => void store.getState().loadPrList()}
          />
        </header>

        {state.chatTargetChoices.length > 0 && (
          <div className="rounded border border-border bg-surface p-2 text-xs text-text-dim" data-chat-review-targets>
            <p>Multiple KödChat worktrees are available. Choose one to review.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {state.chatTargetChoices.map((target) => (
                <button
                  key={target.selectedWorktreeRoot ?? target.executionRoot}
                  type="button"
                  onClick={() => void store.getState().selectChatTarget(target)}
                  className="rounded border border-border px-2 py-1 hover:bg-surface-hover"
                >
                  {target.selectedWorktreeRoot ?? target.executionRoot}
                </button>
              ))}
            </div>
          </div>
        )}

        {scope.kind === "pr" && !error && (prView || prChecks) && (
          <PrHeaderStrip prView={prView} prChecks={prChecks} />
        )}

        {error && (
          <p
            role="alert"
            className="rounded border border-[color-mix(in_srgb,var(--kd-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--kd-warning)_10%,transparent)] px-3 py-2 text-xs text-[var(--kd-warning)]"
          >
            {error}
          </p>
        )}

        {!error && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-text-dim">
              {showRanked ? rankedSummaryLine(totals, ranked) : summaryLine(totals)}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {showRanked && files.length > 0 && (
                <button
                  type="button"
                  onClick={() => store.getState().markAllRead()}
                  className="rounded border border-border px-2 py-1 text-[11px] text-text-dim hover:bg-surface-hover hover:text-text"
                >
                  mark all read
                </button>
              )}
              {files.length > 0 && <ViewModeToggle mode={viewMode} onSelect={setViewMode} />}
            </div>
          </div>
        )}

        {loading && !loaded && <p className="text-xs text-text-dim">loading…</p>}

        {!error && loaded && files.length === 0 && (
          <p className="text-xs text-text-dim">
            {scope.kind === "branch"
              ? "no changes against the base branch"
              : scope.kind === "pr"
                ? "no files in this pull request"
                : "no changes in the working tree"}
          </p>
        )}

        {files.length > 0 && !showRanked && (
          <ul className="overflow-hidden rounded border border-border bg-surface">
            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                viewMode={viewMode}
                commentCount={commentCounts[file.path] ?? 0}
                commenting={commentingFor(file.path)}
                onToggle={() => void store.getState().toggleFile(file.path)}
              />
            ))}
          </ul>
        )}

        {files.length > 0 && showRanked && (
          <RankedGroups
            ranked={ranked}
            files={files}
            viewMode={viewMode}
            reviewed={reviewed}
            commentCounts={commentCounts}
            commentingFor={commentingFor}
            onToggle={(path) => void store.getState().toggleFile(path)}
            onToggleReviewed={(path) => store.getState().toggleReviewed(path)}
          />
        )}

        {prEntitled && comments.length > 0 && (
          <SendToAgent
            count={comments.length}
            sessions={sessions.map((s) => ({ id: s.id, name: sessionDisplayName(s) }))}
            onSend={(sessionId) => store.getState().sendToSession(sessionId)}
          />
        )}

        {!proEntitled && (
          <p role="status" className="rounded border border-border bg-surface px-3 py-2 text-xs text-text-dim">
            Branch review, risk ranking, PR checks, and send-to-agent are Ködade Pro.
          </p>
        )}
      </div>
    </div>
  );
}

// The header subtitle: worktree stays the free M12c copy; a resolved branch
// scope names the wireframe's "<head> vs <base>" relationship. Before
// resolution lands (or on error), a neutral "branch" placeholder shows.
function subtitle(scope: ReviewScope, headBranch: string | null, branchBase: string | null): string {
  if (scope.kind === "worktree") return "working tree · what changed before you commit";
  if (scope.kind === "pr") return scope.title ? `#${scope.number} · ${scope.title}` : `pull request #${scope.number}`;
  if (headBranch && branchBase) return `${headBranch} vs ${branchBase}`;
  return "branch · resolving base…";
}

function reviewLabel(target: import("../chat/model").ChatReviewTarget | null): string | null {
  if (!target) return null;
  if (target.selectedWorktreeRoot) return "KödChat worktree · changes owned by this chat";
  return target.sharedCheckout
    ? "KödChat shared checkout · changes owned by this chat"
    : "KödChat worktree · changes owned by this chat";
}

// The PR header strip: title/state from `pr view` and a one-line checks summary
// from `pr checks` (or the rollup fallback). Best-effort — only rendered when
// at least one loaded.
function PrHeaderStrip({
  prView,
  prChecks,
}: {
  prView: PrView | null;
  prChecks: PrChecksSummary | null;
}) {
  const checks = prChecks ?? prView?.checks ?? null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-surface px-3 py-2 text-xs" data-pr-header>
      {prView?.state && (
        <span className="rounded border border-border px-1.5 py-0.5 uppercase tracking-wide text-text-dim">
          {prView.state.toLowerCase()}
        </span>
      )}
      {checks && checks.total > 0 && (
        <span className="text-text-dim">
          checks: {checks.passed} passed
          {checks.failed > 0 && <span className="text-[var(--kd-error)]"> · {checks.failed} failed</span>}
          {checks.pending > 0 && <span> · {checks.pending} pending</span>}
        </span>
      )}
    </div>
  );
}

// The send-to-agent control (Pro, M12e): visible once the current scope has
// comments. Pick a live session and paste the compiled fix prompt into it
// (typed-but-unsent). Surfaces a write failure inline.
function SendToAgent({
  count,
  sessions,
  onSend,
}: {
  count: number;
  sessions: { id: string; name: string }[];
  onSend: (sessionId: string) => Promise<void>;
}) {
  const [sessionId, setSessionId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const selected = sessionId || sessions[0]?.id || "";

  const send = async () => {
    if (!selected) return;
    setError(null);
    setSent(false);
    try {
      await onSend(selected);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-xs" data-send-to-agent>
      <span className="text-text-dim">
        {count} comment{count === 1 ? "" : "s"} → send fix prompt to
      </span>
      {sessions.length === 0 ? (
        <span className="text-text-dim">no live session</span>
      ) : (
        <>
          <select
            aria-label="target session"
            value={selected}
            onChange={(e) => setSessionId(e.target.value)}
            className="rounded border border-border bg-bg px-1.5 py-0.5 text-text"
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void send()}
            className="rounded border border-border px-2 py-0.5 text-text-dim hover:bg-surface-hover hover:text-text"
          >
            send
          </button>
        </>
      )}
      {sent && !error && <span className="text-text-dim">sent ✓</span>}
      {error && (
        <span role="alert" className="text-[var(--kd-error)]">
          {error}
        </span>
      )}
    </div>
  );
}

// ReviewFile carries everything NumstatEntry needs — rankFiles only reads the
// numstat-shaped fields (it works fine without hunk data; that only sharpens
// new-file detection, which the store's per-file model doesn't track).
function toNumstatEntries(files: ReviewFile[]): NumstatEntry[] {
  return files.map((f) => ({
    oldPath: f.oldPath,
    newPath: f.path,
    adds: f.adds,
    dels: f.dels,
    binary: f.binary,
    renamed: f.renamed,
  }));
}

// "3 files · +47 −9" — the Free wireframe's summary line. Uses the minus sign
// (U+2212) to match the wireframe, not a hyphen.
function summaryLine(totals: { files: number; adds: number; dels: number }): string {
  const files = `${totals.files} file${totals.files === 1 ? "" : "s"}`;
  return `${files} · +${totals.adds} −${totals.dels}`;
}

// "14 files · +612 −178 · 3 risky · 6 routine · 5 trivial" — the Pro
// wireframe's ranked summary line.
function rankedSummaryLine(totals: { files: number; adds: number; dels: number }, ranked: RankedFile[]): string {
  const counts: Record<RiskBucket, number> = { risky: 0, routine: 0, trivial: 0 };
  for (const r of ranked) counts[r.bucket]++;
  return `${summaryLine(totals)} · ${counts.risky} risky · ${counts.routine} routine · ${counts.trivial} trivial`;
}

function ScopePicker({
  scope,
  proEntitled,
  prEntitled,
  prList,
  prListLoading,
  onSelect,
  onOpenPrPicker,
}: {
  scope: ReviewScope;
  proEntitled: boolean;
  prEntitled: boolean;
  prList: PrListItem[];
  prListLoading: boolean;
  onSelect: (scope: ReviewScope) => void;
  onOpenPrPicker: () => void;
}) {
  // The PR pill toggles an inline open-PR picker; opening it kicks off the
  // `gh pr list` load. Selecting a PR switches scope to it.
  const [prOpen, setPrOpen] = useState(false);
  const pillClass = (active: boolean) =>
    `rounded border border-border px-2 py-1 ${
      active ? "bg-surface-hover text-text" : "text-text-dim hover:bg-surface-hover hover:text-text"
    }`;

  return (
    <div className="relative flex shrink-0 gap-1 text-[11px] text-text-dim">
      <button
        type="button"
        onClick={() => {
          setPrOpen(false);
          onSelect({ kind: "worktree" });
        }}
        aria-pressed={scope.kind === "worktree"}
        className={pillClass(scope.kind === "worktree")}
      >
        working tree
      </button>
      {proEntitled && (
        <button
          type="button"
          onClick={() => {
            setPrOpen(false);
            onSelect({ kind: "branch", base: null });
          }}
          aria-pressed={scope.kind === "branch"}
          className={pillClass(scope.kind === "branch")}
        >
          branch
        </button>
      )}
      {prEntitled && (
        <button
          type="button"
          onClick={() => {
            const next = !prOpen;
            setPrOpen(next);
            if (next) onOpenPrPicker();
          }}
          aria-pressed={scope.kind === "pr"}
          className={pillClass(scope.kind === "pr")}
        >
          {scope.kind === "pr" ? `pr #${scope.number}` : "pr"}
        </button>
      )}
      {prEntitled && prOpen && (
        <div
          className="absolute right-0 top-full z-10 mt-1 max-h-64 w-72 overflow-auto rounded border border-border bg-surface py-1 shadow-lg"
          data-pr-picker
        >
          {prListLoading && <p className="px-3 py-1.5 text-text-dim">loading open PRs…</p>}
          {!prListLoading && prList.length === 0 && (
            <p className="px-3 py-1.5 text-text-dim">no open pull requests</p>
          )}
          {prList.map((pr) => (
            <button
              key={pr.number}
              type="button"
              onClick={() => {
                setPrOpen(false);
                onSelect({ kind: "pr", number: pr.number, title: pr.title });
              }}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-surface-hover"
            >
              <span className="shrink-0 tabular-nums text-text-dim">#{pr.number}</span>
              <span className="min-w-0 flex-1 truncate text-text">{pr.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewModeToggle({
  mode,
  onSelect,
}: {
  mode: DiffViewMode;
  onSelect: (mode: DiffViewMode) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1 text-[11px]">
      {(["unified", "split"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onSelect(option)}
          aria-pressed={mode === option}
          className={`rounded border border-border px-2 py-1 ${
            mode === option
              ? "bg-surface-hover text-text"
              : "text-text-dim hover:bg-surface-hover hover:text-text"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

// Bucket display order + the wireframe's section labels ("read first" for
// risky, plain bucket names otherwise).
const BUCKET_ORDER: RiskBucket[] = ["risky", "routine", "trivial"];
const BUCKET_LABEL: Record<RiskBucket, string> = {
  risky: "read first",
  routine: "routine",
  trivial: "trivial",
};

// Pro's ranked, grouped file list (risk-ranked "read first"/"routine"/
// "trivial" sections, each row showing its heuristic reason and a reviewed
// checkbox). `ranked` is already sorted by rank.ts; this just partitions it.
function RankedGroups({
  ranked,
  files,
  viewMode,
  reviewed,
  commentCounts,
  commentingFor,
  onToggle,
  onToggleReviewed,
}: {
  ranked: RankedFile[];
  files: ReviewFile[];
  viewMode: DiffViewMode;
  reviewed: Record<string, true>;
  commentCounts: Record<string, number>;
  commentingFor: (path: string) => DiffCommenting | undefined;
  onToggle: (path: string) => void;
  onToggleReviewed: (path: string) => void;
}) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return (
    <div className="flex flex-col gap-3">
      {BUCKET_ORDER.map((bucket) => {
        const rows = ranked.filter((r) => r.bucket === bucket);
        if (rows.length === 0) return null;
        return (
          <div key={bucket} className="overflow-hidden rounded border border-border bg-surface">
            <p className="border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wide text-text-dim">
              {BUCKET_LABEL[bucket]}
            </p>
            <ul>
              {rows.map((r) => {
                const file = byPath.get(r.path);
                if (!file) return null;
                return (
                  <FileRow
                    key={r.path}
                    file={file}
                    viewMode={viewMode}
                    bucket={bucket}
                    reason={r.reasons.join(" · ")}
                    reviewed={!!reviewed[r.path]}
                    commentCount={commentCounts[r.path] ?? 0}
                    commenting={commentingFor(r.path)}
                    onToggle={() => onToggle(r.path)}
                    onToggleReviewed={() => onToggleReviewed(r.path)}
                  />
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function FileRow({
  file,
  viewMode,
  bucket,
  reason,
  reviewed,
  commentCount = 0,
  commenting,
  onToggle,
  onToggleReviewed,
}: {
  file: ReviewFile;
  viewMode: DiffViewMode;
  bucket?: RiskBucket;
  reason?: string;
  reviewed?: boolean;
  commentCount?: number;
  commenting?: DiffCommenting;
  onToggle: () => void;
  onToggleReviewed?: () => void;
}) {
  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex w-full items-center gap-3 px-3 py-2.5 text-xs hover:bg-surface-hover">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={file.expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span aria-hidden="true" className="w-3 shrink-0 text-text-dim">
            {file.expanded ? "▾" : "▸"}
          </span>
          {bucket && (
            <span aria-hidden="true" className="w-3 shrink-0 text-text-dim">
              {bucket === "risky" ? "⚠" : "·"}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-text">
            {file.renamed && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
          <span className="shrink-0 tabular-nums text-text-dim">{statLabel(file)}</span>
          {commentCount > 0 && (
            <span className="shrink-0 tabular-nums text-text-dim" data-comment-count>
              💬 {commentCount}
            </span>
          )}
          {reason && <span className="shrink-0 truncate text-text-dim">{reason}</span>}
        </button>
        {onToggleReviewed && (
          <input
            type="checkbox"
            checked={!!reviewed}
            onChange={onToggleReviewed}
            aria-label={`mark ${file.path} reviewed`}
            className="shrink-0"
          />
        )}
      </div>
      {file.expanded && (
        <div className="border-t border-border">{expandedBody(file, viewMode, commenting)}</div>
      )}
    </li>
  );
}

// The +/− (or "binary") stat badge for a file row.
function statLabel(file: ReviewFile): string {
  if (file.binary) return "binary";
  return `+${file.adds ?? 0} −${file.dels ?? 0}`;
}

// The expanded region for one file: its themed diff, or a stat-only/inline
// message for binary, oversized, loading, or errored diffs.
function expandedBody(file: ReviewFile, viewMode: DiffViewMode, commenting?: DiffCommenting) {
  switch (file.diffStatus) {
    case "loading":
    case "idle":
      return <p className="px-3 py-2 text-xs text-text-dim">loading diff…</p>;
    case "binary":
      return <p className="px-3 py-2 text-xs text-text-dim">binary file — no diff to show</p>;
    case "tooLarge":
      return (
        <p className="px-3 py-2 text-xs text-text-dim">
          diff too large to render{file.diffBytes ? ` (${formatKb(file.diffBytes)})` : ""} — stat only
        </p>
      );
    case "error":
      return (
        <p role="alert" className="px-3 py-2 text-xs text-[var(--kd-error)]">
          could not load diff: {file.diffError}
        </p>
      );
    case "loaded":
      return file.diff ? (
        <DiffView file={file.diff} path={file.path} viewMode={viewMode} commenting={commenting} />
      ) : (
        <p className="px-3 py-2 text-xs text-text-dim">no line changes to show</p>
      );
  }
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-sm text-text-dim">
      {children}
    </div>
  );
}
