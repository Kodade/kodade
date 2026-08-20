import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  AuditEntry,
  AuditQuery,
  CheckpointSearchHit,
  DeletedMemoryQuery,
  ExportResult,
  MemoryIpc,
  MemoryKind,
  MemoryLink,
  MemoryRecord,
  MemorySearchHit,
  MemorySource,
  MemoryWorkspace,
  Page,
  RetentionSettings,
  WorkspaceContext,
  WorkspaceKnowledgeSurface,
  WorkingMemoryMode,
  WorkingMemoryStatus,
} from "../ipc/contract";

type EditableMemory = {
  kind: MemoryKind;
  title: string;
  body: string;
  pinned: boolean;
  links: MemoryLink[];
};

type NewEditableMemory = EditableMemory & {
  source?: MemorySource;
};

export type MemoryState = {
  workspace: MemoryWorkspace | null;
  context: WorkspaceContext | null;
  workingMemory: WorkingMemoryStatus | null;
  // Resolved on demand by the KödMem settings surface. Loading a workspace
  // never resolves or creates it, so existing setups stay exactly as they are.
  knowledgeSurface: WorkspaceKnowledgeSurface | null;
  // Set when resolving the surface itself failed. Kept apart from
  // `knowledgeSurface: null`, which means "this workspace has no surface" —
  // the two states read very differently in the UI.
  knowledgeSurfaceError: string | null;
  checkpoints: CheckpointSearchHit[];
  checkpointTotal: number;
  results: MemorySearchHit[];
  resultTotal: number;
  query: string;
  selected: MemoryRecord | null;
  deleted: MemoryRecord[];
  deletedTotal: number;
  audit: AuditEntry[];
  auditTotal: number;
  selectedAudit: AuditEntry[];
  selectedAuditTotal: number | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  exportResult: ExportResult | null;
  openWorkspace(root: string): Promise<MemoryWorkspace | null>;
  createWorkspace(
    root: string,
    name: string,
    color: string | null,
  ): Promise<MemoryWorkspace>;
  listWorkspaces(): Promise<MemoryWorkspace[]>;
  relinkWorkspace(newRoot: string): Promise<MemoryWorkspace | null>;
  load(workspaceId: string): Promise<void>;
  // Reload the dashboard from the shared SQLite store without resetting the
  // current inspector or search selection. KödMCP writes in another process,
  // so this is intentionally separate from initial workspace loading.
  refresh(): Promise<void>;
  activateWorking(
    mode: WorkingMemoryMode,
    exportExisting: boolean,
  ): Promise<WorkingMemoryStatus | null>;
  syncWorking(): Promise<void>;
  // Resolve the workspace knowledge surface ("vault" or "local") on demand.
  loadKnowledgeSurface(): Promise<WorkspaceKnowledgeSurface | null>;
  // Zero-setup default: enable the local surface and immediately apply its
  // scaffold (preview → apply). Returns null and sets `error` when either step
  // fails; the workspace itself stays usable and the call can be retried.
  setUpLocalKnowledge(): Promise<WorkspaceKnowledgeSurface | null>;
  // Explicit local → vault step. Files under .kodade/knowledge stay on disk.
  turnOffLocalKnowledge(): Promise<boolean>;
  // The visible KödMem settings surface owns this lifecycle: it starts polling
  // on mount and stops on unmount, while the interval stays in the store so
  // tests can prove it never runs while Settings is hidden.
  startPolling(workspaceId: string): void;
  stopPolling(): void;
  search(
    text: string,
    kinds?: MemoryKind[],
    sources?: MemorySource[],
    updatedAfter?: number | null,
  ): Promise<void>;
  loadMoreSearchResults(): Promise<void>;
  select(id: string): Promise<void>;
  createMemory(input: NewEditableMemory): Promise<MemoryRecord | null>;
  saveSelected(input: EditableMemory): Promise<void>;
  forgetSelected(): Promise<void>;
  restoreSelected(): Promise<void>;
  loadMoreDeleted(): Promise<void>;
  loadMoreSelectedAudit(): Promise<void>;
  updateRetention(settings: RetentionSettings): Promise<void>;
  exportTo(destination: string): Promise<ExportResult | null>;
  purge(): Promise<void>;
  clearSelection(): void;
  clearError(): void;
};

export function createMemoryStore(deps: {
  ipc: MemoryIpc;
  onWorkspaceLinked?: (
    workspace: MemoryWorkspace,
    previousRoot?: string,
  ) => void;
}): StoreApi<MemoryState> {
  let loadGeneration = 0;
  let searchGeneration = 0;
  let refreshGeneration = 0;
  let workspaceTransitionGeneration: number | null = null;
  let lastSearch: {
    text: string;
    kinds: MemoryKind[];
    sources: MemorySource[];
    updatedAfter: number | null;
  } | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let pollingWorkspaceId: string | null = null;
  let pollingCleanup: (() => void) | null = null;
  const pageSize = 100;

  const stopPolling = () => {
    if (refreshTimer !== null) clearInterval(refreshTimer);
    refreshTimer = null;
    pollingWorkspaceId = null;
    pollingCleanup?.();
    pollingCleanup = null;
    // A stopped pane must not accept a late dashboard response from its last
    // interval or focus refresh after another pane has taken over.
    ++refreshGeneration;
  };

  return createStore<MemoryState>((set, get) => {
    type WorkspaceScope = { generation: number; workspaceId: string };
    type RecordIntent = { scope: WorkspaceScope; generation: number };
    let recordIntentGeneration = 0;
    let activeRecordIntent: RecordIntent | null = null;
    let savingTail: Promise<void> = Promise.resolve();
    let queuedSavingOperations = 0;
    let loadMoreSearchPromise: Promise<void> | null = null;
    let activeRetentionMutation: Promise<void> | null = null;
    const retentionProvenance = {
      sourceClient: "kodade-ui",
      sessionId: null,
    } as const;
    const workspaceScope = (workspaceId?: string): WorkspaceScope | null => {
      const scopedWorkspaceId = workspaceId ?? get().workspace?.id;
      return scopedWorkspaceId
        ? { generation: loadGeneration, workspaceId: scopedWorkspaceId }
        : null;
    };
    const ownsWorkspace = (scope: WorkspaceScope) =>
      scope.generation === loadGeneration &&
      get().workspace?.id === scope.workspaceId;
    const beginRecordIntent = (workspaceId?: string): RecordIntent | null => {
      const scope = workspaceScope(workspaceId);
      if (!scope) return null;
      const intent = { scope, generation: ++recordIntentGeneration };
      activeRecordIntent = intent;
      return intent;
    };
    const invalidateRecordIntent = () => {
      ++recordIntentGeneration;
      activeRecordIntent = null;
    };
    const ownsRecordIntent = (intent: RecordIntent) =>
      ownsWorkspace(intent.scope) &&
      activeRecordIntent?.generation === intent.generation;
    const currentRecordIntent = (workspaceId: string): RecordIntent | null => {
      if (
        activeRecordIntent &&
        activeRecordIntent.scope.workspaceId === workspaceId &&
        ownsRecordIntent(activeRecordIntent)
      ) {
        return activeRecordIntent;
      }
      return beginRecordIntent(workspaceId);
    };
    const beginSaving = async (scope: WorkspaceScope) => {
      queuedSavingOperations += 1;
      set({ saving: true, error: null });
      const previous = savingTail;
      let release!: () => void;
      const turn = new Promise<void>((resolve) => {
        release = resolve;
      });
      savingTail = previous.then(() => turn, () => turn);
      await previous.catch(() => undefined);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        release();
        queuedSavingOperations -= 1;
        if (queuedSavingOperations === 0 && ownsWorkspace(scope)) {
          set({ saving: false });
        }
      };
    };
    const loadDashboard = (workspaceId: string) =>
      Promise.all([
        deps.ipc.context(workspaceId),
        deps.ipc.audit({
          workspaceId,
          targetId: null,
          limit: pageSize,
          offset: 0,
        }),
        deps.ipc.listDeleted({ workspaceId, limit: pageSize, offset: 0 }),
        Promise.resolve()
          .then(() => deps.ipc.workingStatus(workspaceId))
          .catch(() => null),
        Promise.resolve()
          .then(() => deps.ipc.searchCheckpoints({
            workspaceId,
            text: "",
            limit: 50,
            offset: 0,
          }))
          .catch(() => ({ items: [], total: 0, limit: 50, offset: 0 })),
      ]);
    const loadOpeningDashboard = async (workspaceId: string) => {
      await deps.ipc.drainRetention(workspaceId, retentionProvenance);
      return loadDashboard(workspaceId);
    };
    const waitForRetentionMutation = async () => {
      await activeRetentionMutation?.catch(() => undefined);
    };
    const beginRetentionMutation = () => {
      let release!: () => void;
      const mutation = new Promise<void>((resolve) => {
        release = resolve;
      });
      activeRetentionMutation = mutation;
      return () => {
        if (activeRetentionMutation === mutation) activeRetentionMutation = null;
        release();
      };
    };
    const refresh = async (scope: WorkspaceScope) => {
      const generation = ++refreshGeneration;
      const [context, audit, deleted, workingMemory, checkpoints] =
        await loadDashboard(scope.workspaceId);
      if (generation !== refreshGeneration || !ownsWorkspace(scope)) return null;
      set({
        workspace: context.workspace,
        context,
        workingMemory,
        checkpoints: checkpoints.items,
        checkpointTotal: checkpoints.total,
        audit: audit.items,
        auditTotal: audit.total,
        deleted: deleted.items,
        deletedTotal: deleted.total,
      });
      return context;
    };
    const loadRecordAudit = async (
      scope: WorkspaceScope,
      recordId: string,
      offset = 0,
      intent = currentRecordIntent(scope.workspaceId),
    ): Promise<Page<AuditEntry> | null> => {
      if (!intent) return null;
      const page = await deps.ipc.audit({
        workspaceId: scope.workspaceId,
        targetId: recordId,
        limit: pageSize,
        offset,
      } satisfies AuditQuery);
      if (!ownsRecordIntent(intent) || get().selected?.id !== recordId) return null;
      set((state) => ({
        selectedAudit: offset === 0
          ? page.items
          : appendUnique(state.selectedAudit, page.items),
        selectedAuditTotal: page.total,
      }));
      return page;
    };
    const refreshSearch = async (scope: WorkspaceScope) => {
      if (!ownsWorkspace(scope) || !lastSearch) return;
      await get().search(
        lastSearch.text,
        lastSearch.kinds,
        lastSearch.sources,
        lastSearch.updatedAfter,
      );
    };
    const refreshCommittedMutation = async (scope: WorkspaceScope) => {
      if (!ownsWorkspace(scope)) return false;
      await refresh(scope);
      if (!ownsWorkspace(scope)) return false;
      await refreshSearch(scope);
      return ownsWorkspace(scope);
    };

    return {
      workspace: null,
      context: null,
      workingMemory: null,
      knowledgeSurface: null,
      knowledgeSurfaceError: null,
      checkpoints: [],
      checkpointTotal: 0,
      results: [],
      resultTotal: 0,
      query: "",
      selected: null,
      deleted: [],
      deletedTotal: 0,
      audit: [],
      auditTotal: 0,
      selectedAudit: [],
      selectedAuditTotal: null,
      loading: false,
      saving: false,
      error: null,
      exportResult: null,

      async openWorkspace(root) {
        const generation = ++loadGeneration;
        ++refreshGeneration;
        invalidateRecordIntent();
        workspaceTransitionGeneration = generation;
        ++searchGeneration;
        loadMoreSearchPromise = null;
        lastSearch = null;
        set({
          loading: true,
          error: null,
          selected: null,
          results: [],
          resultTotal: 0,
          query: "",
          exportResult: null,
          saving: false,
        });
        try {
          await waitForRetentionMutation();
          if (generation !== loadGeneration) return null;
          const workspace = await deps.ipc.resolveWorkspace(root);
          if (generation !== loadGeneration) return null;
          if (!workspace) {
            set({
              workspace: null,
              context: null,
              workingMemory: null,
              knowledgeSurface: null,
              knowledgeSurfaceError: null,
              checkpoints: [],
              checkpointTotal: 0,
              deleted: [],
              deletedTotal: 0,
              audit: [],
              auditTotal: 0,
              selectedAudit: [],
              selectedAuditTotal: null,
            });
            return null;
          }
          const [context, audit, deleted, workingMemory, checkpoints] =
            await loadOpeningDashboard(workspace.id);
          if (generation !== loadGeneration) return null;
          set({
            workspace: context.workspace,
            context,
            workingMemory,
            // Never carried across a workspace switch; the settings surface
            // resolves it again for the workspace it is showing.
            knowledgeSurface: null,
            knowledgeSurfaceError: null,
            checkpoints: checkpoints.items,
            checkpointTotal: checkpoints.total,
            audit: audit.items,
            auditTotal: audit.total,
            deleted: deleted.items,
            deletedTotal: deleted.total,
            selectedAudit: [],
            selectedAuditTotal: null,
          });
          deps.onWorkspaceLinked?.(context.workspace);
          return workspace;
        } catch (error) {
          if (generation === loadGeneration)
            set({ error: errorMessage(error) });
          throw error;
        } finally {
          if (generation === loadGeneration) {
            workspaceTransitionGeneration = null;
            set({ loading: false });
          }
        }
      },

      async createWorkspace(root, name, color) {
        const generation = ++loadGeneration;
        ++refreshGeneration;
        invalidateRecordIntent();
        workspaceTransitionGeneration = generation;
        ++searchGeneration;
        loadMoreSearchPromise = null;
        set({ loading: true, saving: false, error: null });
        try {
          await waitForRetentionMutation();
          const workspace = await deps.ipc.registerWorkspace(root, name, color);
          const [context, audit, deleted, workingMemory, checkpoints] =
            await loadOpeningDashboard(workspace.id);
          if (generation === loadGeneration) {
            set({
              workspace: context.workspace,
              context,
              workingMemory,
              knowledgeSurface: null,
              knowledgeSurfaceError: null,
              checkpoints: checkpoints.items,
              checkpointTotal: checkpoints.total,
              audit: audit.items,
              auditTotal: audit.total,
              deleted: deleted.items,
              deletedTotal: deleted.total,
              selectedAudit: [],
              selectedAuditTotal: null,
            });
            deps.onWorkspaceLinked?.(context.workspace);
          }
          return workspace;
        } catch (error) {
          if (generation === loadGeneration)
            set({ error: errorMessage(error) });
          throw error;
        } finally {
          if (generation === loadGeneration) {
            workspaceTransitionGeneration = null;
            set({ loading: false });
          }
        }
      },

      async listWorkspaces() {
        try {
          return await deps.ipc.listWorkspaces();
        } catch (error) {
          set({ error: errorMessage(error) });
          return [];
        }
      },

      async relinkWorkspace(newRoot) {
        const current = get().workspace;
        if (!current) return null;
        const scope = workspaceScope(current.id);
        if (!scope) return null;
        const finishSaving = await beginSaving(scope);
        try {
          const workspace = await deps.ipc.relinkWorkspace(
            current.id,
            current.canonicalRoot,
            newRoot,
            "kodade-ui",
          );
          deps.onWorkspaceLinked?.(workspace, current.canonicalRoot);
          if (!ownsWorkspace(scope)) return null;
          await refresh(scope);
          if (!ownsWorkspace(scope)) return null;
          return workspace;
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
          return null;
        } finally {
          finishSaving();
        }
      },

      async load(workspaceId) {
        const generation = ++loadGeneration;
        ++refreshGeneration;
        invalidateRecordIntent();
        workspaceTransitionGeneration = generation;
        ++searchGeneration;
        loadMoreSearchPromise = null;
        lastSearch = null;
        set({
          loading: true,
          error: null,
          selected: null,
          results: [],
          resultTotal: 0,
          query: "",
          deleted: [],
          deletedTotal: 0,
          audit: [],
          auditTotal: 0,
          selectedAudit: [],
          selectedAuditTotal: null,
          exportResult: null,
          saving: false,
        });
        try {
          await waitForRetentionMutation();
          if (generation !== loadGeneration) return;
          const [context, audit, deleted, workingMemory, checkpoints] =
            await loadOpeningDashboard(workspaceId);
          if (generation !== loadGeneration) return;
          set({
            workspace: context.workspace,
            context,
            workingMemory,
            knowledgeSurface: null,
            knowledgeSurfaceError: null,
            checkpoints: checkpoints.items,
            checkpointTotal: checkpoints.total,
            audit: audit.items,
            auditTotal: audit.total,
            deleted: deleted.items,
            deletedTotal: deleted.total,
            selectedAudit: [],
            selectedAuditTotal: null,
          });
        } catch (error) {
          if (generation === loadGeneration)
            set({ error: errorMessage(error) });
        } finally {
          if (generation === loadGeneration) {
            workspaceTransitionGeneration = null;
            set({ loading: false });
          }
        }
      },

      async refresh() {
        const scope = workspaceScope();
        if (!scope || workspaceTransitionGeneration === loadGeneration) return;
        try {
          await refresh(scope);
          if (!ownsWorkspace(scope)) return;
          await refreshSearch(scope);
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
        }
      },

      async activateWorking(mode, exportExisting) {
        const scope = workspaceScope();
        if (!scope) return null;
        const finishSaving = await beginSaving(scope);
        try {
          const workingMemory = await deps.ipc.activateWorking(
            scope.workspaceId,
            mode,
            exportExisting,
          );
          if (!ownsWorkspace(scope)) return null;
          await refresh(scope);
          return workingMemory;
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
          return null;
        } finally {
          finishSaving();
        }
      },

      async syncWorking() {
        const scope = workspaceScope();
        if (!scope) return;
        const finishSaving = await beginSaving(scope);
        try {
          await deps.ipc.syncWorking(scope.workspaceId);
          if (ownsWorkspace(scope)) await refresh(scope);
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
        } finally {
          finishSaving();
        }
      },

      async loadKnowledgeSurface() {
        const scope = workspaceScope();
        if (!scope) return null;
        try {
          const surface = await deps.ipc.workspaceKnowledgeSurface(
            scope.workspaceId,
          );
          if (!ownsWorkspace(scope)) return null;
          set({ knowledgeSurface: surface, knowledgeSurfaceError: null });
          return surface;
        } catch (error) {
          // A failed resolve is not "no surface": keep the two apart so the UI
          // never offers a setup action to a workspace that may already have
          // one.
          if (ownsWorkspace(scope)) {
            set({
              error: errorMessage(error),
              knowledgeSurface: null,
              knowledgeSurfaceError: errorMessage(error),
            });
          }
          return null;
        }
      },

      async setUpLocalKnowledge() {
        const scope = workspaceScope();
        if (!scope) return null;
        const finishSaving = await beginSaving(scope);
        try {
          // Enabling is idempotent, so a retry after a scaffold failure picks
          // up the surface that already exists and only re-applies the plan.
          const surface = await deps.ipc.enableLocalKnowledge(
            scope.workspaceId,
          );
          // Published before the scaffold runs: once the surface exists, the
          // workspace really is local, even if creating its files then fails.
          if (ownsWorkspace(scope)) {
            set({ knowledgeSurface: surface, knowledgeSurfaceError: null });
          }
          const plan = await deps.ipc.previewProjectScaffold(scope.workspaceId);
          if (plan.operations.length > 0) {
            await deps.ipc.applyProjectScaffold(
              scope.workspaceId,
              plan.fingerprint,
            );
          }
          if (!ownsWorkspace(scope)) return null;
          return surface;
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
          return null;
        } finally {
          finishSaving();
        }
      },

      async turnOffLocalKnowledge() {
        const scope = workspaceScope();
        if (!scope) return false;
        const finishSaving = await beginSaving(scope);
        try {
          await deps.ipc.disableLocalKnowledge(scope.workspaceId);
          if (ownsWorkspace(scope)) set({ knowledgeSurface: null });
          return true;
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
          return false;
        } finally {
          finishSaving();
        }
      },

      startPolling(workspaceId) {
        stopPolling();
        pollingWorkspaceId = workspaceId;
        const doc = typeof document === "undefined" ? null : document;
        const win = typeof window === "undefined" ? null : window;
        let windowFocused = true;
        const refreshVisibleWorkspace = () => {
          if (
            pollingWorkspaceId !== workspaceId ||
            get().workspace?.id !== workspaceId ||
            !windowFocused ||
            doc?.visibilityState === "hidden"
          ) {
            return;
          }
          void get().refresh();
        };
        const onVisibilityChange = () => {
          if (doc?.visibilityState !== "hidden") refreshVisibleWorkspace();
        };
        const onBlur = () => {
          windowFocused = false;
        };
        const onFocus = () => {
          windowFocused = true;
          refreshVisibleWorkspace();
        };
        doc?.addEventListener("visibilitychange", onVisibilityChange);
        win?.addEventListener("blur", onBlur);
        win?.addEventListener("focus", onFocus);
        pollingCleanup = () => {
          doc?.removeEventListener("visibilitychange", onVisibilityChange);
          win?.removeEventListener("blur", onBlur);
          win?.removeEventListener("focus", onFocus);
        };
        refreshVisibleWorkspace();
        refreshTimer = setInterval(refreshVisibleWorkspace, 5_000);
      },

      stopPolling() {
        stopPolling();
      },

      async search(text, kinds = [], sources = [], updatedAfter = null) {
        const workspaceId = get().workspace?.id;
        if (!workspaceId) return;
        if (workspaceTransitionGeneration === loadGeneration) return;
        lastSearch = {
          text,
          kinds: [...kinds],
          sources: [...sources],
          updatedAfter,
        };
        loadMoreSearchPromise = null;
        const generation = ++searchGeneration;
        set({ query: text, loading: true, error: null });
        try {
          const page = await deps.ipc.search({
            workspaceId,
            text,
            kinds,
            sources,
            updatedAfter,
            limit: 100,
            offset: 0,
          });
          if (
            generation !== searchGeneration ||
            get().workspace?.id !== workspaceId
          )
            return;
          set({ results: page.items, resultTotal: page.total });
        } catch (error) {
          if (
            generation === searchGeneration &&
            get().workspace?.id === workspaceId
          ) {
            set({ error: errorMessage(error) });
          }
        } finally {
          if (
            generation === searchGeneration &&
            get().workspace?.id === workspaceId
          ) {
            set({ loading: false });
          }
        }
      },

      loadMoreSearchResults() {
        if (loadMoreSearchPromise) return loadMoreSearchPromise;
        const operation = (async () => {
          const scope = workspaceScope();
          const search = lastSearch;
          const state = get();
          if (
            !scope ||
            !search ||
            state.loading ||
            workspaceTransitionGeneration === loadGeneration ||
            state.results.length >= state.resultTotal
          ) {
            return;
          }
          const generation = searchGeneration;
          const offset = state.results.length;
          try {
            const page = await deps.ipc.search({
              workspaceId: scope.workspaceId,
              text: search.text,
              kinds: search.kinds,
              sources: search.sources,
              updatedAfter: search.updatedAfter,
              limit: pageSize,
              offset,
            });
            if (generation !== searchGeneration || !ownsWorkspace(scope)) return;
            const current = get();
            const combined = appendUnique(current.results, page.items);
            const pageShifted =
              page.total !== state.resultTotal ||
              combined.length !== current.results.length + page.items.length;
            if (pageShifted) {
              await get().search(
                search.text,
                search.kinds,
                search.sources,
                search.updatedAfter,
              );
              return;
            }
            set({ results: combined, resultTotal: page.total });
          } catch (error) {
            if (generation === searchGeneration && ownsWorkspace(scope)) {
              set({ error: errorMessage(error) });
            }
          }
        })();
        loadMoreSearchPromise = operation;
        return operation.finally(() => {
          if (loadMoreSearchPromise === operation) loadMoreSearchPromise = null;
        });
      },

      async select(id) {
        const scope = workspaceScope();
        if (!scope) return;
        const intent = beginRecordIntent(scope.workspaceId);
        if (!intent) return;
        set({ loading: true, error: null });
        try {
          const selected = await deps.ipc.get(id);
          if (
            ownsRecordIntent(intent) &&
            selected.workspaceId === scope.workspaceId
          ) {
            set({ selected, selectedAudit: [], selectedAuditTotal: null });
            await loadRecordAudit(scope, selected.id, 0, intent);
          }
        } catch (error) {
          if (ownsRecordIntent(intent)) set({ error: errorMessage(error) });
        } finally {
          if (ownsRecordIntent(intent)) set({ loading: false });
        }
      },

      async createMemory(input) {
        const workspaceId = get().workspace?.id;
        if (!workspaceId) return null;
        const scope = workspaceScope(workspaceId);
        if (!scope) return null;
        const intent = beginRecordIntent(workspaceId);
        if (!intent) return null;
        const finishSaving = await beginSaving(scope);
        try {
          if (!ownsWorkspace(scope)) return null;
          const created = await deps.ipc.remember({
            workspaceId,
            kind: input.kind,
            title: input.title,
            body: input.body,
            source: input.source ?? "user",
            sourceClient: "kodade-ui",
            sessionId: null,
            pinned: input.pinned,
            idempotencyKey: null,
            links: input.links,
          });
          if (!ownsWorkspace(scope)) return null;
          await refreshCommittedMutation(scope);
          if (!ownsRecordIntent(intent)) return null;
          set({ selected: created });
          await loadRecordAudit(scope, created.id, 0, intent);
          return created;
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
          return null;
        } finally {
          finishSaving();
        }
      },

      async saveSelected(input) {
        const selected = get().selected;
        if (!selected || selected.deletedAt !== null) return;
        const scope = workspaceScope(selected.workspaceId);
        if (!scope) return;
        const intent = beginRecordIntent(selected.workspaceId);
        if (!intent) return;
        const finishSaving = await beginSaving(scope);
        try {
          if (!ownsWorkspace(scope)) return;
          const revision = {
            id: selected.id,
            expectedVersion: selected.version,
            kind: input.kind,
            title: input.title,
            body: input.body,
            pinned: input.pinned,
            sourceClient: "kodade-ui",
            sessionId: null,
            links: input.links,
          };
          const revised = selected.projectSource
            ? await deps.ipc.revise(revision, selected.projectSource.sha256)
            : await deps.ipc.revise(revision);
          if (!ownsWorkspace(scope)) return;
          await refreshCommittedMutation(scope);
          if (!ownsRecordIntent(intent)) return;
          set({ selected: revised });
          await loadRecordAudit(scope, revised.id, 0, intent);
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
        } finally {
          finishSaving();
        }
      },

      async forgetSelected() {
        const selected = get().selected;
        if (!selected || selected.deletedAt !== null) return;
        const scope = workspaceScope(selected.workspaceId);
        if (!scope) return;
        const intent = beginRecordIntent(selected.workspaceId);
        if (!intent) return;
        const finishSaving = await beginSaving(scope);
        try {
          if (!ownsWorkspace(scope)) return;
          if (selected.projectSource) {
            await deps.ipc.forget(
              selected.id,
              selected.version,
              "kodade-ui",
              null,
              selected.projectSource.sha256,
            );
          } else {
            await deps.ipc.forget(selected.id, selected.version, "kodade-ui", null);
          }
          if (!ownsWorkspace(scope)) return;
          const deleted = ownsRecordIntent(intent)
            ? await deps.ipc.get(selected.id)
            : null;
          await refreshCommittedMutation(scope);
          if (!ownsRecordIntent(intent)) return;
          const retained = deleted ?? await deps.ipc.get(selected.id);
          if (!ownsRecordIntent(intent)) return;
          set({ selected: retained });
          await loadRecordAudit(scope, retained.id, 0, intent);
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
        } finally {
          finishSaving();
        }
      },

      async restoreSelected() {
        const selected = get().selected;
        if (!selected || selected.deletedAt === null) return;
        const scope = workspaceScope(selected.workspaceId);
        if (!scope) return;
        const intent = beginRecordIntent(selected.workspaceId);
        if (!intent) return;
        const finishSaving = await beginSaving(scope);
        try {
          if (!ownsWorkspace(scope)) return;
          const restored = selected.projectSource
            ? await deps.ipc.restore(
                selected.id,
                selected.version,
                "kodade-ui",
                null,
                selected.projectSource.sha256,
              )
            : await deps.ipc.restore(selected.id, selected.version, "kodade-ui", null);
          if (!ownsWorkspace(scope)) return;
          await refreshCommittedMutation(scope);
          if (!ownsRecordIntent(intent)) return;
          set({ selected: restored });
          await loadRecordAudit(scope, restored.id, 0, intent);
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
        } finally {
          finishSaving();
        }
      },

      async loadMoreDeleted() {
        const scope = workspaceScope();
        if (!scope) return;
        const state = get();
        if (state.deleted.length >= state.deletedTotal) return;
        try {
          const page = await deps.ipc.listDeleted({
            workspaceId: scope.workspaceId,
            limit: pageSize,
            offset: state.deleted.length,
          } satisfies DeletedMemoryQuery);
          if (!ownsWorkspace(scope)) return;
          set((current) => ({
            deleted: appendUnique(current.deleted, page.items),
            deletedTotal: page.total,
          }));
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
        }
      },

      async loadMoreSelectedAudit() {
        const selected = get().selected;
        if (!selected) return;
        const scope = workspaceScope(selected.workspaceId);
        if (!scope) return;
        const intent = currentRecordIntent(selected.workspaceId);
        if (!intent) return;
        const state = get();
        if (
          state.selectedAuditTotal === null ||
          state.selectedAudit.length >= state.selectedAuditTotal
        ) {
          return;
        }
        try {
          await loadRecordAudit(scope, selected.id, state.selectedAudit.length, intent);
        } catch (error) {
          if (ownsRecordIntent(intent)) set({ error: errorMessage(error) });
        }
      },

      async updateRetention(settings) {
        if (workspaceTransitionGeneration === loadGeneration) return;
        const workspaceId = get().workspace?.id;
        if (!workspaceId) return;
        const scope = workspaceScope(workspaceId);
        if (!scope) return;
        const currentSelection = get().selected;
        const selectedTombstone =
          currentSelection?.deletedAt != null ? currentSelection : null;
        const intent = selectedTombstone
          ? beginRecordIntent(selectedTombstone.workspaceId)
          : null;
        const finishSaving = await beginSaving(scope);
        let finishRetentionMutation: (() => void) | null = null;
        try {
          if (!ownsWorkspace(scope)) return;
          finishRetentionMutation = beginRetentionMutation();
          const workspace = await deps.ipc.setRetention(
            workspaceId,
            settings,
            retentionProvenance,
          );
          if (!ownsWorkspace(scope)) return;
          set((state) => ({
            workspace,
            context: state.context ? { ...state.context, workspace } : null,
          }));
          await deps.ipc.drainRetention(workspaceId, retentionProvenance);
          if (!ownsWorkspace(scope)) return;
          await refresh(scope);
          if (!ownsWorkspace(scope)) return;
          if (
            selectedTombstone &&
            get().selected?.id === selectedTombstone.id
          ) {
            try {
              const retained = await deps.ipc.get(selectedTombstone.id);
              if (intent && ownsRecordIntent(intent)) {
                set({ selected: retained });
                await loadRecordAudit(scope, retained.id, 0, intent);
              }
            } catch {
              if (intent && ownsRecordIntent(intent)) set({ selected: null });
            }
          }
          await refreshSearch(scope);
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
        } finally {
          finishRetentionMutation?.();
          finishSaving();
        }
      },

      async exportTo(destination) {
        const workspaceId = get().workspace?.id;
        if (!workspaceId) return null;
        const scope = workspaceScope(workspaceId);
        if (!scope) return null;
        const finishSaving = await beginSaving(scope);
        if (ownsWorkspace(scope)) set({ exportResult: null });
        try {
          if (!ownsWorkspace(scope)) return null;
          const exportResult = await deps.ipc.exportToDirectory(
            workspaceId,
            destination,
          );
          if (!ownsWorkspace(scope)) return null;
          set({ exportResult });
          return exportResult;
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
          return null;
        } finally {
          finishSaving();
        }
      },

      async purge() {
        const workspaceId = get().workspace?.id;
        if (!workspaceId) return;
        const scope = workspaceScope(workspaceId);
        if (!scope) return;
        const finishSaving = await beginSaving(scope);
        try {
          if (!ownsWorkspace(scope)) return;
          await deps.ipc.purgeWorkspace(workspaceId);
          if (!ownsWorkspace(scope)) return;
          invalidateRecordIntent();
          ++loadGeneration;
          workspaceTransitionGeneration = null;
          ++searchGeneration;
          loadMoreSearchPromise = null;
          lastSearch = null;
          set({
            workspace: null,
            context: null,
            results: [],
            resultTotal: 0,
            selected: null,
            deleted: [],
            deletedTotal: 0,
            audit: [],
            auditTotal: 0,
            selectedAudit: [],
            selectedAuditTotal: null,
            saving: false,
          });
        } catch (error) {
          if (ownsWorkspace(scope)) set({ error: errorMessage(error) });
        } finally {
          finishSaving();
        }
      },

      clearSelection() {
        invalidateRecordIntent();
        set({ selected: null, selectedAudit: [], selectedAuditTotal: null });
      },
      clearError() {
        set({ error: null });
      },
    };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendUnique<T extends { id: string }>(existing: T[], next: T[]): T[] {
  const ids = new Set(existing.map((item) => item.id));
  return [...existing, ...next.filter((item) => !ids.has(item.id))];
}
