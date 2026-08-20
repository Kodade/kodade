import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CMD, type MemoryRecord, type MemoryWorkspace } from "../ipc/contract";

const invoke = vi.hoisted(() => vi.fn());
const openDialog = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

import { appStore, filesStore, harnessStore, memoryStore } from "../store/appStore";
import { buildMemoryMcpSetup } from "../memory/mcp-config";
import { MemoryPane } from "./MemoryPane";

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
  workspaceId: workspace.id,
  kind: "decision",
  title: "Use SQLite WAL",
  body: "Keep the shared memory boundary local.",
  source: "user",
  sourceClient: "kodade-ui",
  sessionId: null,
  pinned: true,
  version: 2,
  createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  updatedAt: Date.UTC(2026, 1, 3, 4, 5, 6),
  deletedAt: null,
  links: [],
  backlinks: [],
};

const emptyRetentionReport = {
  activityDeleted: 0,
  auditDeleted: 0,
  tombstonesDeleted: 0,
};

function mockInvoke<TPayload = unknown>(
  handler: (command: string, payload?: TPayload) => unknown,
  mcpBinary: { path: string | null; exists: boolean } = {
    path: "/Applications/Ködade/kodade-mcp",
    exists: true,
  },
): void {
  invoke.mockImplementation((command: string, payload?: TPayload) =>
    command === CMD.memoryDrainRetention
      ? Promise.resolve(emptyRetentionReport)
      : command === CMD.memoryMcpBinaryPath
        ? Promise.resolve(mcpBinary)
      : handler(command, payload),
  );
}

describe("KödMem pane", () => {
  let container: HTMLDivElement;
  let root: Root;

  const expandAgentSetup = async () => {
    const setup = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="kodmem-agent-setup"]',
    );
    if (setup?.getAttribute("aria-expanded") === "true") return;
    await act(async () => {
      setup?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    invoke.mockReset();
    openDialog.mockReset();
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.readFile) {
        return Promise.resolve({ kind: "text", content: "# Current state" });
      }
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: {
            id: "cp_1",
            workspaceId: workspace.id,
            summary: "Core storage is ready.",
            decisions: [],
            nextActions: ["Review the local UI."],
            changedPaths: [],
            source: "agent",
            sourceClient: "codex",
            sessionId: "m8c",
            createdAt: 4,
          },
          pinnedDecisions: [decision],
          openTasks: [],
          recentMemories: [decision],
          projectKnowledge: {
            projectId: "kodade",
            projectDisplayName: "Ködade",
            origin: "C:\\ProjectsVault\\10-Projects\\kodade",
            sync: {
              status: "current",
              refreshedAt: 5,
              indexedDocuments: 7,
              indexHash: "a".repeat(64),
              truncated: false,
              error: null,
            },
            sources: [{
              kind: "state",
              relativePath: "STATE.md",
              title: "Current state",
              content: "The mapped project is ready.",
              sha256: "b".repeat(64),
              modifiedAt: 5,
              truncated: false,
            }],
          },
        });
      }
      if (command === CMD.memoryAudit) {
        return Promise.resolve({
          items: [{
            id: "audit_1",
            workspaceId: workspace.id,
            client: "kodade-ui",
            capability: "memory:write",
            action: "revise",
            targetId: decision.id,
            sessionId: null,
            result: "ok",
            occurredAt: 3,
          }],
          total: 1,
          limit: 100,
          offset: 0,
        });
      }
      if (command === CMD.memoryListDeleted) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryGet) return Promise.resolve(decision);
      if (command === CMD.configEnv) {
        return Promise.resolve({ home: "/Users/developer", platform: "mac", appDataRoaming: null, appDataLocal: null });
      }
      if (command === CMD.configRead) return Promise.reject(new Error("missing"));
      throw new Error(`unexpected Tauri command: ${command}`);
    });
    memoryStore.setState({
      workspace: null,
      context: null,
      workingMemory: null,
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
    });
    harnessStore.setState({
      pendingChange: null,
      preparing: false,
      applying: false,
      mutationError: null,
    });
    appStore.setState({
      memoryAgentAccess: { enabled: false, access: "read-write" },
    });
    filesStore.setState({ selectedPath: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    // Restore real timers after every test so a fake-timer test (below) can
    // never leak its clock into the real-timer tests that rely on waitFor.
    vi.useRealTimers();
  });

  it("loads the Hub and opens a searchable record inspector through typed IPC", async () => {
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Ködade app data");
    expect(container.textContent).toContain("Core storage is ready.");
    expect(container.textContent).toContain("Mapped project knowledge");
    expect(container.textContent).toContain("current · 7 documents");
    expect(container.textContent).toContain("C:\\ProjectsVault\\10-Projects\\kodade");
    expect(container.textContent).toContain("STATE.md");
    expect(container.textContent).toContain("Use SQLite WAL");
    expect(container.textContent).toContain("Ködade app data");
    expect(invoke).toHaveBeenCalledWith(CMD.memoryContext, { workspaceId: "ws_1" });

    const mappedState = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "STATE.md",
    );
    await act(async () => {
      mappedState?.click();
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith(CMD.readFile, {
      path: "C:\\ProjectsVault\\10-Projects\\kodade\\STATE.md",
    });

    const recordButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Use SQLite WAL"),
    );
    await act(async () => {
      recordButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith(CMD.memoryGet, { id: "mem_1" });
    expect(container.textContent).toContain("Keep the shared memory boundary local.");
    expect(container.textContent).toContain("user via kodade-ui · version 2");
    expect(container.textContent).toContain(
      `Created ${new Date(decision.createdAt).toLocaleString()}`,
    );
    expect(container.textContent).toContain(
      `Last updated ${new Date(decision.updatedAt).toLocaleString()}`,
    );
    expect(container.textContent).toContain("revise · kodade-ui");
  });

  it("shows an actionable mapped-project refresh error", async () => {
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
          projectKnowledge: {
            projectId: "kodade",
            projectDisplayName: "Ködade",
            origin: "C:\\ProjectsVault\\10-Projects\\kodade",
            sync: {
              status: "error",
              refreshedAt: 5,
              indexedDocuments: 0,
              indexHash: null,
              truncated: false,
              error: "STATE.md is missing. Repair the mapped project folder and retry.",
            },
            sources: [],
          },
        });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("STATE.md is missing");
    expect(alert?.textContent).toContain("Repair the mapped project folder");
  });

  it("keeps the empty state concise and opens a new memory", async () => {
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({
          items: [],
          total: 0,
          limit: 100,
          offset: 0,
        });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("No saved memories yet");
    expect(container.textContent).toContain(
      "Timeline checkpoints are session history. Saved memories are durable decisions, tasks, facts, preferences, or summaries.",
    );
    expect(container.textContent).not.toContain("Connect an agent once");
    expect(container.textContent).not.toContain("Use it in agent sessions");
    expect(container.textContent).not.toContain(
      "Project context that survives agent sessions.",
    );

    const create = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Create memory"),
    );
    expect(create).toBeDefined();
    await act(async () => create?.click());

    expect(
      container.querySelector('input[aria-label="memory title"]'),
    ).not.toBeNull();
  });

  it("shows the readable working-memory files and checkpoint provenance", async () => {
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
          workingMemory: {
            directory: ".kodade/memory",
            state: "# Project state",
            recentWorklog: "# Project worklog",
          },
        });
      }
      if (command === CMD.memoryWorkingStatus) {
        return Promise.resolve({
          enabled: true,
          mode: "commit",
          directory: ".kodade/memory",
          statePath: ".kodade/memory/STATE.md",
          worklogPath: ".kodade/memory/WORKLOG.md",
          decisionsPath: ".kodade/memory/decisions.md",
          lastIndexedAt: 10,
          lastCommit: null,
        });
      }
      if (command === CMD.memorySearchCheckpoints) {
        return Promise.resolve({
          items: [{
            id: "cp_timeline",
            workspaceId: workspace.id,
            summary: "Renderer handoff",
            excerpt: "Renderer handoff",
            source: "agent",
            sourceClient: "codex",
            sessionId: "session-42",
            createdAt: Date.UTC(2026, 6, 31),
          }],
          total: 1,
          limit: 50,
          offset: 0,
        });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Committed with the project");
    expect(container.textContent).toContain("STATE.md");
    expect(container.textContent).toContain("WORKLOG.md");
    expect(container.textContent).toContain("Renderer handoff");
    expect(container.textContent).toContain("codex · session-42 ·");
  });

  it("activates committed working memory with the optional durable export", async () => {
    let active = false;
    const status = {
      enabled: true,
      mode: "commit",
      directory: ".kodade/memory",
      statePath: ".kodade/memory/STATE.md",
      worklogPath: ".kodade/memory/WORKLOG.md",
      decisionsPath: ".kodade/memory/decisions.md",
      lastIndexedAt: 10,
      lastCommit: null,
    };
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
          workingMemory: active
            ? { directory: ".kodade/memory", state: "", recentWorklog: "" }
            : null,
        });
      }
      if (command === CMD.memoryWorkingStatus) return Promise.resolve(active ? status : null);
      if (command === CMD.memorySearchCheckpoints) {
        return Promise.resolve({ items: [], total: 0, limit: 50, offset: 0 });
      }
      if (command === CMD.memoryActivateWorking) {
        active = true;
        return Promise.resolve(status);
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const activate = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "activate working memory",
    );
    await act(async () => {
      activate?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith(CMD.memoryActivateWorking, {
      workspaceId: workspace.id,
      mode: "commit",
      exportExisting: true,
    });
  });

  it("shows one transactional Claude and Codex setup with an access toggle", async () => {
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await expandAgentSetup();

    expect(container.textContent).toContain("Connect agents");
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("One preview installs the project workflow");
    expect(container.textContent).toContain("review setup");
    expect(invoke).toHaveBeenCalledWith(CMD.memoryMcpBinaryPath);
    const scrollRegion = container.querySelector<HTMLElement>(
      '[data-kodmem-scroll="true"]',
    );
    expect(scrollRegion?.getAttribute("aria-label")).toBe(
      "KödMem navigation and setup",
    );
    expect(scrollRegion?.tabIndex).toBe(0);
    expect(scrollRegion?.classList.contains("overflow-y-auto")).toBe(true);

    const readOnly = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("read-only access"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(readOnly).not.toBeNull();
    await act(async () => {
      readOnly?.click();
    });

    expect(readOnly?.checked).toBe(true);
  });

  it("reports the installed read-only mode independently from the setup toggle", async () => {
    const readOnlyConfig = JSON.stringify({
      mcpServers: {
        "kodade-mem": {
          command: "/Applications/Ködade/kodade-mcp",
          args: [
            "--workspace",
            workspace.canonicalRoot,
            "--client",
            "claude",
            "--read-only",
          ],
        },
      },
    });
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({
          items: [],
          total: 0,
          limit: 100,
          offset: 0,
        });
      }
      if (command === CMD.configEnv) {
        return Promise.resolve({
          home: "/Users/developer",
          platform: "mac",
          appDataRoaming: null,
          appDataLocal: null,
        });
      }
      if (command === CMD.configRead) {
        const path = (payload as { path?: string } | undefined)?.path;
        if (path?.endsWith(".claude.json")) {
          return Promise.resolve({
            kind: "text",
            content: JSON.stringify({ projects: { [workspace.canonicalRoot]: JSON.parse(readOnlyConfig) } }),
          });
        }
        return Promise.reject(new Error("missing"));
      }
      if (command === CMD.memoryMcpHealth) {
        return Promise.resolve({ ok: true, client: "claude", access: "read-only" });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await expandAgentSetup();
    expect(
      [...container.querySelectorAll("span")].filter(
        (span) => span.textContent === "healthy · read-only",
      ),
    ).toHaveLength(1);

    const readOnly = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("read-only access"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => {
      readOnly?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      [...container.querySelectorAll("span")].filter(
        (span) => span.textContent === "healthy · read-only",
      ),
    ).toHaveLength(1);
  });

  it("offers Disconnect when managed config is installed but health is failing", async () => {
    const setup = buildMemoryMcpSetup({
      workspaceId: workspace.id,
      workspaceRoot: workspace.canonicalRoot,
      binaryPath: "/Applications/Ködade/kodade-mcp",
      readOnly: false,
    });
    if (setup.state !== "ready") throw new Error("fixture setup failed");
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({ workspace, latestCheckpoint: null, pinnedDecisions: [], openTasks: [], recentMemories: [] });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      if (command === CMD.configEnv) {
        return Promise.resolve({ home: "/Users/developer", platform: "mac", appDataRoaming: null, appDataLocal: null });
      }
      if (command === CMD.configRead) {
        const path = (payload as { path?: string } | undefined)?.path;
        if (path?.endsWith(".claude.json")) {
          return Promise.resolve({
            kind: "text",
            content: JSON.stringify({
              projects: {
                [workspace.canonicalRoot]: {
                  mcpServers: { [setup.spec("claude").name]: setup.spec("claude").config },
                },
              },
            }),
          });
        }
        return Promise.reject(new Error("missing"));
      }
      if (command === CMD.memoryMcpHealth) {
        return Promise.resolve({
          ok: false,
          client: "claude",
          access: "read-write",
          workspaceId: workspace.id,
          projectId: "kodade",
          stateHash: null,
          tools: [],
          stage: "authority",
          message: "Migrate legacy project memory before enabling writable agent access",
          action: "migrateLegacyMemory",
        });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await expandAgentSetup();

    expect(container.textContent).toContain("configured · unhealthy");
    expect([...container.querySelectorAll("button")].some(
      (button) => button.textContent === "disconnect",
    )).toBe(true);
    const migration = container.querySelector<HTMLAnchorElement>(
      'a[href="#project-knowledge-setup"]',
    );
    expect(migration?.textContent).toBe("review project migration");
    expect(container.textContent).toContain(
      "Writable agent access needs active project knowledge authority.",
    );
  });

  it("stages the full onboarding transaction through the shared preview", async () => {
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({ workspace, latestCheckpoint: null, pinnedDecisions: [], openTasks: [], recentMemories: [] });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      if (command === CMD.configEnv) {
        return Promise.resolve({ home: "/Users/developer", platform: "mac", appDataRoaming: null, appDataLocal: null });
      }
      if (command === CMD.configRead) {
        const path = (payload as { path?: string } | undefined)?.path ?? "";
        if (path.endsWith(".claude.json")) return Promise.resolve({ kind: "text", content: '{ "projects": {} }\n' });
        if (path.endsWith("config.toml")) return Promise.resolve({ kind: "text", content: "" });
        return Promise.resolve({ kind: "text", content: "# Existing\n" });
      }
      if (command === CMD.configReadOptionalText) {
        const path = (payload as { path?: string } | undefined)?.path ?? "";
        if (path.endsWith(".claude.json")) return Promise.resolve('{ "projects": {} }\n');
        if (path.endsWith("config.toml")) return Promise.resolve("");
        return Promise.resolve("# Existing\n");
      }
      if (command === CMD.configExternalSkillSnapshot) return Promise.reject(new Error("missing"));
      if (command === CMD.configScan) return Promise.resolve({ status: "missing", root: "skills" });
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await expandAgentSetup();
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "review setup",
    );
    await act(async () => {
      review?.click();
      // The preview batch is assembled from several async config reads; wait on
      // the concrete outcome (the staged-change dialog rendering) instead of a
      // fixed delay that can fire before those reads settle under CI load.
      await vi.waitFor(() => {
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      });
    });

    expect(invoke).toHaveBeenCalledWith(CMD.configReadOptionalText, {
      path: "/Users/developer/.claude.json",
      projectRoot: workspace.canonicalRoot,
    });
    expect(harnessStore.getState().mutationError).toBeNull();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("apply 6 changes as one reversible batch");
    expect(container.textContent).toContain("configure KödMCP for claude");
    expect(container.textContent).toContain("configure KödMCP for codex");

    await act(async () => harnessStore.getState().cancelPendingChange());
  });

  it("reconciles a mapped project's missing connectors after one-time approval", async () => {
    const originalConfirm = harnessStore.getState().confirmPendingChange;
    const confirm = vi.fn(async () => {
      harnessStore.setState({
        applying: false,
        pendingChange: null,
        mutationError: null,
      });
    });
    harnessStore.setState({ confirmPendingChange: confirm });
    appStore.setState({
      memoryAgentAccess: { enabled: true, access: "read-only" },
    });
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
          projectKnowledge: {
            projectId: "kodade",
            projectDisplayName: "Ködade",
            origin: "C:\\ProjectsVault\\10-Projects\\kodade",
            sync: {
              status: "current",
              refreshedAt: 5,
              indexedDocuments: 1,
              indexHash: "a".repeat(64),
              truncated: false,
              error: null,
            },
            sources: [],
          },
        });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      if (command === CMD.configEnv) {
        return Promise.resolve({
          home: "/Users/developer",
          platform: "mac",
          appDataRoaming: null,
          appDataLocal: null,
        });
      }
      if (command === CMD.configRead) {
        const path = (payload as { path?: string } | undefined)?.path ?? "";
        if (path.endsWith(".claude.json")) {
          return Promise.resolve({ kind: "text", content: '{ "projects": {} }\n' });
        }
        if (path.endsWith("config.toml")) {
          return Promise.resolve({ kind: "text", content: "" });
        }
        return Promise.resolve({ kind: "text", content: "# Existing\n" });
      }
      if (command === CMD.configReadOptionalText) {
        const path = (payload as { path?: string } | undefined)?.path ?? "";
        if (path.endsWith(".claude.json")) return Promise.resolve('{ "projects": {} }\n');
        if (path.endsWith("config.toml")) return Promise.resolve("");
        return Promise.resolve("# Existing\n");
      }
      if (command === CMD.configExternalSkillSnapshot) {
        return Promise.reject(new Error("missing"));
      }
      if (command === CMD.configScan) {
        return Promise.resolve({ status: "missing", root: "skills" });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    try {
      await act(async () => {
        root.render(<MemoryPane workspaceId={workspace.id} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      // Reconciliation loads context, detects the missing connectors, then
      // auto-invokes confirmPendingChange. Poll that callback (a non-DOM
      // condition) rather than guessing a wall-clock delay for the chain.
      await act(async () => {
        await vi.waitFor(() => {
          expect(confirm).toHaveBeenCalled();
        });
      });

      expect(confirm).toHaveBeenCalledWith({
        surface: "memory",
        scopeId: workspace.id,
      });
      expect(container.textContent).toContain(
        "Approved access is maintained for mapped projects.",
      );
    } finally {
      harnessStore.setState({ confirmPendingChange: originalConfirm });
    }
  });

  it("keeps a staged KödMCP merge owned by its workspace across an unmount and remount", async () => {
    mockInvoke((command: string, payload?: unknown) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({ workspace, latestCheckpoint: null, pinnedDecisions: [], openTasks: [], recentMemories: [] });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      if (command === CMD.configEnv) {
        return Promise.resolve({ home: "/Users/developer", platform: "mac", appDataRoaming: null, appDataLocal: null });
      }
      if (command === CMD.configRead) return Promise.resolve({ kind: "text", content: "" });
      if (command === CMD.configReadOptionalText) {
        const path = (payload as { path?: string } | undefined)?.path ?? "";
        return Promise.resolve(path.endsWith(".claude.json") ? "{}" : "");
      }
      if (command === CMD.configExternalSkillSnapshot) return Promise.reject(new Error("missing"));
      if (command === CMD.configScan) return Promise.resolve({ status: "missing", root: "skills" });
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Wait for the loaded pane to render the agent-setup section (its toggle
    // button) before expanding it, rather than a fixed sleep that can race the
    // initial context/config reads under CI load.
    await act(async () => {
      await vi.waitFor(() => {
        expect(
          container.querySelector('button[aria-controls="kodmem-agent-setup"]'),
        ).not.toBeNull();
      });
    });
    await expandAgentSetup();
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === "review setup");
    await act(async () => {
      add?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harnessStore.getState().pendingChange?.owner).toEqual({ surface: "memory", scopeId: workspace.id });

    await act(async () => root.render(<div />));
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const cancel = [...container.querySelectorAll("button")].find((button) => button.textContent === "cancel");
    await act(async () => cancel?.click());
    expect(harnessStore.getState().pendingChange).toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "review setup")?.disabled).toBe(false);
  });

  it("explains how to build the helper when it is unavailable", async () => {
    mockInvoke(
      (command: string) => {
        if (command === CMD.memoryContext) {
          return Promise.resolve({ workspace, latestCheckpoint: null, pinnedDecisions: [], openTasks: [], recentMemories: [] });
        }
        if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
          return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
        }
        throw new Error(`unexpected Tauri command: ${command}`);
      },
      { path: null, exists: false },
    );

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await expandAgentSetup();

    expect(container.textContent).toContain("kodade-mcp is not built yet.");
    expect(container.textContent).toContain(
      "cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin kodade-mcp",
    );
  });

  it("polls while KödMem settings is visible and stops when it is hidden", async () => {
    vi.useFakeTimers();
    let contextCalls = 0;
    mockInvoke((command: string) => {
      if (command === CMD.memoryContext) {
        contextCalls += 1;
        return Promise.resolve({ workspace, latestCheckpoint: null, pinnedDecisions: [], openTasks: [], recentMemories: [] });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    try {
      await act(async () => {
        root.render(<MemoryPane workspaceId={workspace.id} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      contextCalls = 0;

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(contextCalls).toBe(1);
      contextCalls = 0;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(contextCalls).toBe(1);

      await act(async () => root.render(<div />));
      contextCalls = 0;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(contextCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes memory preview links through the safe external opener", async () => {
    const linkRecord = {
      ...decision,
      body: "[allowed](https://example.com/docs) [relative](docs/readme.md) [disallowed](mailto:test@example.com)",
    };
    memoryStore.setState({
      workspace,
      context: {
        workspace,
        latestCheckpoint: null,
        pinnedDecisions: [],
        openTasks: [],
        recentMemories: [linkRecord],
      },
      selected: linkRecord,
      selectedAudit: [],
      selectedAuditTotal: 0,
    });
    mockInvoke((command: string) => {
      if (command === CMD.openUrl) return Promise.resolve();
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
    });

    const links = [...container.querySelectorAll<HTMLAnchorElement>("article.markdown-view a")];
    expect(links.map((link) => link.textContent)).toEqual(["allowed", "relative", "disallowed"]);

    const click = (link: HTMLAnchorElement) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      return event;
    };
    const allowedClick = click(links[0]);
    await act(async () => {
      await Promise.resolve();
    });

    expect(allowedClick.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith(CMD.openUrl, { url: "https://example.com/docs" });
    const openerCalls = () => invoke.mock.calls.filter(([command]) => command === CMD.openUrl);

    const relativeClick = click(links[1]);
    const disallowedClick = click(links[2]);
    await act(async () => {
      await Promise.resolve();
    });

    expect(relativeClick.defaultPrevented).toBe(true);
    expect(disallowedClick.defaultPrevented).toBe(true);
    expect(openerCalls()).toHaveLength(1);
  });

  it("keeps delete audit visible and restores the tombstone from the inspector", async () => {
    const deletedAt = Date.now();
    let status: "active" | "deleted" | "restored" = "active";
    mockInvoke((command: string) => {
      const current = status === "deleted"
        ? { ...decision, version: 3, updatedAt: deletedAt, deletedAt }
        : status === "restored"
          ? { ...decision, version: 4, updatedAt: deletedAt + 1 }
          : decision;
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: status === "deleted" ? [] : [current],
          openTasks: [],
          recentMemories: status === "deleted" ? [] : [current],
        });
      }
      if (command === CMD.memoryAudit) {
        return Promise.resolve({
          items:
          status === "active"
            ? []
            : [{
                id: `audit_${status}`,
                workspaceId: workspace.id,
                client: "kodade-ui",
                capability: "memory:write",
                action: status === "deleted" ? "forget" : "restore",
                targetId: decision.id,
                sessionId: null,
                result: "ok",
                occurredAt: current.updatedAt,
              }],
          total: status === "active" ? 0 : 1,
          limit: 100,
          offset: 0,
        });
      }
      if (command === CMD.memoryListDeleted) {
        return Promise.resolve({
          items: status === "deleted" ? [current] : [],
          total: status === "deleted" ? 1 : 0,
          limit: 100,
          offset: 0,
        });
      }
      if (command === CMD.memoryGet) return Promise.resolve(current);
      if (command === CMD.memoryForget) {
        status = "deleted";
        return Promise.resolve({
          id: decision.id,
          workspaceId: workspace.id,
          version: 3,
          deletedAt,
        });
      }
      if (command === CMD.memoryRestore) {
        status = "restored";
        return Promise.resolve({ ...decision, version: 4, updatedAt: deletedAt + 1 });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: confirm,
    });
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const recordButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Use SQLite WAL"),
    );
    await act(async () => {
      recordButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const deleteButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "delete",
    );

    await act(async () => {
      deleteButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Deleted");
    expect(container.textContent).toContain("forget · kodade-ui");
    const restoreButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("restore"),
    );
    await act(async () => {
      restoreButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith(CMD.memoryRestore, {
      id: decision.id,
      expectedVersion: 3,
      sourceClient: "kodade-ui",
      sessionId: null,
    });
    expect(container.textContent).toContain("restore · kodade-ui");
    expect(confirm).toHaveBeenCalledWith("Delete “Use SQLite WAL”?");
  });

  it("describes tombstone restore availability using configured retention", async () => {
    const sevenDayWorkspace = { ...workspace, tombstoneRetentionDays: 7 };
    const deleted = {
      ...decision,
      version: 3,
      updatedAt: Date.now(),
      deletedAt: Date.now(),
    };
    memoryStore.setState({
      workspace: sevenDayWorkspace,
      context: {
        workspace: sevenDayWorkspace,
        latestCheckpoint: null,
        pinnedDecisions: [],
        openTasks: [],
        recentMemories: [],
      },
      selected: deleted,
    });
    mockInvoke((command: string) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace: sevenDayWorkspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        });
      }
      if (command === CMD.memoryAudit || command === CMD.memoryListDeleted) {
        return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
    });

    expect(container.textContent).toContain("Restore is available for 7 days.");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "restore",
      ),
    ).toBe(true);
  });

  it("rediscovers a retained tombstone after reload and restores it from Recently Deleted", async () => {
    const deletedAt = Date.now();
    let restored = false;
    const deleted = {
      ...decision,
      version: 3,
      deletedAt,
      updatedAt: deletedAt,
    };
    mockInvoke((command: string) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: restored ? [decision] : [],
          openTasks: [],
          recentMemories: restored ? [decision] : [],
        });
      }
      if (command === CMD.memoryAudit) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryListDeleted) return Promise.resolve({
        items: restored ? [] : [deleted],
        total: restored ? 0 : 1,
        limit: 100,
        offset: 0,
      });
      if (command === CMD.memoryGet) return Promise.resolve(deleted);
      if (command === CMD.memoryRestore) {
        restored = true;
        return Promise.resolve({ ...decision, version: 4, updatedAt: deletedAt + 1 });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const recentlyDeleted = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Recently Deleted"),
    );
    expect(recentlyDeleted).toBeDefined();
    await act(async () => {
      recentlyDeleted?.click();
      await Promise.resolve();
    });
    const deletedRecord = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Use SQLite WAL"),
    );
    expect(deletedRecord).toBeDefined();
    await act(async () => {
      deletedRecord?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const restoreButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "restore",
    );
    await act(async () => {
      restoreButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith(CMD.memoryRestore, {
      id: decision.id,
      expectedVersion: 3,
      sourceClient: "kodade-ui",
      sessionId: null,
    });
    expect(invoke).toHaveBeenCalledWith(CMD.memoryListDeleted, {
      query: { workspaceId: workspace.id, limit: 100, offset: 0 },
    });
  });

  it("loads the 101st tombstone page, restores it, and shows its targeted audit history", async () => {
    const deletedAt = Date.now();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...decision,
      id: `mem_deleted_${index}`,
      title: `Deleted ${index}`,
      version: 2,
      deletedAt: deletedAt + index,
      updatedAt: deletedAt + index,
    }));
    const oneHundredFirst = {
      ...decision,
      id: "mem_deleted_100",
      title: "Deleted 100",
      version: 2,
      deletedAt: deletedAt + 100,
      updatedAt: deletedAt + 100,
    };
    let restored = false;
    mockInvoke((command: string, payload?: { query?: { offset: number; targetId: string | null } }) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        });
      }
      if (command === CMD.memoryListDeleted) {
        const offset = payload?.query?.offset ?? 0;
        return Promise.resolve(
          restored
            ? { items: firstPage, total: 100, limit: 100, offset }
            : offset === 0
              ? { items: firstPage, total: 101, limit: 100, offset: 0 }
              : { items: [oneHundredFirst], total: 101, limit: 100, offset: 100 },
        );
      }
      if (command === CMD.memoryAudit) {
        return Promise.resolve(
          payload?.query?.targetId === oneHundredFirst.id
            ? {
                items: [{
                  id: "audit_deleted_100",
                  workspaceId: workspace.id,
                  client: "kodade-ui",
                  capability: "memory:write",
                  action: "forget",
                  targetId: oneHundredFirst.id,
                  sessionId: null,
                  result: "ok",
                  occurredAt: deletedAt,
                }],
                total: 1,
                limit: 100,
                offset: 0,
              }
            : { items: [], total: 202, limit: 100, offset: 0 },
        );
      }
      if (command === CMD.memoryGet) return Promise.resolve(oneHundredFirst);
      if (command === CMD.memoryRestore) {
        restored = true;
        return Promise.resolve({ ...oneHundredFirst, version: 3, deletedAt: null });
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const recentlyDeleted = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Recently Deleted"),
    );
    await act(async () => recentlyDeleted?.click());
    const loadMore = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "load more deleted memories",
    );
    expect(loadMore).toBeDefined();
    await act(async () => {
      loadMore?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const deletedRecord = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Deleted 100"),
    );
    await act(async () => {
      deletedRecord?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("forget · kodade-ui");
    expect(invoke).toHaveBeenCalledWith(CMD.memoryListDeleted, {
      query: { workspaceId: workspace.id, limit: 100, offset: 100 },
    });
    const restoreButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "restore",
    );
    await act(async () => {
      restoreButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith(CMD.memoryRestore, {
      id: oneHundredFirst.id,
      expectedVersion: 2,
      sourceClient: "kodade-ui",
      sessionId: null,
    });
  });

  it("loads, selects, and inspects the 101st active search result", async () => {
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
      sourceClient: "kodade-mcp",
      createdAt: 100,
      deletedAt: null,
      links: [],
      backlinks: [],
    };
    mockInvoke((command: string, payload?: { query?: { offset: number; targetId: string | null } }) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        });
      }
      if (command === CMD.memorySearch) {
        const offset = payload?.query?.offset ?? 0;
        return Promise.resolve(
          offset === 0
            ? { items: firstPage, total: 101, limit: 100, offset: 0 }
            : { items: [oneHundredFirst], total: 101, limit: 100, offset: 100 },
        );
      }
      if (command === CMD.memoryAudit) {
        return Promise.resolve(
          payload?.query?.targetId === oneHundredFirst.id
            ? {
                items: [{
                  id: "audit_search_100",
                  workspaceId: workspace.id,
                  client: "kodade-ui",
                  capability: "memory:read",
                  action: "get",
                  targetId: oneHundredFirst.id,
                  sessionId: null,
                  result: "ok",
                  occurredAt: 100,
                }],
                total: 1,
                limit: 100,
                offset: 0,
              }
            : { items: [], total: 0, limit: 100, offset: 0 },
        );
      }
      if (command === CMD.memoryListDeleted) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryGet) return Promise.resolve(inspectable);
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const searchInput = container.querySelector<HTMLInputElement>('input[aria-label="search KödMem"]');
    expect(searchInput).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(searchInput, "active search");
    await act(async () => {
      searchInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const searchButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "search",
    );
    await act(async () => {
      searchButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const loadMore = container.querySelector<HTMLButtonElement>(
      'button[aria-label="load more search results"]',
    );
    expect(loadMore?.textContent).toBe("load more search results");
    await act(async () => {
      loadMore?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const result = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes(oneHundredFirst.title),
    );
    expect(result).toBeDefined();
    await act(async () => {
      result?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith(CMD.memorySearch, {
      query: {
        workspaceId: workspace.id,
        text: "active search",
        kinds: [],
        sources: [],
        updatedAfter: null,
        limit: 100,
        offset: 100,
      },
    });
    expect(container.textContent).toContain("The 101st active search result is inspectable.");
    expect(container.textContent).toContain("get · kodade-ui");
  });

  it("keeps B's unsaved editor draft when A's delayed save completes", async () => {
    const recordA = { ...decision, id: "mem_a", title: "Record A", body: "A original" };
    const recordB = { ...decision, id: "mem_b", title: "Record B", body: "B original" };
    let resolveRevision!: (record: MemoryRecord) => void;
    const pendingRevision = new Promise<MemoryRecord>((resolve) => {
      resolveRevision = resolve;
    });
    mockInvoke((command: string, payload?: { id?: string }) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [recordA, recordB],
        });
      }
      if (command === CMD.memoryAudit) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryListDeleted) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryGet) return Promise.resolve(payload?.id === recordA.id ? recordA : recordB);
      if (command === CMD.memoryRevise) return pendingRevision;
      throw new Error(`unexpected Tauri command: ${command}`);
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const recordAButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes(recordA.title),
    );
    await act(async () => {
      recordAButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const editA = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "edit",
    );
    await act(async () => editA?.click());
    const saveA = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "save",
    );
    await act(async () => {
      saveA?.click();
      await Promise.resolve();
    });
    const recordBButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes(recordB.title),
    );
    await act(async () => {
      recordBButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const editB = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "edit",
    );
    await act(async () => editB?.click());
    const body = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="memory body"]');
    expect(body).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(body, "B unsaved draft");
    await act(async () => {
      body?.dispatchEvent(new Event("input", { bubbles: true }));
      resolveRevision({ ...recordA, body: "A saved", version: 3 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(body?.value).toBe("B unsaved draft");
    expect(container.textContent).toContain(recordB.title);
  });

  it("keeps newer same-record edits when an existing record save completes", async () => {
    let resolveRevision!: (record: MemoryRecord) => void;
    const pendingRevision = new Promise<MemoryRecord>((resolve) => {
      resolveRevision = resolve;
    });
    mockInvoke((command: string) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [decision],
          openTasks: [],
          recentMemories: [decision],
        });
      }
      if (command === CMD.memoryAudit) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryListDeleted) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryGet) return Promise.resolve(decision);
      if (command === CMD.memoryRevise) return pendingRevision;
      throw new Error(`unexpected Tauri command: ${command}`);
    });
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const recordButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes(decision.title),
    );
    await act(async () => {
      recordButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const edit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "edit",
    );
    await act(async () => edit?.click());
    let body = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="memory body"]');
    const setTextArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setTextArea?.call(body, "submitted draft");
    await act(async () => body?.dispatchEvent(new Event("input", { bubbles: true })));
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "save",
    );
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    body = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="memory body"]');
    setTextArea?.call(body, "newer same-record draft");
    await act(async () => {
      body?.dispatchEvent(new Event("input", { bubbles: true }));
      resolveRevision({ ...decision, body: "submitted draft", version: 3 });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="memory body"]')?.value)
      .toBe("newer same-record draft");
  });

  it("keeps newer new-record form edits when its create completes", async () => {
    let resolveCreate!: (record: MemoryRecord) => void;
    const pendingCreate = new Promise<MemoryRecord>((resolve) => {
      resolveCreate = resolve;
    });
    mockInvoke((command: string) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        });
      }
      if (command === CMD.memoryAudit) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryListDeleted) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryRemember) return pendingCreate;
      throw new Error(`unexpected Tauri command: ${command}`);
    });
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const create = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("+ memory"),
    );
    await act(async () => create?.click());
    const title = container.querySelector<HTMLInputElement>('input[aria-label="memory title"]');
    let body = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="memory body"]');
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const setTextArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setInput?.call(title, "Submitted new memory");
    setTextArea?.call(body, "submitted new body");
    await act(async () => {
      title?.dispatchEvent(new Event("input", { bubbles: true }));
      body?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "save",
    );
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    body = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="memory body"]');
    setTextArea?.call(body, "newer new-record draft");
    await act(async () => {
      body?.dispatchEvent(new Event("input", { bubbles: true }));
      resolveCreate({
        ...decision,
        id: "mem_created",
        title: "Submitted new memory",
        body: "submitted new body",
        version: 1,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="memory body"]')?.value)
      .toBe("newer new-record draft");
  });

  it("disables privacy and destructive controls while a memory operation is active", async () => {
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => memoryStore.setState({ saving: true }));

    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="memory retention"]')?.disabled).toBe(true);
    for (const label of ["export", "relink", "purge"]) {
      const control = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
      expect(control?.disabled, `${label} should be disabled`).toBe(true);
    }
  });

  it("gives search, filters, and memory editor fields accessible names", async () => {
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('input[aria-label="search KödMem"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="memory kind filter"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="memory source filter"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="memory date filter"]')).not.toBeNull();
    const createButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("+ memory"),
    );
    await act(async () => createButton?.click());

    expect(container.querySelector('select[aria-label="memory kind"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="memory title"]')).not.toBeNull();
    expect(container.querySelector('textarea[aria-label="memory body"]')).not.toBeNull();
  });

  it("gives the in-pane error dismiss control a usable accessible name", async () => {
    memoryStore.setState({
      workspace,
      context: {
        workspace,
        latestCheckpoint: null,
        pinnedDecisions: [],
        openTasks: [],
        recentMemories: [],
      },
      error: "KödMem could not load the record.",
    });

    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
    });

    expect(
      container.querySelector('button[aria-label="dismiss KödMem error"]'),
    ).not.toBeNull();
  });

  it("relinks the current identity only after the user picks and confirms a new root", async () => {
    const moved = {
      ...workspace,
      canonicalRoot: "D:\\Moved\\Ködade",
      updatedAt: 2,
    };
    let relinked = false;
    mockInvoke((command: string) => {
      if (command === CMD.memoryContext) {
        return Promise.resolve({
          workspace: relinked ? moved : workspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        });
      }
      if (command === CMD.memoryAudit) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryListDeleted) return Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 });
      if (command === CMD.memoryRelinkWorkspace) {
        relinked = true;
        return Promise.resolve(moved);
      }
      throw new Error(`unexpected Tauri command: ${command}`);
    });
    openDialog.mockResolvedValue(moved.canonicalRoot);
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: confirm,
    });
    await act(async () => {
      root.render(<MemoryPane workspaceId={workspace.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const relinkButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "relink",
    );

    await act(async () => {
      relinkButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(confirm).toHaveBeenCalledWith(
      "Relink this KödMem identity to D:\\Moved\\Ködade?",
    );
    expect(invoke).toHaveBeenCalledWith(CMD.memoryRelinkWorkspace, {
      workspaceId: workspace.id,
      expectedRoot: workspace.canonicalRoot,
      newRoot: moved.canonicalRoot,
      sourceClient: "kodade-ui",
    });
  });
});
