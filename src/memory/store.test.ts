import { describe, expect, it, vi } from "vitest";
import type {
  MemoryIpc,
  MemoryRecord,
  MemoryWorkspace,
  WorkspaceContext,
} from "../ipc/contract";
import { createMemoryStore } from "./store";

const workspace: MemoryWorkspace = {
  id: "ws_1",
  canonicalRoot: "C:\\Work\\Ködade",
  displayName: "Ködade",
  color: "mauve",
  capturePaused: false,
  activityRetentionDays: 30,
  auditRetentionDays: 30,
  tombstoneRetentionDays: 30,
  createdAt: 1,
  updatedAt: 1,
};

const decision: MemoryRecord = {
  id: "mem_1",
  workspaceId: "ws_1",
  kind: "decision",
  title: "Use SQLite",
  body: "Keep memory local.",
  source: "user",
  sourceClient: "kodade-ui",
  sessionId: null,
  pinned: true,
  version: 1,
  createdAt: 2,
  updatedAt: 2,
  deletedAt: null,
  links: [],
  backlinks: [],
};

const context: WorkspaceContext = {
  workspace,
  latestCheckpoint: null,
  pinnedDecisions: [decision],
  openTasks: [],
  recentMemories: [decision],
  workingMemory: null,
};

function mockMemoryIpc(): MemoryIpc {
  return {
    registerWorkspace: vi.fn().mockResolvedValue(workspace),
    resolveWorkspace: vi.fn().mockResolvedValue(workspace),
    listWorkspaces: vi.fn().mockResolvedValue([workspace]),
    relinkWorkspace: vi.fn().mockResolvedValue(workspace),
    projectsVault: vi.fn().mockResolvedValue(null),
    registerProjectsVault: vi.fn(),
    workspaceProjectMapping: vi.fn().mockResolvedValue(null),
    workspaceKnowledgeSurface: vi.fn().mockResolvedValue(null),
    enableLocalKnowledge: vi.fn(),
    disableLocalKnowledge: vi.fn(),
    mapWorkspaceToProject: vi.fn(),
    projectWorkspaceMappings: vi.fn().mockResolvedValue([]),
    previewProjectScaffold: vi.fn(),
    applyProjectScaffold: vi.fn(),
    previewLegacyMigration: vi.fn(),
    applyLegacyMigration: vi.fn(),
    rollbackLegacyMigration: vi.fn(),
    openProjectInObsidian: vi.fn(),
    context: vi.fn().mockResolvedValue(context),
    search: vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
    get: vi.fn().mockResolvedValue(decision),
    listDeleted: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }),
    remember: vi.fn().mockResolvedValue(decision),
    revise: vi.fn().mockResolvedValue({ ...decision, version: 2 }),
    forget: vi.fn().mockResolvedValue({
      id: decision.id,
      workspaceId: workspace.id,
      version: 2,
      deletedAt: 3,
    }),
    restore: vi.fn().mockResolvedValue({ ...decision, version: 3 }),
    checkpoint: vi.fn(),
    searchCheckpoints: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }),
    workingStatus: vi.fn().mockResolvedValue(null),
    activateWorking: vi.fn(),
    syncWorking: vi.fn().mockResolvedValue(0),
    observeCommit: vi.fn().mockResolvedValue(null),
    audit: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }),
    setRetention: vi.fn().mockResolvedValue(workspace),
    runRetention: vi.fn().mockResolvedValue({
      activityDeleted: 0,
      auditDeleted: 0,
      tombstonesDeleted: 0,
    }),
    drainRetention: vi.fn().mockResolvedValue({
      activityDeleted: 0,
      auditDeleted: 0,
      tombstonesDeleted: 0,
    }),
    exportToDirectory: vi
      .fn()
      .mockResolvedValue({
        markdownPath: "/out/a.md",
        jsonPath: "/out/a.json",
      }),
    purgeWorkspace: vi.fn().mockResolvedValue(undefined),
    recordActivity: vi.fn().mockResolvedValue(null),
    mcpBinaryPath: vi.fn().mockResolvedValue({ path: null, exists: false }),
    mcpHealth: vi.fn(),
    databasePath: vi.fn().mockResolvedValue("/app-data/kodade-memory.sqlite3"),
  };
}

describe("memory store", () => {
  it("resolves the workspace knowledge surface without loading it implicitly", async () => {
    const ipc = mockMemoryIpc();
    const surface = {
      workspaceId: workspace.id,
      mode: "local" as const,
      projectId: "kodade",
      projectDisplayName: "Ködade",
      knowledgeRoot: "/work/kodade/.kodade/knowledge",
      createdAt: 1,
      updatedAt: 2,
    };
    ipc.workspaceKnowledgeSurface = vi.fn().mockResolvedValue(surface);
    const store = createMemoryStore({ ipc });

    await store.getState().openWorkspace("/work/kodade");
    // Opening a workspace must not touch the knowledge surface in this slice.
    expect(ipc.workspaceKnowledgeSurface).not.toHaveBeenCalled();
    expect(store.getState().knowledgeSurface).toBeNull();

    expect(await store.getState().loadKnowledgeSurface()).toEqual(surface);
    expect(ipc.workspaceKnowledgeSurface).toHaveBeenCalledWith(workspace.id);
    expect(store.getState().knowledgeSurface).toEqual(surface);
  });

  it("activates project working memory and refreshes its timeline", async () => {
    const ipc = mockMemoryIpc();
    const working = {
      enabled: true,
      mode: "commit" as const,
      directory: ".kodade/memory",
      statePath: ".kodade/memory/STATE.md",
      worklogPath: ".kodade/memory/WORKLOG.md",
      decisionsPath: ".kodade/memory/decisions.md",
      lastIndexedAt: 100,
      lastCommit: null,
    };
    const checkpoint = {
      id: "cp_working",
      workspaceId: workspace.id,
      summary: "Working memory activated",
      excerpt: "Working memory activated",
      source: "kodade" as const,
      sourceClient: "kodade-ui",
      sessionId: null,
      createdAt: 100,
    };
    vi.mocked(ipc.activateWorking).mockResolvedValue(working);
    vi.mocked(ipc.workingStatus).mockResolvedValue(working);
    vi.mocked(ipc.searchCheckpoints).mockResolvedValue({
      items: [checkpoint],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);

    await expect(store.getState().activateWorking("commit", true)).resolves.toEqual(
      working,
    );

    expect(ipc.activateWorking).toHaveBeenCalledWith(workspace.id, "commit", true);
    expect(store.getState().workingMemory).toEqual(working);
    expect(store.getState().checkpoints).toEqual([checkpoint]);
  });

  it("lists stored workspace identities for moved-project recovery", async () => {
    const ipc = mockMemoryIpc();
    const store = createMemoryStore({ ipc });

    await expect(store.getState().listWorkspaces()).resolves.toEqual([
      workspace,
    ]);
    expect(ipc.listWorkspaces).toHaveBeenCalledOnce();
  });

  it("pauses polling while hidden or blurred, then refreshes once when visible again", async () => {
    vi.useFakeTimers();
    const visibility = { state: "visible" as DocumentVisibilityState };
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility.state,
    });
    try {
      const ipc = mockMemoryIpc();
      const store = createMemoryStore({ ipc });
      await store.getState().load(workspace.id);
      vi.mocked(ipc.context).mockClear();
      vi.mocked(ipc.audit).mockClear();
      vi.mocked(ipc.listDeleted).mockClear();

      store.getState().startPolling(workspace.id);
      await Promise.resolve();
      await Promise.resolve();
      expect(ipc.context).toHaveBeenCalledTimes(1);
      expect(ipc.audit).toHaveBeenCalledTimes(1);
      expect(ipc.listDeleted).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(ipc.context).toHaveBeenCalledTimes(2);

      visibility.state = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ipc.context).toHaveBeenCalledTimes(2);

      visibility.state = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
      expect(ipc.context).toHaveBeenCalledTimes(3);

      window.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ipc.context).toHaveBeenCalledTimes(3);

      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
      expect(ipc.context).toHaveBeenCalledTimes(4);

      store.getState().stopPolling();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(ipc.context).toHaveBeenCalledTimes(4);
    } finally {
      if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
      vi.useRealTimers();
    }
  });

  it("keeps the newer dashboard when overlapping refresh responses resolve out of order", async () => {
    const ipc = mockMemoryIpc();
    const older = deferred<WorkspaceContext>();
    const newer = deferred<WorkspaceContext>();
    const olderWorkspace = { ...workspace, displayName: "Older snapshot" };
    const newerWorkspace = { ...workspace, displayName: "Newer snapshot" };
    vi.mocked(ipc.context)
      .mockResolvedValueOnce(context)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);

    const first = store.getState().refresh();
    await Promise.resolve();
    const second = store.getState().refresh();
    newer.resolve({ ...context, workspace: newerWorkspace });
    await second;
    older.resolve({ ...context, workspace: olderWorkspace });
    await first;

    expect(store.getState().workspace).toEqual(newerWorkspace);
    expect(store.getState().context?.workspace).toEqual(newerWorkspace);
  });

  it("drains expired metadata before loading a paused workspace dashboard", async () => {
    const events: string[] = [];
    const pausedWorkspace = { ...workspace, capturePaused: true };
    const ipc = mockMemoryIpc();
    vi.mocked(ipc.drainRetention).mockImplementation(async () => {
      events.push("retention");
      return { activityDeleted: 1, auditDeleted: 2, tombstonesDeleted: 1 };
    });
    vi.mocked(ipc.context).mockImplementation(async () => {
      events.push("context");
      return { ...context, workspace: pausedWorkspace };
    });
    vi.mocked(ipc.audit).mockImplementation(async () => {
      events.push("audit");
      return { items: [], total: 0, limit: 100, offset: 0 };
    });
    vi.mocked(ipc.listDeleted).mockImplementation(async () => {
      events.push("deleted");
      return { items: [], total: 0, limit: 100, offset: 0 };
    });
    const store = createMemoryStore({ ipc });

    await store.getState().load(pausedWorkspace.id);

    expect(ipc.drainRetention).toHaveBeenCalledWith(pausedWorkspace.id, {
      sourceClient: "kodade-ui",
      sessionId: null,
    });
    expect(events[0]).toBe("retention");
    expect(store.getState().workspace).toEqual(pausedWorkspace);
  });

  it("resolves a registered native path unchanged and loads the workspace Hub", async () => {
    const ipc = mockMemoryIpc();
    const store = createMemoryStore({ ipc });

    const opened = await store.getState().openWorkspace("C:\\Work\\Ködade");

    expect(opened).toEqual(workspace);
    expect(ipc.resolveWorkspace).toHaveBeenCalledWith("C:\\Work\\Ködade");
    expect(ipc.registerWorkspace).not.toHaveBeenCalled();
    expect(ipc.context).toHaveBeenCalledWith("ws_1");
    expect(store.getState().context?.pinnedDecisions[0].title).toBe(
      "Use SQLite",
    );
    expect(store.getState().error).toBeNull();
  });

  it("creates an unregistered workspace only after the explicit create action", async () => {
    const ipc = mockMemoryIpc();
    vi.mocked(ipc.resolveWorkspace).mockResolvedValue(null);
    const store = createMemoryStore({ ipc });

    const unresolved = await store
      .getState()
      .openWorkspace("D:\\Moved\\Ködade");

    expect(unresolved).toBeNull();
    expect(ipc.registerWorkspace).not.toHaveBeenCalled();

    const created = await store
      .getState()
      .createWorkspace("D:\\Moved\\Ködade", "Ködade", "mauve");

    expect(created).toEqual(workspace);
    expect(ipc.registerWorkspace).toHaveBeenCalledWith(
      "D:\\Moved\\Ködade",
      "Ködade",
      "mauve",
    );
  });

  it("relinks the loaded workspace only through the explicit identity action", async () => {
    const ipc = mockMemoryIpc();
    const moved = {
      ...workspace,
      canonicalRoot: "D:\\Moved\\Ködade",
      updatedAt: 2,
    };
    vi.mocked(ipc.relinkWorkspace).mockResolvedValue(moved);
    vi.mocked(ipc.context)
      .mockResolvedValueOnce(context)
      .mockResolvedValue({ ...context, workspace: moved });
    const onWorkspaceLinked = vi.fn();
    const store = createMemoryStore({ ipc, onWorkspaceLinked });
    await store.getState().load(workspace.id);

    const relinked = await store
      .getState()
      .relinkWorkspace("D:\\Moved\\Ködade");

    expect(ipc.relinkWorkspace).toHaveBeenCalledWith(
      workspace.id,
      workspace.canonicalRoot,
      "D:\\Moved\\Ködade",
      "kodade-ui",
    );
    expect(relinked).toEqual(moved);
    expect(store.getState().workspace).toEqual(moved);
    expect(onWorkspaceLinked).toHaveBeenCalledWith(
      moved,
      workspace.canonicalRoot,
    );
  });

  it("saves edits with the selected record version and refreshes the Hub", async () => {
    const ipc = mockMemoryIpc();
    const revised = { ...decision, title: "Use WAL SQLite", version: 2 };
    vi.mocked(ipc.revise).mockResolvedValue(revised);
    vi.mocked(ipc.context).mockResolvedValue({
      ...context,
      pinnedDecisions: [revised],
      recentMemories: [revised],
    });
    const store = createMemoryStore({ ipc });
    await store.getState().load("ws_1");
    await store.getState().select("mem_1");

    await store.getState().saveSelected({
      kind: "decision",
      title: "Use WAL SQLite",
      body: "Keep memory local and concurrent.",
      pinned: true,
      links: [],
    });

    expect(ipc.revise).toHaveBeenCalledWith({
      id: "mem_1",
      expectedVersion: 1,
      kind: "decision",
      title: "Use WAL SQLite",
      body: "Keep memory local and concurrent.",
      pinned: true,
      sourceClient: "kodade-ui",
      sessionId: null,
      links: [],
    });
    expect(store.getState().selected?.version).toBe(2);
    expect(store.getState().context?.pinnedDecisions[0].title).toBe(
      "Use WAL SQLite",
    );
  });

  it("clears workspace-scoped selection and search state when opening another workspace", async () => {
    const ipc = mockMemoryIpc();
    const otherWorkspace = {
      ...workspace,
      id: "ws_2",
      canonicalRoot: "D:\\Work\\Other",
      displayName: "Other",
    };
    const otherContext = {
      ...context,
      workspace: otherWorkspace,
      pinnedDecisions: [],
      recentMemories: [],
    };
    vi.mocked(ipc.search).mockResolvedValue({
      items: [{ ...decision, excerpt: "Keep memory local." }],
      total: 1,
      limit: 100,
      offset: 0,
    });
    const store = createMemoryStore({ ipc });
    await store.getState().load("ws_1");
    await store.getState().select("mem_1");
    await store.getState().search("SQLite");
    vi.mocked(ipc.resolveWorkspace).mockResolvedValue(otherWorkspace);
    vi.mocked(ipc.context).mockResolvedValue(otherContext);

    await store.getState().openWorkspace("D:\\Work\\Other");

    expect(store.getState().workspace?.id).toBe("ws_2");
    expect(store.getState().selected).toBeNull();
    expect(store.getState().results).toEqual([]);
    expect(store.getState().resultTotal).toBe(0);
    expect(store.getState().query).toBe("");
  });

  it("refreshes an active filtered search after deleting its selected record", async () => {
    const ipc = mockMemoryIpc();
    vi.mocked(ipc.search)
      .mockResolvedValueOnce({
        items: [{ ...decision, excerpt: "Keep memory local." }],
        total: 1,
        limit: 100,
        offset: 0,
      })
      .mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 });
    const store = createMemoryStore({ ipc });
    await store.getState().load("ws_1");
    await store.getState().select("mem_1");
    await store.getState().search("", ["decision"]);

    await store.getState().forgetSelected();

    expect(ipc.search).toHaveBeenCalledTimes(2);
    expect(ipc.search).toHaveBeenLastCalledWith({
      workspaceId: "ws_1",
      text: "",
      kinds: ["decision"],
      sources: [],
      updatedAfter: null,
      limit: 100,
      offset: 0,
    });
    expect(store.getState().results).toEqual([]);
  });

  it("keeps a deleted record selected so its forget audit remains inspectable", async () => {
    const ipc = mockMemoryIpc();
    const deleted = {
      ...decision,
      version: 2,
      updatedAt: Date.now(),
      deletedAt: Date.now(),
    };
    const forgetAudit = {
      id: "audit_forget",
      workspaceId: workspace.id,
      client: "kodade-ui",
      capability: "memory:write",
      action: "forget",
      targetId: decision.id,
      sessionId: null,
      result: "ok",
      occurredAt: deleted.deletedAt,
    };
    vi.mocked(ipc.get)
      .mockResolvedValueOnce(decision)
      .mockResolvedValueOnce(deleted);
    vi.mocked(ipc.audit)
      .mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ items: [forgetAudit], total: 1, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ items: [forgetAudit], total: 1, limit: 100, offset: 0 });
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().select(decision.id);

    await store.getState().forgetSelected();

    expect(ipc.get).toHaveBeenLastCalledWith(decision.id);
    expect(store.getState().selected).toEqual(deleted);
    expect(store.getState().audit).toEqual([forgetAudit]);
  });

  it("restores the selected tombstone with its current version and refreshes audit", async () => {
    const ipc = mockMemoryIpc();
    const deleted = {
      ...decision,
      version: 2,
      deletedAt: Date.now(),
      projectSource: {
        projectId: "kodade",
        relativePath: "Decisions/Archive/km_record.md",
        sha256: "a".repeat(64),
      },
    };
    const restored = {
      ...decision,
      version: 3,
      updatedAt: Date.now() + 1,
    };
    const restoreAudit = {
      id: "audit_restore",
      workspaceId: workspace.id,
      client: "kodade-ui",
      capability: "memory:write",
      action: "restore",
      targetId: decision.id,
      sessionId: null,
      result: "ok",
      occurredAt: restored.updatedAt,
    };
    vi.mocked(ipc.get).mockResolvedValue(deleted);
    vi.mocked(ipc.restore).mockResolvedValue(restored);
    vi.mocked(ipc.audit)
      .mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ items: [restoreAudit], total: 1, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ items: [restoreAudit], total: 1, limit: 100, offset: 0 });
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().select(decision.id);

    await store.getState().restoreSelected();

    expect(ipc.restore).toHaveBeenCalledWith(
      decision.id,
      2,
      "kodade-ui",
      null,
      "a".repeat(64),
    );
    expect(store.getState().selected).toEqual(restored);
    expect(store.getState().audit).toEqual([restoreAudit]);
  });

  it("discovers the second tombstone page and loads targeted audit for its selected record", async () => {
    const ipc = mockMemoryIpc();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...decision,
      id: `mem_deleted_${index}`,
      title: `Deleted ${index}`,
      version: 2,
      deletedAt: 1000 + index,
    }));
    const oneHundredFirst = {
      ...decision,
      id: "mem_deleted_100",
      title: "Deleted 100",
      version: 2,
      deletedAt: 1100,
    };
    const targetedAudit = {
      id: "audit_deleted_100",
      workspaceId: workspace.id,
      client: "kodade-ui",
      capability: "memory:write",
      action: "forget",
      targetId: oneHundredFirst.id,
      sessionId: null,
      result: "ok",
      occurredAt: 1100,
    };
    const restored = { ...oneHundredFirst, version: 3, deletedAt: null };
    vi.mocked(ipc.listDeleted).mockImplementation((query) => Promise.resolve(
      query.offset === 0
        ? { items: firstPage, total: 101, limit: 100, offset: 0 }
        : { items: [oneHundredFirst], total: 101, limit: 100, offset: 100 },
    ));
    vi.mocked(ipc.get).mockResolvedValue(oneHundredFirst);
    vi.mocked(ipc.restore).mockResolvedValue(restored);
    vi.mocked(ipc.audit).mockImplementation((query) => Promise.resolve(
      query.targetId === oneHundredFirst.id
        ? { items: [targetedAudit], total: 1, limit: 100, offset: query.offset }
        : { items: [], total: 202, limit: 100, offset: query.offset },
    ));
    const store = createMemoryStore({ ipc });

    await store.getState().load(workspace.id);
    expect(store.getState().deleted).toHaveLength(100);
    expect(store.getState().deletedTotal).toBe(101);

    await store.getState().loadMoreDeleted();
    await store.getState().select(oneHundredFirst.id);

    expect(store.getState().deleted).toHaveLength(101);
    expect(store.getState().deleted.at(-1)?.id).toBe(oneHundredFirst.id);
    expect(ipc.listDeleted).toHaveBeenLastCalledWith({
      workspaceId: workspace.id,
      limit: 100,
      offset: 100,
    });
    expect(ipc.audit).toHaveBeenLastCalledWith({
      workspaceId: workspace.id,
      targetId: oneHundredFirst.id,
      limit: 100,
      offset: 0,
    });
    expect(store.getState().selectedAudit).toEqual([targetedAudit]);

    await store.getState().restoreSelected();

    expect(ipc.restore).toHaveBeenCalledWith(
      oneHundredFirst.id,
      2,
      "kodade-ui",
      null,
    );
    expect(store.getState().selected).toEqual(restored);
  });

  it("clears a selected tombstone and refreshes the list after retention removes it", async () => {
    const ipc = mockMemoryIpc();
    const deleted = {
      ...decision,
      version: 2,
      deletedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    };
    const shortRetention = { ...workspace, tombstoneRetentionDays: 7 };
    vi.mocked(ipc.get)
      .mockResolvedValueOnce(deleted)
      .mockRejectedValueOnce(new Error(`memory not found: ${decision.id}`));
    vi.mocked(ipc.search)
      .mockResolvedValueOnce({
        items: [{ ...decision, excerpt: decision.body }],
        total: 1,
        limit: 100,
        offset: 0,
      })
      .mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 });
    vi.mocked(ipc.setRetention).mockResolvedValue(shortRetention);
    vi.mocked(ipc.drainRetention).mockResolvedValue({
      activityDeleted: 0,
      auditDeleted: 0,
      tombstonesDeleted: 1,
    });
    vi.mocked(ipc.context).mockResolvedValue({
      ...context,
      workspace: shortRetention,
    });
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().select(decision.id);
    await store.getState().search("SQLite");

    await store.getState().updateRetention({
      capturePaused: false,
      activityDays: 7,
      auditDays: 7,
      tombstoneDays: 7,
    });

    expect(store.getState().workspace).toEqual(shortRetention);
    expect(store.getState().selected).toBeNull();
    expect(store.getState().results).toEqual([]);
    expect(store.getState().resultTotal).toBe(0);
    expect(ipc.get).toHaveBeenCalledTimes(2);
    expect(ipc.search).toHaveBeenCalledTimes(2);
  });

  it("awaits one bounded native retention drain before refresh or export", async () => {
    const ipc = mockMemoryIpc();
    const events: string[] = [];
    vi.mocked(ipc.context).mockResolvedValue({
      ...context,
      pinnedDecisions: [],
      openTasks: [],
      recentMemories: [],
    });
    vi.mocked(ipc.listDeleted).mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    vi.mocked(ipc.exportToDirectory).mockImplementation(async () => {
      events.push("export");
      return { markdownPath: "/out/a.md", jsonPath: "/out/a.json" };
    });
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    vi.mocked(ipc.drainRetention).mockClear();
    vi.mocked(ipc.drainRetention).mockImplementationOnce(async () => {
      events.push("retention-drain");
      return { activityDeleted: 1001, auditDeleted: 1001, tombstonesDeleted: 1001 };
    });

    await store.getState().updateRetention({
      capturePaused: true,
      activityDays: 7,
      auditDays: 7,
      tombstoneDays: 7,
    });
    await store.getState().exportTo("/out");

    expect(ipc.drainRetention).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "retention-drain",
      "export",
    ]);
    expect(store.getState().context?.recentMemories).toEqual([]);
    expect(store.getState().deleted).toEqual([]);
  });

  it("keeps the newest privacy setting and saving state when retention completions invert", async () => {
    const ipc = mockMemoryIpc();
    const olderWorkspace = { ...workspace, capturePaused: false, activityRetentionDays: 90 };
    const newerWorkspace = { ...workspace, capturePaused: true, activityRetentionDays: 7 };
    const older = deferred<MemoryWorkspace>();
    const newer = deferred<MemoryWorkspace>();
    let persisted = workspace;
    vi.mocked(ipc.setRetention)
      .mockImplementationOnce(() => older.promise.then((value) => { persisted = value; return value; }))
      .mockImplementationOnce(() => newer.promise.then((value) => { persisted = value; return value; }));
    vi.mocked(ipc.context).mockImplementation(() =>
      Promise.resolve({ ...context, workspace: persisted }),
    );
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);

    const olderOperation = store.getState().updateRetention({
      capturePaused: false,
      activityDays: 90,
      auditDays: 90,
      tombstoneDays: 90,
    });
    const newerOperation = store.getState().updateRetention({
      capturePaused: true,
      activityDays: 7,
      auditDays: 7,
      tombstoneDays: 7,
    });
    await vi.waitFor(() => {
      expect(vi.mocked(ipc.setRetention).mock.calls.length).toBeGreaterThan(0);
    });

    let savingWhileAnotherRequestWasPending: boolean;
    if (vi.mocked(ipc.setRetention).mock.calls.length === 2) {
      newer.resolve(newerWorkspace);
      await newerOperation;
      savingWhileAnotherRequestWasPending = store.getState().saving;
      older.resolve(olderWorkspace);
      await olderOperation;
    } else {
      expect(ipc.setRetention).toHaveBeenCalledTimes(1);
      older.resolve(olderWorkspace);
      await olderOperation;
      await Promise.resolve();
      savingWhileAnotherRequestWasPending = store.getState().saving;
      newer.resolve(newerWorkspace);
      await newerOperation;
    }

    expect(savingWhileAnotherRequestWasPending).toBe(true);
    expect(store.getState().workspace).toEqual(newerWorkspace);
    expect(store.getState().saving).toBe(false);
  });

  it("waits for an active retention setting before a workspace reload drains metadata", async () => {
    const ipc = mockMemoryIpc();
    const savedWorkspace = { ...workspace, capturePaused: true, activityRetentionDays: 7 };
    const setting = deferred<MemoryWorkspace>();
    const events: string[] = [];
    vi.mocked(ipc.setRetention).mockImplementation(() => {
      events.push("setting");
      return setting.promise;
    });
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    vi.mocked(ipc.drainRetention).mockClear();
    vi.mocked(ipc.drainRetention).mockImplementation(async () => {
      events.push("drain");
      return { activityDeleted: 0, auditDeleted: 0, tombstonesDeleted: 0 };
    });

    const updating = store.getState().updateRetention({
      capturePaused: true,
      activityDays: 7,
      auditDays: 7,
      tombstoneDays: 7,
    });
    await vi.waitFor(() => expect(ipc.setRetention).toHaveBeenCalledOnce());
    const loading = store.getState().load(workspace.id);
    await Promise.resolve();

    expect(ipc.drainRetention).not.toHaveBeenCalled();
    setting.resolve(savedWorkspace);
    await Promise.all([updating, loading]);

    expect(events).toEqual(["setting", "drain"]);
    expect(ipc.drainRetention).toHaveBeenCalledOnce();
  });

  it.each(["export", "relink", "purge"] as const)(
    "serializes %s behind an active record mutation",
    async (overlap) => {
      const ipc = mockMemoryIpc();
      const revision = deferred<MemoryRecord>();
      const exported = deferred<Awaited<ReturnType<MemoryIpc["exportToDirectory"]>>>();
      const relinked = deferred<MemoryWorkspace>();
      const purged = deferred<void>();
      vi.mocked(ipc.revise).mockReturnValue(revision.promise);
      vi.mocked(ipc.exportToDirectory).mockReturnValue(exported.promise);
      vi.mocked(ipc.relinkWorkspace).mockReturnValue(relinked.promise);
      vi.mocked(ipc.purgeWorkspace).mockReturnValue(purged.promise);
      const store = createMemoryStore({ ipc });
      await store.getState().load(workspace.id);
      await store.getState().select(decision.id);
      const savingRecord = store.getState().saveSelected({
        kind: decision.kind,
        title: "Saved decision",
        body: decision.body,
        pinned: decision.pinned,
        links: [],
      });
      await Promise.resolve();
      const overlapping = overlap === "export"
        ? store.getState().exportTo("/out")
        : overlap === "relink"
          ? store.getState().relinkWorkspace("D:\\Moved\\Ködade")
          : store.getState().purge();
      await Promise.resolve();
      const command = overlap === "export"
        ? vi.mocked(ipc.exportToDirectory)
        : overlap === "relink"
          ? vi.mocked(ipc.relinkWorkspace)
          : vi.mocked(ipc.purgeWorkspace);
      const startedBeforeSaveFinished = command.mock.calls.length > 0;
      if (startedBeforeSaveFinished) {
        if (overlap === "export") exported.resolve({ markdownPath: "/out/a.md", jsonPath: "/out/a.json" });
        if (overlap === "relink") relinked.resolve({ ...workspace, canonicalRoot: "D:\\Moved\\Ködade" });
        if (overlap === "purge") purged.resolve(undefined);
      }
      revision.resolve({ ...decision, title: "Saved decision", version: 2 });
      await savingRecord;
      await Promise.resolve();
      if (!startedBeforeSaveFinished) {
        if (overlap === "export") exported.resolve({ markdownPath: "/out/a.md", jsonPath: "/out/a.json" });
        if (overlap === "relink") relinked.resolve({ ...workspace, canonicalRoot: "D:\\Moved\\Ködade" });
        if (overlap === "purge") purged.resolve(undefined);
      }
      await overlapping;

      expect(startedBeforeSaveFinished).toBe(false);
    },
  );

  it("loads a bounded second active search page with its original filters and selects the 101st record", async () => {
    const ipc = mockMemoryIpc();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `mem_search_${index}`,
      workspaceId: workspace.id,
      kind: "fact" as const,
      title: `Active ${index}`,
      excerpt: "Searchable active memory.",
      source: "agent" as const,
      pinned: false,
      version: 1,
      updatedAt: index,
    }));
    const oneHundredFirst = {
      id: "mem_search_100",
      workspaceId: workspace.id,
      kind: "fact" as const,
      title: "Active 100",
      excerpt: "Searchable active memory.",
      source: "agent" as const,
      pinned: false,
      version: 1,
      updatedAt: 100,
    };
    const inspectable = {
      ...decision,
      ...oneHundredFirst,
      body: "The 101st active search result is inspectable.",
      links: [],
      backlinks: [],
      createdAt: 100,
      deletedAt: null,
      sourceClient: "kodade-mcp",
      sessionId: null,
    };
    vi.mocked(ipc.search).mockImplementation((query) => Promise.resolve(
      query.offset === 0
        ? { items: firstPage, total: 101, limit: 100, offset: 0 }
        : { items: [oneHundredFirst], total: 101, limit: 100, offset: 100 },
    ));
    vi.mocked(ipc.get).mockResolvedValue(inspectable);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().search("active search", ["fact"], ["agent"], 123);

    await (store.getState() as unknown as {
      loadMoreSearchResults(): Promise<void>;
    }).loadMoreSearchResults();
    await store.getState().select(oneHundredFirst.id);

    expect(ipc.search).toHaveBeenLastCalledWith({
      workspaceId: workspace.id,
      text: "active search",
      kinds: ["fact"],
      sources: ["agent"],
      updatedAfter: 123,
      limit: 100,
      offset: 100,
    });
    expect(store.getState().results).toHaveLength(101);
    expect(store.getState().results.at(-1)).toEqual(oneHundredFirst);
    expect(store.getState().selected).toEqual(inspectable);
  });

  it("drops a late active search page after a newer same-workspace search", async () => {
    const ipc = mockMemoryIpc();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `mem_first_${index}`,
      workspaceId: workspace.id,
      kind: "fact" as const,
      title: `First ${index}`,
      excerpt: "First query.",
      source: "agent" as const,
      pinned: false,
      version: 1,
      updatedAt: index,
    }));
    const newerResult = {
      id: "mem_newer",
      workspaceId: workspace.id,
      kind: "fact" as const,
      title: "Newer search",
      excerpt: "The current query.",
      source: "agent" as const,
      pinned: false,
      version: 1,
      updatedAt: 101,
    };
    const pendingPage = deferred<Awaited<ReturnType<MemoryIpc["search"]>>>();
    vi.mocked(ipc.search).mockImplementation((query) => {
      if (query.text === "first query" && query.offset === 0) {
        return Promise.resolve({ items: firstPage, total: 101, limit: 100, offset: 0 });
      }
      if (query.text === "first query") return pendingPage.promise;
      return Promise.resolve({ items: [newerResult], total: 1, limit: 100, offset: 0 });
    });
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().search("first query");

    const loadingMore = store.getState().loadMoreSearchResults();
    await Promise.resolve();
    await store.getState().search("newer query");
    pendingPage.resolve({
      items: [{ ...firstPage[0], id: "mem_first_100", title: "First 100" }],
      total: 101,
      limit: 100,
      offset: 100,
    });
    await loadingMore;

    expect(store.getState().query).toBe("newer query");
    expect(store.getState().results).toEqual([newerResult]);
    expect(store.getState().resultTotal).toBe(1);
  });

  it("refreshes a shifted search generation so a new first-page match is never stranded", async () => {
    const ipc = mockMemoryIpc();
    const original = Array.from({ length: 200 }, (_, index) => ({
      id: `mem_${index}`,
      workspaceId: workspace.id,
      kind: "fact" as const,
      title: `Memory ${index}`,
      excerpt: "Stable paging result.",
      source: "agent" as const,
      pinned: false,
      version: 1,
      updatedAt: 200 - index,
    }));
    const inserted = {
      ...original[0],
      id: "mem_new_first",
      title: "New first-page match",
      updatedAt: 300,
    };
    let concurrentInsert = false;
    vi.mocked(ipc.search).mockImplementation((query) => {
      const rows = concurrentInsert ? [inserted, ...original] : original;
      return Promise.resolve({
        items: rows.slice(query.offset, query.offset + query.limit),
        total: rows.length,
        limit: query.limit,
        offset: query.offset,
      });
    });
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().search("stable paging", ["fact"], ["agent"], 123);
    concurrentInsert = true;

    await store.getState().loadMoreSearchResults();
    await store.getState().loadMoreSearchResults();
    await store.getState().loadMoreSearchResults();

    expect(store.getState().results).toHaveLength(201);
    expect(store.getState().results[0]).toEqual(inserted);
    expect(store.getState().results.at(-1)?.id).toBe("mem_199");
    expect(new Set(store.getState().results.map((item) => item.id)).size).toBe(201);
  });

  it("coalesces parallel load-more calls for the active search generation", async () => {
    const ipc = mockMemoryIpc();
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: `mem_parallel_${index}`,
      workspaceId: workspace.id,
      kind: "fact" as const,
      title: `Parallel ${index}`,
      excerpt: "Parallel paging result.",
      source: "agent" as const,
      pinned: false,
      version: 1,
      updatedAt: 200 - index,
    }));
    const pendingPage = deferred<Awaited<ReturnType<MemoryIpc["search"]>>>();
    vi.mocked(ipc.search).mockImplementation((query) =>
      query.offset === 0
        ? Promise.resolve({ items: rows.slice(0, 100), total: 200, limit: 100, offset: 0 })
        : pendingPage.promise,
    );
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().search("parallel paging");

    const first = store.getState().loadMoreSearchResults();
    const second = store.getState().loadMoreSearchResults();
    await Promise.resolve();
    const callsBeforeCompletion = vi.mocked(ipc.search).mock.calls.length;
    pendingPage.resolve({ items: rows.slice(100), total: 200, limit: 100, offset: 100 });
    await Promise.all([first, second]);

    expect(callsBeforeCompletion).toBe(2);
    expect(store.getState().results).toHaveLength(200);
  });

  it("keeps the last same-workspace record selection when get responses invert", async () => {
    const ipc = mockMemoryIpc();
    const recordA = { ...decision, id: "mem_a", title: "Record A" };
    const recordB = { ...decision, id: "mem_b", title: "Record B" };
    const pendingA = deferred<MemoryRecord>();
    const pendingB = deferred<MemoryRecord>();
    vi.mocked(ipc.get).mockImplementation((id) =>
      id === recordA.id ? pendingA.promise : pendingB.promise,
    );
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);

    const selectingA = store.getState().select(recordA.id);
    const selectingB = store.getState().select(recordB.id);
    pendingB.resolve(recordB);
    await selectingB;
    pendingA.resolve(recordA);
    await selectingA;

    expect(store.getState().selected).toEqual(recordB);
  });

  it("keeps a newer same-workspace selection when save A resolves after B is selected", async () => {
    const ipc = mockMemoryIpc();
    const recordA = { ...decision, id: "mem_a", title: "Record A" };
    const recordB = { ...decision, id: "mem_b", title: "Record B", body: "B draft" };
    const pendingRevision = deferred<MemoryRecord>();
    vi.mocked(ipc.get).mockImplementation((id) =>
      Promise.resolve(id === recordA.id ? recordA : recordB),
    );
    vi.mocked(ipc.revise).mockReturnValue(pendingRevision.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().select(recordA.id);

    const savingA = store.getState().saveSelected({
      kind: recordA.kind,
      title: "Record A saved",
      body: "A save must not replace B's draft.",
      pinned: false,
      links: [],
    });
    await Promise.resolve();
    await store.getState().select(recordB.id);
    pendingRevision.resolve({ ...recordA, title: "Record A saved", version: 2 });
    await savingA;

    expect(store.getState().selected).toEqual(recordB);
  });

  it("does not select a late same-workspace create after another record is selected", async () => {
    const ipc = mockMemoryIpc();
    const recordB = { ...decision, id: "mem_b", title: "Record B" };
    const created = { ...decision, id: "mem_created", title: "Late create" };
    const pendingCreate = deferred<MemoryRecord>();
    vi.mocked(ipc.get).mockResolvedValue(recordB);
    vi.mocked(ipc.remember).mockReturnValue(pendingCreate.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);

    const creating = store.getState().createMemory({
      kind: "fact",
      title: created.title,
      body: "This late create must not replace B.",
      pinned: false,
      links: [],
    });
    await Promise.resolve();
    await store.getState().select(recordB.id);
    pendingCreate.resolve(created);

    expect(await creating).toBeNull();
    expect(store.getState().selected).toEqual(recordB);
  });

  it("does not select a late same-workspace forget after another record is selected", async () => {
    const ipc = mockMemoryIpc();
    const recordA = { ...decision, id: "mem_a", title: "Record A" };
    const recordB = { ...decision, id: "mem_b", title: "Record B" };
    const pendingForget = deferred<Awaited<ReturnType<MemoryIpc["forget"]>>>();
    vi.mocked(ipc.get).mockImplementation((id) =>
      Promise.resolve(id === recordA.id ? recordA : recordB),
    );
    vi.mocked(ipc.forget).mockReturnValue(pendingForget.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().select(recordA.id);

    const forgetting = store.getState().forgetSelected();
    await Promise.resolve();
    await store.getState().select(recordB.id);
    pendingForget.resolve({
      id: recordA.id,
      workspaceId: workspace.id,
      version: 2,
      deletedAt: 3,
    });
    await forgetting;

    expect(store.getState().selected).toEqual(recordB);
  });

  it("does not select a late same-workspace restore after another record is selected", async () => {
    const ipc = mockMemoryIpc();
    const recordA = { ...decision, id: "mem_a", title: "Record A", version: 2, deletedAt: 3 };
    const recordB = { ...decision, id: "mem_b", title: "Record B" };
    const pendingRestore = deferred<MemoryRecord>();
    vi.mocked(ipc.get).mockImplementation((id) =>
      Promise.resolve(id === recordA.id ? recordA : recordB),
    );
    vi.mocked(ipc.restore).mockReturnValue(pendingRestore.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().select(recordA.id);

    const restoring = store.getState().restoreSelected();
    await Promise.resolve();
    await store.getState().select(recordB.id);
    pendingRestore.resolve({ ...recordA, version: 3, deletedAt: null });
    await restoring;

    expect(store.getState().selected).toEqual(recordB);
  });

  it.each(["create", "save", "forget", "restore"] as const)(
    "refreshes every current projection after a stale %s commits without stealing selection",
    async (mutation) => {
      const ipc = mockMemoryIpc();
      const recordA: MemoryRecord = {
        ...decision,
        id: mutation === "create" ? "mem_created" : "mem_a",
        title: "Record A",
        version: mutation === "restore" ? 2 : 1,
        deletedAt: mutation === "restore" ? 3 : null,
      };
      const recordB = { ...decision, id: "mem_b", title: "Record B" };
      const committedRecord: MemoryRecord = {
        ...recordA,
        title: mutation === "save" ? "Record A saved" : recordA.title,
        version: mutation === "create" ? 1 : recordA.version + 1,
        deletedAt: mutation === "forget" ? 4 : null,
      };
      const beforeActive = mutation === "create" || mutation === "restore" ? [] : [recordA];
      const afterActive = mutation === "forget" ? [] : [committedRecord];
      const beforeDeleted = mutation === "restore" ? [recordA] : [];
      const afterDeleted = mutation === "forget" ? [committedRecord] : [];
      const mutationAudit = {
        id: `audit_${mutation}`,
        workspaceId: workspace.id,
        client: "kodade-ui",
        capability: "memory:write",
        action: mutation === "create" ? "remember" : mutation === "save" ? "revise" : mutation,
        targetId: committedRecord.id,
        sessionId: null,
        result: "ok",
        occurredAt: 4,
      };
      let committed = false;
      vi.mocked(ipc.context).mockImplementation(() =>
        Promise.resolve({
          ...context,
          pinnedDecisions: committed ? afterActive : beforeActive,
          recentMemories: committed ? afterActive : beforeActive,
        }),
      );
      vi.mocked(ipc.search).mockImplementation(() => {
        const records = committed ? afterActive : beforeActive;
        return Promise.resolve({
          items: records.map(searchHit),
          total: records.length,
          limit: 100,
          offset: 0,
        });
      });
      vi.mocked(ipc.listDeleted).mockImplementation(() => {
        const records = committed ? afterDeleted : beforeDeleted;
        return Promise.resolve({ items: records, total: records.length, limit: 100, offset: 0 });
      });
      vi.mocked(ipc.audit).mockImplementation((query) => {
        const items = committed && query.targetId === null ? [mutationAudit] : [];
        return Promise.resolve({ items, total: items.length, limit: 100, offset: 0 });
      });
      vi.mocked(ipc.get).mockImplementation((id) =>
        Promise.resolve(
          id === recordB.id ? recordB : committed ? committedRecord : recordA,
        ),
      );
      const pendingRecord = deferred<MemoryRecord>();
      const pendingTombstone = deferred<Awaited<ReturnType<MemoryIpc["forget"]>>>();
      vi.mocked(ipc.remember).mockReturnValue(pendingRecord.promise);
      vi.mocked(ipc.revise).mockReturnValue(pendingRecord.promise);
      vi.mocked(ipc.restore).mockReturnValue(pendingRecord.promise);
      vi.mocked(ipc.forget).mockReturnValue(pendingTombstone.promise);
      const store = createMemoryStore({ ipc });
      await store.getState().load(workspace.id);
      await store.getState().search("original filters", ["decision"], ["user"], 123);
      if (mutation !== "create") await store.getState().select(recordA.id);

      const operation = mutation === "create"
        ? store.getState().createMemory({
            kind: recordA.kind,
            title: recordA.title,
            body: recordA.body,
            pinned: recordA.pinned,
            links: [],
          })
        : mutation === "save"
          ? store.getState().saveSelected({
              kind: recordA.kind,
              title: committedRecord.title,
              body: committedRecord.body,
              pinned: recordA.pinned,
              links: [],
            })
          : mutation === "forget"
            ? store.getState().forgetSelected()
            : store.getState().restoreSelected();
      await Promise.resolve();
      await store.getState().select(recordB.id);
      committed = true;
      if (mutation === "forget") {
        pendingTombstone.resolve({
          id: committedRecord.id,
          workspaceId: workspace.id,
          version: committedRecord.version,
          deletedAt: committedRecord.deletedAt!,
        });
      } else {
        pendingRecord.resolve(committedRecord);
      }
      await operation;

      expect(store.getState().selected).toEqual(recordB);
      expect(store.getState().context?.recentMemories).toEqual(afterActive);
      expect(store.getState().results).toEqual(afterActive.map(searchHit));
      expect(store.getState().deleted).toEqual(afterDeleted);
      expect(store.getState().audit).toEqual([mutationAudit]);
      expect(ipc.search).toHaveBeenLastCalledWith({
        workspaceId: workspace.id,
        text: "original filters",
        kinds: ["decision"],
        sources: ["user"],
        updatedAfter: 123,
        limit: 100,
        offset: 0,
      });
    },
  );

  it("keeps newer record audit visible when an earlier selection's audit completes late", async () => {
    const ipc = mockMemoryIpc();
    const recordA = { ...decision, id: "mem_a", title: "Record A" };
    const recordB = { ...decision, id: "mem_b", title: "Record B" };
    const pendingAuditA = deferred<Awaited<ReturnType<MemoryIpc["audit"]>>>();
    const auditB = {
      id: "audit_b",
      workspaceId: workspace.id,
      client: "kodade-ui",
      capability: "memory:read",
      action: "get",
      targetId: recordB.id,
      sessionId: null,
      result: "ok",
      occurredAt: 4,
    };
    vi.mocked(ipc.get).mockImplementation((id) =>
      Promise.resolve(id === recordA.id ? recordA : recordB),
    );
    vi.mocked(ipc.audit).mockImplementation((query) =>
      query.targetId === recordA.id
        ? pendingAuditA.promise
        : Promise.resolve({ items: [auditB], total: 1, limit: 100, offset: 0 }),
    );
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);

    const selectingA = store.getState().select(recordA.id);
    await Promise.resolve();
    const selectingB = store.getState().select(recordB.id);
    await selectingB;
    pendingAuditA.resolve({ items: [], total: 0, limit: 100, offset: 0 });
    await selectingA;

    expect(store.getState().selected).toEqual(recordB);
    expect(store.getState().selectedAudit).toEqual([auditB]);
  });

  it("ignores a save completion after the active workspace switches", async () => {
    const ipc = mockMemoryIpc();
    const otherWorkspace = {
      ...workspace,
      id: "ws_2",
      canonicalRoot: "D:\\Work\\Other",
      displayName: "Other",
    };
    const otherContext = {
      ...context,
      workspace: otherWorkspace,
      pinnedDecisions: [],
      recentMemories: [],
    };
    vi.mocked(ipc.context).mockImplementation((workspaceId) =>
      Promise.resolve(
        workspaceId === otherWorkspace.id ? otherContext : context,
      ),
    );
    const pendingRevision = deferred<MemoryRecord>();
    vi.mocked(ipc.revise).mockReturnValue(pendingRevision.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().select(decision.id);

    const saving = store.getState().saveSelected({
      kind: "decision",
      title: "Late revision",
      body: "This completion belongs only to workspace A.",
      pinned: true,
      links: [],
    });
    await Promise.resolve();
    await store.getState().load(otherWorkspace.id);
    pendingRevision.resolve({
      ...decision,
      title: "Late revision",
      version: 2,
    });
    await saving;

    expect(store.getState().workspace).toEqual(otherWorkspace);
    expect(store.getState().context).toEqual(otherContext);
    expect(store.getState().selected).toBeNull();
    expect(store.getState().audit).toEqual([]);
  });

  it("ignores a create completion after the active workspace switches", async () => {
    const ipc = mockMemoryIpc();
    const { otherWorkspace, otherContext } = secondWorkspace();
    vi.mocked(ipc.context).mockImplementation((workspaceId) =>
      Promise.resolve(
        workspaceId === otherWorkspace.id ? otherContext : context,
      ),
    );
    const pendingCreate = deferred<MemoryRecord>();
    vi.mocked(ipc.remember).mockReturnValue(pendingCreate.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);

    const creating = store.getState().createMemory({
      kind: "fact",
      title: "Late create",
      body: "This belongs to workspace A.",
      pinned: false,
      links: [],
    });
    await Promise.resolve();
    await store.getState().load(otherWorkspace.id);
    pendingCreate.resolve({ ...decision, kind: "fact", title: "Late create" });

    expect(await creating).toBeNull();
    expect(store.getState().workspace).toEqual(otherWorkspace);
    expect(store.getState().context).toEqual(otherContext);
    expect(store.getState().selected).toBeNull();
  });

  it("ignores a forget completion after the active workspace switches", async () => {
    const ipc = mockMemoryIpc();
    const { otherWorkspace, otherContext } = secondWorkspace();
    vi.mocked(ipc.context).mockImplementation((workspaceId) =>
      Promise.resolve(
        workspaceId === otherWorkspace.id ? otherContext : context,
      ),
    );
    const pendingForget = deferred<Awaited<ReturnType<MemoryIpc["forget"]>>>();
    vi.mocked(ipc.forget).mockReturnValue(pendingForget.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().select(decision.id);

    const forgetting = store.getState().forgetSelected();
    await Promise.resolve();
    await store.getState().load(otherWorkspace.id);
    pendingForget.resolve({
      id: decision.id,
      workspaceId: workspace.id,
      version: 2,
      deletedAt: 3,
    });
    await forgetting;

    expect(store.getState().workspace).toEqual(otherWorkspace);
    expect(store.getState().context).toEqual(otherContext);
    expect(store.getState().selected).toBeNull();
  });

  it("ignores a restore completion after the active workspace switches", async () => {
    const ipc = mockMemoryIpc();
    const { otherWorkspace, otherContext } = secondWorkspace();
    const deleted = { ...decision, version: 2, deletedAt: Date.now() };
    vi.mocked(ipc.context).mockImplementation((workspaceId) =>
      Promise.resolve(
        workspaceId === otherWorkspace.id ? otherContext : context,
      ),
    );
    vi.mocked(ipc.get).mockResolvedValue(deleted);
    const pendingRestore = deferred<MemoryRecord>();
    vi.mocked(ipc.restore).mockReturnValue(pendingRestore.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);
    await store.getState().select(decision.id);

    const restoring = store.getState().restoreSelected();
    await Promise.resolve();
    await store.getState().load(otherWorkspace.id);
    pendingRestore.resolve({ ...decision, version: 3 });
    await restoring;

    expect(store.getState().workspace).toEqual(otherWorkspace);
    expect(store.getState().context).toEqual(otherContext);
    expect(store.getState().selected).toBeNull();
  });

  it("ignores a relink completion after the active workspace switches", async () => {
    const ipc = mockMemoryIpc();
    const { otherWorkspace, otherContext } = secondWorkspace();
    const moved = {
      ...workspace,
      canonicalRoot: "E:\\Moved\\Ködade",
      updatedAt: 2,
    };
    vi.mocked(ipc.context).mockImplementation((workspaceId) =>
      Promise.resolve(
        workspaceId === otherWorkspace.id ? otherContext : context,
      ),
    );
    const pendingRelink = deferred<MemoryWorkspace>();
    vi.mocked(ipc.relinkWorkspace).mockReturnValue(pendingRelink.promise);
    const onWorkspaceLinked = vi.fn();
    const store = createMemoryStore({ ipc, onWorkspaceLinked });
    await store.getState().load(workspace.id);

    const relinking = store.getState().relinkWorkspace(moved.canonicalRoot);
    await Promise.resolve();
    await store.getState().load(otherWorkspace.id);
    pendingRelink.resolve(moved);

    expect(await relinking).toBeNull();
    expect(store.getState().workspace).toEqual(otherWorkspace);
    expect(store.getState().context).toEqual(otherContext);
    expect(store.getState().selected).toBeNull();
    expect(onWorkspaceLinked).toHaveBeenCalledWith(
      moved,
      workspace.canonicalRoot,
    );
  });

  it("ignores a delayed workspace load that completes after purge", async () => {
    const ipc = mockMemoryIpc();
    const pendingContext = deferred<WorkspaceContext>();
    vi.mocked(ipc.context).mockReturnValue(pendingContext.promise);
    const store = createMemoryStore({ ipc });
    store.setState({ workspace, context });

    const loading = store.getState().load(workspace.id);
    await Promise.resolve();
    await store.getState().purge();
    pendingContext.resolve(context);
    await loading;

    expect(store.getState().workspace).toBeNull();
    expect(store.getState().context).toBeNull();
    expect(store.getState().audit).toEqual([]);
  });

  it("ignores a delayed search that completes after purge", async () => {
    const ipc = mockMemoryIpc();
    const pendingSearch = deferred<Awaited<ReturnType<MemoryIpc["search"]>>>();
    vi.mocked(ipc.search).mockReturnValue(pendingSearch.promise);
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);

    const searching = store.getState().search("SQLite");
    await Promise.resolve();
    await store.getState().purge();
    pendingSearch.resolve({
      items: [{ ...decision, excerpt: "Keep memory local." }],
      total: 1,
      limit: 100,
      offset: 0,
    });
    await searching;

    expect(store.getState().workspace).toBeNull();
    expect(store.getState().results).toEqual([]);
    expect(store.getState().resultTotal).toBe(0);
  });

  it("does not start or stamp an A search while workspace B is still loading", async () => {
    const ipc = mockMemoryIpc();
    const pendingBContext = deferred<WorkspaceContext>();
    vi.mocked(ipc.context)
      .mockResolvedValueOnce(context)
      .mockReturnValueOnce(pendingBContext.promise);
    vi.mocked(ipc.audit).mockResolvedValue({
      items: [], total: 0, limit: 100, offset: 0,
    });
    vi.mocked(ipc.listDeleted).mockResolvedValue({
      items: [], total: 0, limit: 100, offset: 0,
    });
    const store = createMemoryStore({ ipc });
    await store.getState().load(workspace.id);

    const loadingB = store.getState().load("ws_2");
    await Promise.resolve();
    await store.getState().search("Keep memory local.");
    pendingBContext.resolve(secondWorkspace().otherContext);
    await loadingB;

    expect(ipc.search).not.toHaveBeenCalled();
    expect(store.getState().workspace?.id).toBe("ws_2");
    expect(store.getState().query).toBe("");
    expect(store.getState().results).toEqual([]);
  });

  it("does not search the previous workspace while resolving a newly opened root", async () => {
    const ipc = mockMemoryIpc();
    const pendingWorkspace = deferred<MemoryWorkspace | null>();
    vi.mocked(ipc.resolveWorkspace).mockReturnValue(pendingWorkspace.promise);
    const store = createMemoryStore({ ipc });
    store.setState({ workspace, context });

    const opening = store.getState().openWorkspace("D:\\Work\\Other");
    await Promise.resolve();
    await store.getState().search("Keep memory local.");
    pendingWorkspace.resolve(null);
    await opening;

    expect(ipc.search).not.toHaveBeenCalled();
    expect(store.getState().workspace).toBeNull();
    expect(store.getState().query).toBe("");
  });

  it("does not search the previous workspace while creating a new workspace", async () => {
    const ipc = mockMemoryIpc();
    const pendingWorkspace = deferred<MemoryWorkspace>();
    vi.mocked(ipc.registerWorkspace).mockReturnValue(pendingWorkspace.promise);
    const store = createMemoryStore({ ipc });
    store.setState({ workspace, context });

    const creating = store
      .getState()
      .createWorkspace("D:\\Work\\Other", "Other", "mauve");
    await Promise.resolve();
    await store.getState().search("Keep memory local.");
    pendingWorkspace.resolve(secondWorkspace().otherWorkspace);
    await creating;

    expect(ipc.search).not.toHaveBeenCalled();
    expect(store.getState().workspace?.id).toBe("ws_1");
    expect(store.getState().query).toBe("");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function searchHit(record: MemoryRecord) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    kind: record.kind,
    title: record.title,
    excerpt: record.body,
    source: record.source,
    pinned: record.pinned,
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

function secondWorkspace() {
  const otherWorkspace: MemoryWorkspace = {
    ...workspace,
    id: "ws_2",
    canonicalRoot: "D:\\Work\\Other",
    displayName: "Other",
  };
  const otherContext: WorkspaceContext = {
    ...context,
    workspace: otherWorkspace,
    pinnedDecisions: [],
    recentMemories: [],
  };
  return { otherWorkspace, otherContext };
}
