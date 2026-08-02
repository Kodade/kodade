import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CMD,
  type AuditQuery,
  type DeletedMemoryQuery,
  type MemoryQuery,
  type MemoryRevision,
} from "./contract";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { tauriMemory } from "./memory";

describe("typed memory IPC", () => {
  beforeEach(() => invoke.mockReset());

  it("maps workspace registration and search to typed Tauri commands", async () => {
    invoke.mockResolvedValueOnce({ id: "ws_1" }).mockResolvedValueOnce({ items: [] });
    await tauriMemory.registerWorkspace("C:\\Work\\Ködade", "Ködade", "mauve");
    const query: MemoryQuery = {
      workspaceId: "ws_1",
      text: "sqlite wal",
      kinds: ["decision"],
      sources: ["user"],
      updatedAfter: null,
      limit: 20,
      offset: 0,
    };
    await tauriMemory.search(query);
    await tauriMemory.recordActivity({
      workspaceId: "ws_1",
      kind: "fileSaved",
      source: "kodade-ui",
      sessionId: null,
      relativePath: "Src\\App.ts",
      provider: null,
      occurredAt: null,
    });

    expect(invoke).toHaveBeenNthCalledWith(1, CMD.memoryRegisterWorkspace, {
      root: "C:\\Work\\Ködade",
      displayName: "Ködade",
      color: "mauve",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, CMD.memorySearch, { query });
    expect(invoke).toHaveBeenNthCalledWith(3, CMD.memoryRecordActivity, {
      input: {
        workspaceId: "ws_1",
        kind: "fileSaved",
        source: "kodade-ui",
        sessionId: null,
        relativePath: "Src\\App.ts",
        provider: null,
        occurredAt: null,
      },
    });
  });

  it("passes optimistic revisions and export destinations without reshaping paths", async () => {
    invoke.mockResolvedValue(undefined);
    const revision: MemoryRevision = {
      id: "mem_1",
      expectedVersion: 4,
      kind: "task",
      title: "Ship it",
      body: "Run the gates.",
      pinned: true,
      sourceClient: "kodade-ui",
      sessionId: null,
      links: [],
    };
    await tauriMemory.revise(revision);
    await tauriMemory.exportToDirectory("ws_1", "D:\\Exports\\KödMem");

    expect(invoke).toHaveBeenNthCalledWith(1, CMD.memoryRevise, { input: revision });
    expect(invoke).toHaveBeenNthCalledWith(2, CMD.memoryExportToDirectory, {
      workspaceId: "ws_1",
      destination: "D:\\Exports\\KödMem",
    });
  });

  it("passes tombstone restore version and provenance to the native boundary", async () => {
    invoke.mockResolvedValue(undefined);

    await tauriMemory.restore("mem_1", 2, "kodade-ui", "undo-session");

    expect(invoke).toHaveBeenCalledWith(CMD.memoryRestore, {
      id: "mem_1",
      expectedVersion: 2,
      sourceClient: "kodade-ui",
      sessionId: "undo-session",
    });
  });

  it("runs bounded retention through the native async command", async () => {
    invoke.mockResolvedValue({
      activityDeleted: 1,
      auditDeleted: 2,
      tombstonesDeleted: 3,
    });
    const provenance = { sourceClient: "kodade-ui", sessionId: null };

    await tauriMemory.drainRetention("ws_1", provenance);

    expect(invoke).toHaveBeenCalledWith(CMD.memoryDrainRetention, {
      workspaceId: "ws_1",
      provenance,
    });
  });

  it("uses bounded typed pages for deleted memories and record-specific audit", async () => {
    invoke.mockResolvedValue({ items: [], total: 101, limit: 100, offset: 100 });
    const deleted: DeletedMemoryQuery = {
      workspaceId: "ws_1",
      limit: 100,
      offset: 100,
    };
    const audit: AuditQuery = {
      workspaceId: "ws_1",
      targetId: "mem_101",
      limit: 100,
      offset: 0,
    };

    await tauriMemory.listDeleted(deleted);
    await tauriMemory.audit(audit);

    expect(invoke).toHaveBeenNthCalledWith(1, CMD.memoryListDeleted, { query: deleted });
    expect(invoke).toHaveBeenNthCalledWith(2, CMD.memoryAudit, { query: audit });
  });

  it("passes a bounded subsequent active-memory search page without reshaping its filters", async () => {
    invoke.mockResolvedValue({ items: [], total: 101, limit: 100, offset: 100 });
    const query: MemoryQuery = {
      workspaceId: "ws_1",
      text: "active search",
      kinds: ["fact"],
      sources: ["agent"],
      updatedAfter: 123,
      limit: 100,
      offset: 100,
    };

    await tauriMemory.search(query);

    expect(invoke).toHaveBeenCalledWith(CMD.memorySearch, { query });
  });

  it("keeps workspace resolution separate from an explicit relink", async () => {
    invoke.mockResolvedValue(undefined);

    await tauriMemory.resolveWorkspace("D:\\Moved\\Ködade");
    await tauriMemory.relinkWorkspace(
      "ws_1",
      "C:\\Work\\Ködade",
      "D:\\Moved\\Ködade",
      "kodade-ui",
    );

    expect(invoke).toHaveBeenNthCalledWith(1, CMD.memoryResolveWorkspace, {
      root: "D:\\Moved\\Ködade",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, CMD.memoryRelinkWorkspace, {
      workspaceId: "ws_1",
      expectedRoot: "C:\\Work\\Ködade",
      newRoot: "D:\\Moved\\Ködade",
      sourceClient: "kodade-ui",
    });
  });

  it("lists registered workspace identities without resolving their old folders", async () => {
    invoke.mockResolvedValue([]);

    await expect(tauriMemory.listWorkspaces()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith(CMD.memoryListWorkspaces);
  });

  it("maps the bundled KödMCP helper lookup without a payload", async () => {
    invoke.mockResolvedValue({ path: "/Applications/Ködade/kodade-mcp", exists: true });

    await expect(tauriMemory.mcpBinaryPath()).resolves.toEqual({
      path: "/Applications/Ködade/kodade-mcp",
      exists: true,
    });
    expect(invoke).toHaveBeenCalledWith(CMD.memoryMcpBinaryPath);
  });

  it("returns the real KödMem database path without a payload", async () => {
    invoke.mockResolvedValue(
      "/Users/Keith/Library/Application Support/com.kodade.desktop/kodade-memory.sqlite3",
    );

    await expect(tauriMemory.databasePath()).resolves.toContain(
      "kodade-memory.sqlite3",
    );
    expect(invoke).toHaveBeenCalledWith(CMD.memoryDatabasePath);
  });
});
