import { useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import type {
  MemoryKind,
  MemoryRecord,
  MemorySource,
  MemoryWorkspace,
  RetentionSettings,
  WorkingMemoryMode,
  WorkspaceContext,
} from "../ipc/contract";
import {
  config as configIpc,
  git as gitIpc,
  local as localIpc,
  memory as memoryIpc,
  memoryMcpBinaryPath,
  platform,
} from "../ipc/transport";
import {
  buildMemoryMcpSetup,
  memoryMcpConfigMatches,
  type MemoryMcpClient,
} from "../memory/mcp-config";
import {
  buildAgentOnboardingPlan,
  memoryMcpTarget,
} from "../memory/agent-onboarding";
import {
  buildDelegateMcpSetup,
  claudeDelegateMcpSnippet,
  codexDelegateMcpSnippet,
} from "../local/delegate-mcp-config";
import { FEATURES, licenseStore } from "../license";
import { openMarkdownLink, rawAllowedAnchorHref } from "../markdown/links";
import { renderMarkdown } from "../markdown/render";
import {
  canConfigureMemoryMcp,
  capabilitiesStore,
} from "../platform/capabilities";
import { nativeEquals, nativeJoin } from "../platform/native-path";
import { ChangeConfirmDialog } from "./HarnessPane";
import { filesStore, harnessStore, memoryStore } from "../store/appStore";
import { isPendingChangeOwned, type PendingChangeOwner } from "../store/harness";
import { settingsViewStore } from "../store/settingsView";
import { RELEASE_MANIFEST } from "../release/manifest";

const MEMORY_KINDS: MemoryKind[] = ["summary", "decision", "task", "fact", "preference"];
const MEMORY_SOURCES: MemorySource[] = ["user", "kodade", "agent"];

export function MemoryPane({
  workspaceId,
  databasePath = null,
}: {
  workspaceId: string;
  databasePath?: string | null;
}) {
  const workspace = useStore(memoryStore, (state) => state.workspace);
  const context = useStore(memoryStore, (state) => state.context);
  const workingMemory = useStore(memoryStore, (state) => state.workingMemory);
  const checkpoints = useStore(memoryStore, (state) => state.checkpoints);
  const checkpointTotal = useStore(memoryStore, (state) => state.checkpointTotal);
  const results = useStore(memoryStore, (state) => state.results);
  const resultTotal = useStore(memoryStore, (state) => state.resultTotal);
  const selected = useStore(memoryStore, (state) => state.selected);
  const deleted = useStore(memoryStore, (state) => state.deleted);
  const deletedTotal = useStore(memoryStore, (state) => state.deletedTotal);
  const auditTotal = useStore(memoryStore, (state) => state.auditTotal);
  const selectedAudit = useStore(memoryStore, (state) => state.selectedAudit);
  const selectedAuditTotal = useStore(memoryStore, (state) => state.selectedAuditTotal);
  const loading = useStore(memoryStore, (state) => state.loading);
  const saving = useStore(memoryStore, (state) => state.saving);
  const error = useStore(memoryStore, (state) => state.error);
  const exportResult = useStore(memoryStore, (state) => state.exportResult);
  const harness = useStore(harnessStore);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [source, setSource] = useState<MemorySource | "">("");
  const [days, setDays] = useState(0);
  const [creating, setCreating] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [showAgentSetup, setShowAgentSetup] = useState(false);
  const [workingMode, setWorkingMode] = useState<WorkingMemoryMode>("commit");
  const [exportExisting, setExportExisting] = useState(true);
  useEffect(() => {
    if (workspace?.id !== workspaceId) void memoryStore.getState().load(workspaceId);
  }, [workspace?.id, workspaceId]);

  // MCP clients write through their own stdio process. Refresh as soon as this
  // Settings becomes visible, then lightly while it remains mounted. The store owns
  // focus and document-visibility gating so its lifecycle stays testable.
  useEffect(() => {
    memoryStore.getState().startPolling(workspaceId);
    return () => {
      memoryStore.getState().stopPolling();
    };
  }, [workspaceId]);

  const showingSearchResults = Boolean(query || kind || source || days);
  const list = showingSearchResults
    ? results
    : (context?.recentMemories ?? []).map((memory) => ({
      ...memory,
      excerpt: memory.body.slice(0, 240),
      filePath: null,
    }));

  const runSearch = (event?: FormEvent) => {
    event?.preventDefault();
    void memoryStore.getState().search(
      query,
      kind ? [kind] : [],
      source ? [source] : [],
      days ? Date.now() - days * 24 * 60 * 60 * 1000 : null,
    );
  };

  const createMemory = () => {
    memoryStore.getState().clearSelection();
    setCreating(true);
  };

  const openWorkingFile = async (relativePath: string, root = workspace?.canonicalRoot) => {
    if (!root) return;
    const path = relativePath
      .split("/")
      .filter(Boolean)
      .reduce((parent, name) => nativeJoin(parent, name), root);
    await filesStore.getState().selectFile(path);
    settingsViewStore.getState().close();
  };

  const activateWorkingMemory = async () => {
    if (!workspace) return;
    const activated = await memoryStore
      .getState()
      .activateWorking(workingMode, exportExisting);
    if (activated) {
      await establishCommitBaseline(workspace);
    }
  };

  if (!workspace || workspace.id !== workspaceId) {
    return <MemoryMessage text={error ?? "Loading KödMem…"} />;
  }
  const memoryOwner: PendingChangeOwner = { surface: "memory", scopeId: workspace.id };
  const memoryPending = isPendingChangeOwned(harness.pendingChange, memoryOwner)
    ? harness.pendingChange
    : null;

  return (
    <section aria-busy={saving} className="flex h-full min-w-0 flex-col bg-bg text-text">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{workspace.displayName}</div>
          <div className="truncate text-[10px] text-text-dim">
            Project · {workspace.canonicalRoot}
          </div>
          <div className="truncate text-[10px] text-text-dim">
            Stored · {databasePath ?? "Ködade app data/kodade-memory.sqlite3"}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-dim">
          <input
            type="checkbox"
            disabled={saving}
            checked={!workspace.capturePaused}
            onChange={(event) =>
              void updateRetention(workspaceRetention(workspace, !event.target.checked))
            }
          />
          capture
        </label>
        <select
          aria-label="memory retention"
          disabled={saving}
          value={workspace.activityRetentionDays}
          onChange={(event) => {
            const retention = Number(event.target.value);
            void updateRetention({
              capturePaused: workspace.capturePaused,
              activityDays: retention,
              auditDays: retention,
              tombstoneDays: retention,
            });
          }}
          className="rounded border border-border bg-bg px-2 py-1 text-xs text-text-dim"
        >
          {[7, 30, 90, 365].map((value) => (
            <option key={value} value={value}>{value}d retention</option>
          ))}
        </select>
        <button
          className="memory-action"
          disabled={saving}
          type="button"
          onClick={() => void exportMemory()}
        >
          export
        </button>
        <button
          className="memory-action"
          disabled={saving}
          type="button"
          onClick={() => void relinkMemory(workspace)}
        >
          relink
        </button>
        <button className="memory-action text-[var(--kd-error)]" disabled={saving} type="button" onClick={() => void purgeMemory()}>
          purge
        </button>
      </header>

      {error && (
        <div className="flex items-center border-b border-[color-mix(in_srgb,var(--kd-error)_40%,transparent)] bg-[color-mix(in_srgb,var(--kd-error)_8%,transparent)] px-4 py-2 text-xs text-[var(--kd-error)]">
          <span className="flex-1">{error}</span>
          <button aria-label="dismiss KödMem error" type="button" onClick={() => memoryStore.getState().clearError()}>×</button>
        </div>
      )}
      {exportResult && (
        <div className="border-b border-border px-4 py-2 text-[11px] text-text-dim">
          Exported Markdown and JSON to {exportResult.markdownPath}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,38%)_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-border bg-surface/40">
          <form className="grid gap-2 border-b border-border p-3" onSubmit={runSearch}>
            <div className="flex gap-2">
              <input
                aria-label="search KödMem"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search local memory"
                className="min-w-0 flex-1 rounded border border-border bg-bg px-2.5 py-1.5 text-xs outline-none focus:border-accent"
              />
              <button className="memory-action" type="submit">search</button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <FilterSelect ariaLabel="memory kind filter" label="all types" value={kind} values={MEMORY_KINDS} onChange={(value) => setKind(value as MemoryKind | "")} />
              <FilterSelect ariaLabel="memory source filter" label="all sources" value={source} values={MEMORY_SOURCES} onChange={(value) => setSource(value as MemorySource | "")} />
              <select
                aria-label="memory date filter"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                className="rounded border border-border bg-bg px-2 py-1 text-[11px] text-text-dim"
              >
                <option value={0}>any date</option>
                <option value={7}>last 7d</option>
                <option value={30}>last 30d</option>
                <option value={90}>last 90d</option>
              </select>
            </div>
          </form>

          <div className="border-b border-border p-3">
            <div className="mb-2 flex items-center">
              <span className="memory-heading flex-1">Hub</span>
              <button
                className="memory-action"
                disabled={saving}
                type="button"
                onClick={createMemory}
              >
                + memory
              </button>
            </div>
            {context?.latestCheckpoint && (
              <div className="mb-2 rounded border border-border bg-bg/70 p-2 text-xs">
                <div className="memory-kicker">current focus</div>
                <p className="mt-1 line-clamp-3 text-text-dim">{context.latestCheckpoint.summary}</p>
              </div>
            )}
            <HubGroup label="pinned decisions" records={context?.pinnedDecisions ?? []} />
            <HubGroup label="next actions" records={context?.openTasks ?? []} />
            {checkpoints.length > 0 && (
              <div className="mt-3">
                <div className="memory-kicker">
                  timeline · {checkpoints.length} / {checkpointTotal}
                </div>
                {checkpoints.slice(0, 5).map((checkpoint) => (
                  <div key={checkpoint.id} className="mt-2 border-l border-border pl-2">
                    <div className="line-clamp-2 text-[11px] leading-4">
                      {stripHighlight(checkpoint.excerpt || checkpoint.summary)}
                    </div>
                    <div className="mt-0.5 text-[10px] text-text-dim">
                      {checkpoint.sourceClient}
                      {checkpoint.sessionId ? ` · ${checkpoint.sessionId}` : ""}
                      {" · "}{formatDate(checkpoint.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {context?.projectKnowledge && (
            <section className="border-b border-border p-3" aria-label="Mapped project knowledge">
              <div className="memory-heading">Mapped project knowledge</div>
              <p className="mt-1 truncate text-[11px] text-text-dim">
                {context.projectKnowledge.projectDisplayName} · {context.projectKnowledge.origin}
              </p>
              {context.projectKnowledge.sync.status === "error" ? (
                <p role="alert" className="mt-2 text-[11px] leading-4 text-[var(--kd-error)]">
                  {context.projectKnowledge.sync.error ?? "Mapped Markdown refresh failed."}
                </p>
              ) : (
                <>
                  <p className="mt-1 text-[11px] text-text-dim">
                    current · {context.projectKnowledge.sync.indexedDocuments} documents
                    {context.projectKnowledge.sync.truncated ? " · bounded" : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {context.projectKnowledge.sources.map((source) => (
                      <button
                        key={source.relativePath}
                        className="memory-action"
                        type="button"
                        title={`sha256:${source.sha256}`}
                        onClick={() =>
                          void openWorkingFile(
                            source.relativePath,
                            context.projectKnowledge?.origin,
                          )
                        }
                      >
                        {source.relativePath}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          <section className="border-b border-border p-3" aria-label="Project working memory">
            <div className="memory-heading">Project working memory</div>
            {workingMemory ? (
              <>
                <p className="mt-1 text-[11px] leading-4 text-text-dim">
                  {workingMemory.mode === "commit" ? "Committed with the project" : "Local to this machine"}
                  {" · "}{workingMemory.directory}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {[
                    workingMemory.statePath,
                    workingMemory.worklogPath,
                    workingMemory.decisionsPath,
                  ].map((path) => (
                    <button
                      key={path}
                      className="memory-action"
                      type="button"
                      onClick={() => void openWorkingFile(path)}
                    >
                      {path.split("/").at(-1)}
                    </button>
                  ))}
                  <button
                    className="memory-action"
                    disabled={saving}
                    type="button"
                    onClick={() => void memoryStore.getState().syncWorking()}
                  >
                    sync
                  </button>
                </div>
              </>
            ) : (
              <div className="mt-2 grid gap-2 text-[11px] text-text-dim">
                <p>
                  Add readable project state, worklog, decisions, and plans under
                  <code className="ml-1">.kodade/memory</code>.
                </p>
                <select
                  aria-label="working memory storage"
                  value={workingMode}
                  onChange={(event) => setWorkingMode(event.target.value as WorkingMemoryMode)}
                  className="rounded border border-border bg-bg px-2 py-1 text-[11px]"
                >
                  <option value="commit">Commit with project</option>
                  <option value="local">Keep local</option>
                </select>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={exportExisting}
                    onChange={(event) => setExportExisting(event.target.checked)}
                  />
                  export existing durable memories
                </label>
                <button
                  className="memory-action border-accent text-accent"
                  disabled={saving}
                  type="button"
                  onClick={() =>
                    void activateWorkingMemory()
                  }
                >
                  activate working memory
                </button>
              </div>
            )}
          </section>

          <ConnectAgentsSection
            workspace={workspace}
            expanded={showAgentSetup}
            onExpandedChange={setShowAgentSetup}
          />

          <div className="border-b border-border p-3">
            <button
              aria-controls="kodmem-recently-deleted"
              aria-expanded={showDeleted}
              className="flex w-full items-center text-left"
              type="button"
              onClick={() => setShowDeleted((visible) => !visible)}
            >
              <span className="memory-heading flex-1">Recently Deleted</span>
              <span className="text-[10px] text-text-dim">{deleted.length} / {deletedTotal}</span>
            </button>
            {showDeleted && (
              <section id="kodmem-recently-deleted" className="mt-2" aria-label="Recently Deleted memories">
                <p className="mb-2 text-[11px] leading-4 text-text-dim">
                  Restore deleted memories for up to {workspace.tombstoneRetentionDays} {workspace.tombstoneRetentionDays === 1 ? "day" : "days"}. Expired entries are removed.
                </p>
                {deleted.map((memory) => (
                  <button
                    key={memory.id}
                    className={`block w-full rounded px-1 py-1.5 text-left text-xs hover:bg-surface-hover ${selected?.id === memory.id ? "bg-surface-hover" : ""}`}
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      void memoryStore.getState().select(memory.id);
                    }}
                  >
                    <span className="block truncate font-medium">{memory.title}</span>
                    <span className="block text-[10px] text-text-dim">deleted {formatDate(memory.deletedAt ?? memory.updatedAt)}</span>
                  </button>
                ))}
                {deleted.length === 0 && (
                  <p className="text-[11px] text-text-dim">No retained deleted memories.</p>
                )}
                {deleted.length < deletedTotal && (
                  <button
                    className="memory-action mt-2"
                    type="button"
                    onClick={() => void memoryStore.getState().loadMoreDeleted()}
                  >
                    load more deleted memories
                  </button>
                )}
              </section>
            )}
          </div>

          <div className="flex items-center border-b border-border px-3 py-2">
            <span className="memory-heading flex-1">Memories</span>
            <span className="text-[10px] text-text-dim">{showingSearchResults ? resultTotal : list.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {list.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  setCreating(false);
                  if (item.filePath) {
                    void openWorkingFile(
                      item.filePath,
                      item.projectSource ? context?.projectKnowledge?.origin : undefined,
                    );
                  }
                  else void memoryStore.getState().select(item.id);
                }}
                className={`block w-full border-b border-border px-3 py-2.5 text-left hover:bg-surface-hover ${selected?.id === item.id ? "bg-surface-hover" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span className="memory-kind">{item.kind}</span>
                  <span className="truncate text-xs font-medium">{item.title}</span>
                  {item.pinned && <span className="text-[10px] text-accent">◆</span>}
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-text-dim">{stripHighlight(item.excerpt)}</p>
              </button>
            ))}
            {!loading && list.length === 0 && (
              <div className="p-4 text-xs text-text-dim">No memories match this view.</div>
            )}
            {showingSearchResults && results.length < resultTotal && (
              <button
                aria-label="load more search results"
                className="memory-action m-3"
                type="button"
                onClick={() => void memoryStore.getState().loadMoreSearchResults()}
              >
                load more search results
              </button>
            )}
          </div>
        </aside>

        <main className="min-h-0 overflow-auto">
          {creating ? (
            <MemoryEditor key="new" record={null} saving={saving} tombstoneRetentionDays={workspace.tombstoneRetentionDays} onDone={() => setCreating(false)} />
          ) : selected ? (
            <MemoryEditor key={selected.id} record={selected} recordAudit={selectedAudit} recordAuditTotal={selectedAuditTotal} saving={saving} tombstoneRetentionDays={workspace.tombstoneRetentionDays} onDone={() => undefined} />
          ) : (
            <MemoryOverview
              context={context}
              auditTotal={auditTotal}
              onCreate={createMemory}
            />
          )}
        </main>
      </div>

      {memoryPending && (
        <div className="border-t border-border bg-surface p-3">
          <ChangeConfirmDialog
            pending={memoryPending}
            applying={harness.applying}
            error={harness.mutationError}
            projectRoot={workspace.canonicalRoot}
            onCancel={() => harnessStore.getState().cancelPendingChange(memoryOwner)}
            onConfirm={() =>
              void harnessStore.getState().confirmPendingChange(memoryOwner)
            }
          />
        </div>
      )}

    </section>
  );
}

type BinaryStatus =
  | { kind: "loading" }
  | { kind: "ready"; path: string }
  | { kind: "missing"; detail: string | null };

type ConnectionStatus =
  | "checking"
  | "connected-readwrite"
  | "connected-readonly"
  | "not-connected";

function redactOnboardingError(detail: string, localPaths: readonly (string | null)[]): string {
  return localPaths.reduce<string>(
    (message, path) => path ? message.replaceAll(path, "<local-path>") : message,
    detail,
  );
}

const MCP_CLIENTS: { id: MemoryMcpClient; label: string; scope: "global" | "project"; path: string }[] = [
  { id: "claude", label: "Claude Code", scope: "project", path: ".mcp.json" },
  { id: "codex", label: "Codex", scope: "global", path: "~/.codex/config.toml" },
];

function ConnectAgentsSection({
  workspace,
  expanded,
  onExpandedChange,
}: {
  workspace: MemoryWorkspace;
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
}) {
  const caps = useStore(capabilitiesStore, (state) => state.capabilities);
  const nativeMcpSetup = canConfigureMemoryMcp(caps);
  const harness = useStore(harnessStore);
  const orchestrationEntitled = useStore(licenseStore, (state) =>
    state.entitlements.hasFeature(FEATURES.localOrchestrate),
  );
  const localDelegationAvailable =
    RELEASE_MANIFEST.features.local && orchestrationEntitled;
  const [readOnly, setReadOnly] = useState(false);
  const [binary, setBinary] = useState<BinaryStatus>({ kind: "loading" });
  const [delegateBundle, setDelegateBundle] = useState<BinaryStatus>({ kind: "loading" });
  const [setupError, setSetupError] = useState<string | null>(null);
  const [configHome, setConfigHome] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [connections, setConnections] = useState<
    Record<MemoryMcpClient, ConnectionStatus>
  >({
    claude: "checking",
    codex: "checking",
  });
  const pendingOwner: PendingChangeOwner = { surface: "memory", scopeId: workspace.id };
  const pendingForWorkspace = isPendingChangeOwned(harness.pendingChange, pendingOwner)
    ? harness.pendingChange
    : null;
  const visible = expanded || pendingForWorkspace !== null;

  useEffect(() => {
    if (pendingForWorkspace) onExpandedChange(true);
  }, [onExpandedChange, pendingForWorkspace]);

  useEffect(() => {
    if (!nativeMcpSetup || !visible) return;
    let cancelled = false;
    setBinary({ kind: "loading" });
    void Promise.resolve()
      .then(() => memoryMcpBinaryPath())
      .then((result) => {
        if (cancelled) return;
        setBinary(
          result.exists && result.path
            ? { kind: "ready", path: result.path }
            : { kind: "missing", detail: null },
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBinary({
            kind: "missing",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nativeMcpSetup, visible]);

  useEffect(() => {
    if (!nativeMcpSetup || !localDelegationAvailable || !visible) return;
    let cancelled = false;
    setDelegateBundle({ kind: "loading" });
    void localIpc
      .status()
      .then((status) => {
        if (cancelled) return;
        setDelegateBundle(
          status.cliPath
            ? { kind: "ready", path: status.cliPath }
            : { kind: "missing", detail: status.message },
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDelegateBundle({
            kind: "missing",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [localDelegationAvailable, nativeMcpSetup, visible]);

  const setup = buildMemoryMcpSetup({
    workspaceId: workspace.id,
    workspaceRoot: workspace.canonicalRoot,
    binaryPath: binary.kind === "ready" ? binary.path : null,
    readOnly,
  });
  const writableSetup = buildMemoryMcpSetup({
    workspaceId: workspace.id,
    workspaceRoot: workspace.canonicalRoot,
    binaryPath: binary.kind === "ready" ? binary.path : null,
    readOnly: false,
  });
  const readOnlySetup = buildMemoryMcpSetup({
    workspaceId: workspace.id,
    workspaceRoot: workspace.canonicalRoot,
    binaryPath: binary.kind === "ready" ? binary.path : null,
    readOnly: true,
  });
  const delegateSetup = buildDelegateMcpSetup({
    workspaceId: workspace.id,
    workspaceRoot: workspace.canonicalRoot,
    bundlePath: delegateBundle.kind === "ready" ? delegateBundle.path : null,
    entitled: localDelegationAvailable,
  });
  const busy = harness.preparing || harness.applying || harness.pendingChange !== null;

  const refreshConnections = async () => {
    if (setup.state !== "ready") return;
    setConnections({ claude: "checking", codex: "checking" });
    const env = await configIpc.env().catch(() => null);
    if (!env) {
      setConnections({ claude: "not-connected", codex: "not-connected" });
      return;
    }
    setConfigHome(env.home);
    const checked = await Promise.all(
      MCP_CLIENTS.map(async (client) => {
        try {
          const target = memoryMcpTarget(
            env.home,
            workspace.canonicalRoot,
            client.id,
          );
          const read = await configIpc.read(
            target.path,
            workspace.canonicalRoot,
          );
          if (
            read.kind !== "text" ||
            writableSetup.state !== "ready" ||
            readOnlySetup.state !== "ready"
          ) {
            return [client.id, "not-connected"] as const;
          }
          const writable = memoryMcpConfigMatches(
            read.content,
            target.format,
            target.keyPath,
            writableSetup.spec(client.id),
          );
          const connectedReadOnly = memoryMcpConfigMatches(
            read.content,
            target.format,
            target.keyPath,
            readOnlySetup.spec(client.id),
          );
          const detectedReadOnly = writable ? false : connectedReadOnly ? true : null;
          if (detectedReadOnly === null) return [client.id, "not-connected"] as const;
          const health = await memoryIpc.mcpHealth(workspace.id, client.id, detectedReadOnly);
          return [client.id, health.ok
            ? detectedReadOnly ? "connected-readonly" : "connected-readwrite"
            : "not-connected"] as const;
        } catch {
          return [client.id, "not-connected"] as const;
        }
      }),
    );
    setConnections(Object.fromEntries(checked) as Record<
      MemoryMcpClient,
      ConnectionStatus
    >);
  };

  const previouslyPending = useRef(pendingForWorkspace !== null);
  useEffect(() => {
    const finished = previouslyPending.current && pendingForWorkspace === null;
    previouslyPending.current = pendingForWorkspace !== null;
    if (finished && !harness.mutationError && visible && binary.kind === "ready") {
      void refreshConnections();
    }
    // refreshConnections is intentionally driven by the pending-change edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binary.kind, harness.mutationError, pendingForWorkspace, visible]);

  useEffect(() => {
    if (!visible || binary.kind !== "ready") return;
    void refreshConnections();
    // Recheck whenever the exact generated command or arguments can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visible,
    binary.kind,
    binary.kind === "ready" ? binary.path : "",
    workspace.id,
    workspace.canonicalRoot,
  ]);

  // Fail closed in web mode, including while its capabilities are still
  // resolving. The bundled binary is a desktop-only path and must never be
  // requested through the remote memory transport.
  if (!nativeMcpSetup) return null;

  const prepareOnboarding = async (action: "connect" | "remove") => {
    if (setup.state !== "ready" || binary.kind !== "ready" || busy) return;
    const helperPath = binary.path;
    let localHome = configHome;
    setSetupError(null);
    try {
      const env = await configIpc.env();
      localHome = env.home;
      setConfigHome(env.home);
      const plan = await buildAgentOnboardingPlan(configIpc, {
        workspaceId: workspace.id,
        workspaceRoot: workspace.canonicalRoot,
        binaryPath: helperPath,
        home: env.home,
        platform: env.platform,
        appDataRoaming: env.appDataRoaming,
        appDataLocal: env.appDataLocal,
        access: readOnly ? "read-only" : "read-write",
      }, action);
      if (plan.requests.length === 0) {
        await refreshConnections();
        return;
      }
      setReviewing(true);
      await harnessStore.getState().prepareBatch(
        plan.requests,
        action === "connect" ? "Connect Claude Code and Codex to KödMem" : "Remove KödMem agent onboarding",
        pendingOwner,
        action === "connect"
          ? async () => {
              const checked = await Promise.all(MCP_CLIENTS.map((client) =>
                memoryIpc.mcpHealth(workspace.id, client.id, readOnly)
              ));
              const failed = checked.find((health) => !health.ok);
              return failed
                ? { ok: false as const, reason: failed.message }
                : { ok: true as const };
            }
          : undefined,
      );
      if (!harnessStore.getState().pendingChange) setReviewing(false);
    } catch (error) {
      setReviewing(false);
      const detail = error instanceof Error ? error.message : String(error);
      setSetupError(redactOnboardingError(detail, [
        workspace.canonicalRoot,
        helperPath,
        localHome,
      ]));
    }
  };

  const addDelegateToConfig = async (client: MemoryMcpClient) => {
    if (delegateSetup.state !== "ready" || busy) return;
    setSetupError(null);
    const clientConfig = MCP_CLIENTS.find((candidate) => candidate.id === client)!;
    try {
      const target = (await harnessStore
        .getState()
        .listMcpTargets(clientConfig.scope, workspace.canonicalRoot))
        .find((candidate) => candidate.cli === client);
      if (!target) {
        setSetupError(`Kodade does not know a ${clientConfig.label} MCP config path yet.`);
        return;
      }
      setReviewing(true);
      await harnessStore.getState().prepareAddMcpServer(
        target,
        delegateSetup.spec(client),
        workspace.canonicalRoot,
        pendingOwner,
      );
      if (!harnessStore.getState().pendingChange) setReviewing(false);
    } catch (error) {
      setReviewing(false);
      setSetupError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section
      id="kodmem-agent-access"
      className="border-b border-border p-3"
      aria-label="Connect agents"
    >
      <button
        type="button"
        aria-expanded={visible}
        aria-controls="kodmem-agent-setup"
        className="flex w-full items-center gap-3 text-left"
        onClick={() => onExpandedChange(!visible)}
      >
        <span className="min-w-0 flex-1">
          <span className="memory-heading block">Connect agents</span>
          <span className="mt-1 block text-[11px] leading-4 text-text-dim">
            Connect once. New agent sessions are instructed to load context and
            leave a checkpoint.
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-accent">
          {visible ? "hide" : "set up"}
        </span>
      </button>
      {visible && (
        <div id="kodmem-agent-setup">
      {binary.kind === "loading" && <p className="mt-2 text-[11px] text-text-dim">Checking for kodade-mcp…</p>}
      {binary.kind === "missing" && (
        <div className="mt-2 text-[11px] leading-4 text-text-dim">
          <p>
            kodade-mcp is not built yet. Run{" "}
            <code>
              {"cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin kodade-mcp"}
            </code>{" "}
            in development.
          </p>
          {binary.detail && <p className="mt-1">{binary.detail}</p>}
        </div>
      )}
      {binary.kind === "ready" && setup.state === "ready" && (
        <>
          <label className="mt-2 flex items-center gap-2 text-[11px] text-text-dim">
            <input
              type="checkbox"
              checked={readOnly}
              disabled={busy}
              onChange={(event) => setReadOnly(event.target.checked)}
            />
            read-only access
          </label>
          <div className="mt-3 rounded border border-border bg-bg/50 p-3">
            <div className="grid gap-2 text-[11px]">
              {MCP_CLIENTS.map((client) => (
                <div className="flex items-center gap-2" key={client.id}>
                  <span className="flex-1 font-medium">{client.label}</span>
                  <span className={connections[client.id].startsWith("connected") ? "text-accent" : "text-text-dim"}>
                    {connections[client.id] === "checking"
                      ? "checking actual context…"
                      : connections[client.id] === "connected-readonly"
                        ? "healthy · read-only"
                        : connections[client.id] === "connected-readwrite"
                          ? "healthy · read-write"
                          : "not connected"}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-4 text-text-dim">
              One preview installs the project workflow, manages bounded instruction
              blocks, and configures both clients. Health verifies client discovery,
              KödMCP tools, and context for this project.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              {Object.values(connections).some((status) => status.startsWith("connected")) && (
                <button className="memory-action" disabled={busy} type="button" onClick={() => void prepareOnboarding("remove")}>
                  disconnect
                </button>
              )}
              <button className="memory-action border-accent text-accent" disabled={busy} type="button" onClick={() => void prepareOnboarding("connect")}>
                review setup
              </button>
            </div>
          </div>
          {RELEASE_MANIFEST.features.local && (
            <details className="mt-4 border-t border-border pt-3">
              <summary className="cursor-pointer text-[11px] font-medium text-text-dim">
                Advanced
              </summary>
              <div className="mt-3 text-[11px] font-medium">
                Delegate to KödLocal
              </div>
              {!orchestrationEntitled && (
                <p className="mt-1 text-[11px] text-text-dim">
                  Requires the local.orchestrate entitlement. The raw local model
                  endpoint remains free.
                </p>
              )}
              {orchestrationEntitled && delegateBundle.kind === "loading" && (
                <p className="mt-1 text-[11px] text-text-dim">
                  Checking for kodade-local…
                </p>
              )}
              {orchestrationEntitled && delegateBundle.kind === "missing" && (
                <div className="mt-1 text-[11px] text-text-dim">
                  <p>
                    kodade-local is not built yet. Run <code>pnpm build:cli</code>{" "}
                    in development.
                  </p>
                  {delegateBundle.detail && (
                    <p className="mt-1">{delegateBundle.detail}</p>
                  )}
                </div>
              )}
              {delegateSetup.state === "ready" && (
                <>
                  <p className="mt-1 text-[11px] leading-4 text-text-dim">
                    Headless delegations are read-only by default. Writes return to
                    the frontier agent as suggestions.
                  </p>
                  <p className="mt-2 break-all font-mono text-[11px] text-text-dim">
                    {delegateBundle.kind === "ready" ? delegateBundle.path : ""}
                  </p>
                  <div className="mt-3 grid gap-3">
                    {MCP_CLIENTS.map((client) => (
                      <ConfigSnippet
                        key={`delegate-${client.id}`}
                        client={client}
                        snippet={
                          client.id === "claude"
                            ? claudeDelegateMcpSnippet(delegateSetup)
                            : codexDelegateMcpSnippet(delegateSetup)
                        }
                        busy={busy}
                        onAdd={() => void addDelegateToConfig(client.id)}
                      />
                    ))}
                  </div>
                </>
              )}
            </details>
          )}
          {(setupError || (reviewing ? harness.mutationError : null)) && !harness.pendingChange && (
            <p role="alert" className="mt-2 text-[11px] text-[var(--kd-error)]">
              {redactOnboardingError(
                setupError ?? harness.mutationError ?? "KödMem onboarding failed",
                [
                  workspace.canonicalRoot,
                  binary.kind === "ready" ? binary.path : null,
                  configHome,
                ],
              )}
            </p>
          )}
        </>
      )}
        </div>
      )}
    </section>
  );
}

function ConfigSnippet({
  client,
  snippet,
  busy,
  status,
  onAdd,
}: {
  client: (typeof MCP_CLIENTS)[number];
  snippet: string;
  busy: boolean;
  status?: ConnectionStatus;
  onAdd(): void;
}) {
  const connected =
    status === "connected-readwrite" || status === "connected-readonly";
  return (
    <div className="rounded border border-border bg-bg/50 p-2">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="flex-1 font-medium">{client.label}</span>
        {status && (
          <span
            className={
              connected ? "text-accent" : "text-text-dim"
            }
          >
            {status === "checking"
              ? "checking…"
              : status === "connected-readonly"
                ? "connected · read-only"
                : status === "connected-readwrite"
                  ? "connected · read-write"
                : "not connected"}
          </span>
        )}
        <button className="memory-action" disabled={busy} type="button" onClick={onAdd}>
          {connected ? "update" : "connect"}
        </button>
      </div>
      <details className="mt-2 text-[10px] text-text-dim">
        <summary className="cursor-pointer">manual config · {client.path}</summary>
        <div className="mt-2 flex justify-end">
          <button
            className="memory-action"
            type="button"
            onClick={() => void navigator.clipboard?.writeText(snippet)}
          >
            copy
          </button>
        </div>
        <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all leading-4">{snippet}</pre>
      </details>
    </div>
  );
}

function MemoryEditor({ record, recordAudit = [], recordAuditTotal = null, saving, tombstoneRetentionDays, onDone }: { record: MemoryRecord | null; recordAudit?: import("../ipc/contract").AuditEntry[]; recordAuditTotal?: number | null; saving: boolean; tombstoneRetentionDays: number; onDone(): void }) {
  const [kind, setKind] = useState<MemoryKind>(record?.kind ?? "summary");
  const [title, setTitle] = useState(record?.title ?? "");
  const [body, setBody] = useState(record?.body ?? "");
  const [pinned, setPinned] = useState(record?.pinned ?? false);
  const [preview, setPreview] = useState(!!record);
  const editGeneration = useRef(0);
  const deletedAt = record?.deletedAt ?? null;
  const restoreAvailable = deletedAt !== null && deletedAt >= Date.now() - tombstoneRetentionDays * 24 * 60 * 60 * 1000;
  const restoreWindow = `${tombstoneRetentionDays} ${tombstoneRetentionDays === 1 ? "day" : "days"}`;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const submittedGeneration = editGeneration.current;
    if (record) {
      await memoryStore.getState().saveSelected({ kind, title, body, pinned, links: record.links });
    } else {
      const created = await memoryStore.getState().createMemory({ kind, title, body, pinned, links: [] });
      if (created && editGeneration.current === submittedGeneration) onDone();
    }
  };

  return (
    <form className="mx-auto flex min-h-full max-w-4xl flex-col p-5" onSubmit={(event) => void save(event)}>
      {deletedAt !== null && (
        <div role="status" className="mb-3 rounded border border-[color-mix(in_srgb,var(--kd-error)_40%,transparent)] bg-[color-mix(in_srgb,var(--kd-error)_8%,transparent)] px-3 py-2 text-xs text-[var(--kd-error)]">
          Deleted {formatDate(deletedAt)}. {restoreAvailable ? `Restore is available for ${restoreWindow}.` : `The ${restoreWindow} restore window has expired.`}
        </div>
      )}
      <div className="mb-3 flex items-center gap-2">
        <select aria-label="memory kind" disabled={deletedAt !== null} value={kind} onChange={(event) => { editGeneration.current += 1; setKind(event.target.value as MemoryKind); }} className="rounded border border-border bg-surface px-2 py-1 text-xs">
          {MEMORY_KINDS.map((value) => <option key={value}>{value}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-text-dim">
          <input disabled={deletedAt !== null} type="checkbox" checked={pinned} onChange={(event) => { editGeneration.current += 1; setPinned(event.target.checked); }} /> pinned
        </label>
        <span className="flex-1" />
        {deletedAt === null && <button className="memory-action" type="button" onClick={() => setPreview((value) => !value)}>{preview ? "edit" : "preview"}</button>}
        {record && deletedAt === null && (
          <button className="memory-action text-[var(--kd-error)]" disabled={saving} type="button" onClick={() => void forgetRecord(record)}>delete</button>
        )}
        {record && restoreAvailable && (
          <button className="memory-action border-accent text-accent" disabled={saving} type="button" onClick={() => void memoryStore.getState().restoreSelected()}>restore</button>
        )}
        <button className="memory-action border-accent text-accent" disabled={saving || deletedAt !== null || !title.trim()} type="submit">{saving ? "saving…" : "save"}</button>
      </div>
      <input
        aria-label="memory title"
        disabled={deletedAt !== null}
        value={title}
        onChange={(event) => { editGeneration.current += 1; setTitle(event.target.value); }}
        maxLength={200}
        placeholder="Memory title"
        className="mb-3 border-b border-border bg-transparent px-1 py-2 text-xl font-semibold outline-none focus:border-accent"
      />
      {preview ? (
        <article
          className="markdown-view min-h-64 flex-1 rounded border border-border bg-surface/30 p-4"
          onClick={(event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const link = target.closest<HTMLAnchorElement>("a");
            if (!link) return;
            event.preventDefault();
            const href = rawAllowedAnchorHref(link);
            if (href) void openMarkdownLink(href);
          }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
        />
      ) : (
        <textarea
          aria-label="memory body"
          disabled={deletedAt !== null}
          value={body}
          onChange={(event) => { editGeneration.current += 1; setBody(event.target.value); }}
          placeholder="Markdown memory…"
          className="min-h-64 flex-1 resize-none rounded border border-border bg-surface/30 p-3 font-mono text-sm leading-6 outline-none focus:border-accent"
        />
      )}
      {record && (
        <div className="mt-4 grid gap-3 border-t border-border pt-4 text-[11px] text-text-dim sm:grid-cols-2">
          <div>
            <div className="memory-kicker">record</div>
            <div className="mt-1">{record.source} via {record.sourceClient} · version {record.version}</div>
            <div>Created {formatDate(record.createdAt)}</div>
            <div>Last updated {formatDate(record.updatedAt)}</div>
          </div>
          <div>
            <div className="memory-kicker">links / backlinks</div>
            <div className="mt-1">{record.links.length} outgoing · {record.backlinks.length} incoming</div>
            {[...record.links.map((link) => ({ ...link, direction: "→" })), ...record.backlinks.map((link) => ({ ...link, direction: "←" }))].map((link) => (
              <button
                type="button"
                key={`${link.direction}:${link.targetId}:${link.relation}`}
                className="mt-1 block max-w-full truncate hover:text-accent"
                onClick={() => void memoryStore.getState().select(link.targetId)}
              >
                {link.direction} {link.relation} · {link.targetId}
              </button>
            ))}
          </div>
          <div className="sm:col-span-2">
              <div className="memory-kicker">audit history</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {recordAudit.map((entry) => <span key={entry.id}>{entry.action} · {entry.client} · {formatDate(entry.occurredAt)}</span>)}
              {recordAuditTotal === null && <span>loading audit history…</span>}
              {recordAuditTotal === 0 && <span>no mutations recorded</span>}
              </div>
              {recordAuditTotal !== null && recordAudit.length < recordAuditTotal && (
                <button className="memory-action mt-2" type="button" onClick={() => void memoryStore.getState().loadMoreSelectedAudit()}>
                  load more audit history
                </button>
              )}
          </div>
        </div>
      )}
    </form>
  );
}

function MemoryOverview({
  context,
  auditTotal,
  onCreate,
}: {
  context: WorkspaceContext | null;
  auditTotal: number;
  onCreate(): void;
}) {
  const memoryCount = context?.recentMemories.length ?? 0;
  return (
    <div className="mx-auto max-w-xl p-8">
      <h2 className="text-xl font-semibold">
        {memoryCount === 0 ? "No saved memories yet" : `${memoryCount} memories`}
      </h2>
      <p className="mt-2 text-sm text-text-dim">
        {memoryCount === 0
          ? "Timeline checkpoints are session history. Saved memories are durable decisions, tasks, facts, preferences, or summaries."
          : "Decisions, tasks, facts, and handoffs for this project."}
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="memory-action mt-4 border-accent text-accent"
      >
        Create memory
      </button>
      <div className="mt-6 flex gap-4 text-[11px] text-text-dim">
        <span>{context?.openTasks.length ?? 0} next actions</span>
        <span>{auditTotal} audit entries</span>
      </div>
    </div>
  );
}

function HubGroup({ label, records }: { label: string; records: MemoryRecord[] }) {
  if (records.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="memory-kicker">{label}</div>
      {records.slice(0, 3).map((record) => (
        <button key={record.id} type="button" onClick={() => void memoryStore.getState().select(record.id)} className="mt-1 block w-full truncate text-left text-xs hover:text-accent">
          {record.kind === "task" ? "○" : "◆"} {record.title}
        </button>
      ))}
    </div>
  );
}

function FilterSelect({ ariaLabel, label, value, values, onChange }: { ariaLabel: string; label: string; value: string; values: string[]; onChange(value: string): void }) {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} className="rounded border border-border bg-bg px-2 py-1 text-[11px] text-text-dim">
      <option value="">{label}</option>
      {values.map((item) => <option key={item}>{item}</option>)}
    </select>
  );
}

function MemoryMessage({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center bg-bg text-sm text-text-dim">{text}</div>;
}

function workspaceRetention(workspace: MemoryWorkspace, capturePaused: boolean): RetentionSettings {
  return {
    capturePaused,
    activityDays: workspace.activityRetentionDays,
    auditDays: workspace.auditRetentionDays,
    tombstoneDays: workspace.tombstoneRetentionDays,
  };
}

async function establishCommitBaseline(workspace: MemoryWorkspace) {
  try {
    const head = (await gitIpc.run(
      workspace.canonicalRoot,
      ["rev-parse", "--verify", "HEAD"],
    )).stdout.trim();
    if (head) await memoryIpc.observeCommit(workspace.id, head);
  } catch {
    // New and non-Git projects still get working memory; the watcher will
    // establish a baseline later if the project becomes a repository.
  }
}

async function updateRetention(settings: RetentionSettings) {
  await memoryStore.getState().updateRetention(settings);
}

async function exportMemory() {
  const destination = await platform.pickFolder();
  if (destination) await exportMemoryTo(destination);
}

async function exportMemoryTo(destination: string) {
  await memoryStore.getState().exportTo(destination);
}

async function relinkMemory(workspace: MemoryWorkspace) {
  const newRoot = await platform.pickFolder();
  if (newRoot) await relinkMemoryTo(workspace, newRoot);
}

async function relinkMemoryTo(workspace: MemoryWorkspace, newRoot: string) {
  if (nativeEquals(newRoot, workspace.canonicalRoot)) return;
  if (!window.confirm(`Relink this KödMem identity to ${newRoot}?`)) return;
  await memoryStore.getState().relinkWorkspace(newRoot);
}

async function purgeMemory() {
  if (!window.confirm("Permanently purge this workspace's KödMem database records and audit history? Readable .kodade/memory files are retained in the project. This cannot be undone.")) return;
  await memoryStore.getState().purge();
}

async function forgetRecord(record: MemoryRecord) {
  if (!window.confirm(`Delete “${record.title}”?`)) return;
  await memoryStore.getState().forgetSelected();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function stripHighlight(excerpt: string): string {
  return excerpt.replaceAll("<mark>", "").replaceAll("</mark>", "");
}
