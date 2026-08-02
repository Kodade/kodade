import { beforeEach, describe, expect, it, vi } from "vitest";
import { CMD, type MemoryWorkspace } from "../ipc/contract";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  captureProjectActivity,
  createActivityPersistenceBridge,
  installTauriCloseCapture,
  installWebCloseCapture,
  rememberWorkspaceRegistration,
} from "./capture";

const workspace: MemoryWorkspace = {
  id: "ws_moved",
  canonicalRoot: "D:\\Moved\\Ködade",
  displayName: "Ködade",
  color: "mauve",
  capturePaused: false,
  activityRetentionDays: 30,
  auditRetentionDays: 30,
  tombstoneRetentionDays: 30,
  createdAt: 1,
  updatedAt: 2,
};

describe("KödMem activity capture registration", () => {
  beforeEach(() => invoke.mockReset());

  it("never creates an identity for an unregistered path and adopts an explicit relink", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === CMD.memoryResolveWorkspace) return Promise.resolve(null);
      if (command === CMD.memoryRecordActivity) return Promise.resolve(null);
      return Promise.resolve(null);
    });

    await captureProjectActivity(
      { path: "D:\\Unregistered\\Ködade" },
      "projectOpened",
    );

    expect(invoke).toHaveBeenCalledWith(CMD.memoryResolveWorkspace, {
      root: "D:\\Unregistered\\Ködade",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      CMD.memoryRegisterWorkspace,
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      CMD.memoryRecordActivity,
      expect.anything(),
    );

    rememberWorkspaceRegistration(workspace, "C:\\Work\\Ködade");
    await captureProjectActivity(
      { path: workspace.canonicalRoot },
      "projectOpened",
    );

    expect(invoke).toHaveBeenCalledWith(CMD.memoryRecordActivity, {
      input: {
        workspaceId: workspace.id,
        kind: "projectOpened",
        source: "kodade-ui",
        sessionId: null,
        relativePath: null,
        provider: null,
        occurredAt: null,
      },
    });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      CMD.memoryResolveWorkspace,
      CMD.memoryRecordActivity,
    ]);
  });

  it("persists initial project-open and foreground active/idle without process text", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === CMD.memoryRecordActivity) return Promise.resolve({ id: "act_1" });
      return Promise.resolve(null);
    });
    rememberWorkspaceRegistration(workspace);
    const bridge = createActivityPersistenceBridge();
    const project = { id: "project-1", path: workspace.canonicalRoot };

    await bridge.projectSelectionChanged(null, project);
    await bridge.ensureInitialProjectOpened(project);
    await bridge.workspaceFact(project, {
      type: "terminal-foreground",
      projectId: project.id,
      sessionId: "session-1",
      process: "codex --dangerously-bypass-approvals-and-sandbox",
    });
    await bridge.workspaceFact(project, {
      type: "terminal-foreground",
      projectId: project.id,
      sessionId: "session-1",
      process: null,
    });

    const activityInputs = invoke.mock.calls
      .filter(([command]) => command === CMD.memoryRecordActivity)
      .map(([, payload]) => payload.input);
    expect(activityInputs).toEqual([
      {
        workspaceId: workspace.id,
        kind: "projectOpened",
        source: "kodade-ui",
        sessionId: null,
        relativePath: null,
        provider: null,
        occurredAt: null,
      },
      {
        workspaceId: workspace.id,
        kind: "active",
        source: "kodade-ui",
        sessionId: "session-1",
        relativePath: null,
        provider: null,
        occurredAt: null,
      },
      {
        workspaceId: workspace.id,
        kind: "idle",
        source: "kodade-ui",
        sessionId: "session-1",
        relativePath: null,
        provider: null,
        occurredAt: null,
      },
    ]);
    expect(JSON.stringify(activityInputs)).not.toContain("dangerously-bypass");
  });

  it("serializes rapid A to B to C project lifecycle capture in event order", async () => {
    const events: string[] = [];
    const firstClose = deferred<boolean>();
    const capture = vi.fn((project: { id?: string }, kind: string) => {
      events.push(`${project.id}:${kind}`);
      return project.id === "A" && kind === "projectClosed"
        ? firstClose.promise
        : Promise.resolve(true);
    });
    const bridge = createActivityPersistenceBridge(capture as typeof captureProjectActivity);
    const projectA = { id: "A", path: "D:\\Work\\A" };
    const projectB = { id: "B", path: "D:\\Work\\B" };
    const projectC = { id: "C", path: "D:\\Work\\C" };

    await bridge.ensureInitialProjectOpened(projectA);
    const switchToB = bridge.projectSelectionChanged(projectA, projectB);
    await Promise.resolve();
    const switchToC = bridge.projectSelectionChanged(projectB, projectC);
    firstClose.resolve(true);
    await Promise.all([switchToB, switchToC]);

    expect(events).toEqual([
      "A:projectOpened",
      "A:projectClosed",
      "B:projectOpened",
      "B:projectClosed",
      "C:projectOpened",
    ]);
  });

  it("records the missing open after an active unregistered project gains a KödMem identity", async () => {
    const lateWorkspace: MemoryWorkspace = {
      ...workspace,
      id: "ws_late",
      canonicalRoot: "D:\\Unregistered\\LateIdentity",
    };
    invoke.mockImplementation((command: string) => {
      if (command === CMD.memoryResolveWorkspace) return Promise.resolve(null);
      if (command === CMD.memoryRecordActivity) return Promise.resolve({ id: "act_1" });
      return Promise.resolve(null);
    });
    const bridge = createActivityPersistenceBridge();
    const project = { id: "late-project", path: lateWorkspace.canonicalRoot };

    await bridge.projectSelectionChanged(null, project);
    rememberWorkspaceRegistration(lateWorkspace);
    await bridge.ensureInitialProjectOpened(project);
    await bridge.closeActiveProject(project);

    const kinds = invoke.mock.calls
      .filter(([command]) => command === CMD.memoryRecordActivity)
      .map(([, payload]) => payload.input.kind);
    expect(kinds).toEqual(["projectOpened", "projectClosed"]);
  });

  it("serializes deferred session start and exit through the same activity queue", async () => {
    const events: string[] = [];
    const started = deferred<boolean>();
    const capture = vi.fn((_: { id?: string }, kind: string) => {
      events.push(kind);
      return kind === "sessionStarted" ? started.promise : Promise.resolve(true);
    });
    const bridge = createActivityPersistenceBridge(capture as typeof captureProjectActivity);
    const project = { id: "project-1", path: "D:\\Work\\Ködade" };

    const starting = bridge.recordActivity(project, "sessionStarted", {
      sessionId: "session-1",
    });
    const exiting = bridge.recordActivity(project, "sessionExited", {
      sessionId: "session-1",
    });
    await Promise.resolve();
    expect(events).toEqual(["sessionStarted"]);

    started.resolve(true);
    await Promise.all([starting, exiting]);
    expect(events).toEqual(["sessionStarted", "sessionExited"]);
  });

  it("captures the final active project before one terminal Tauri destruction", async () => {
    const project = { id: "A", path: "D:\\Work\\A" };
    const lifecycle: string[] = [];
    const capture = deferred<void>();
    const closeActiveProject = vi.fn(() => {
      lifecycle.push("capture");
      return capture.promise;
    });
    let handler!: (event: { preventDefault(): void }) => Promise<void>;
    const appWindow = {
      onCloseRequested: vi.fn(async (next) => {
        handler = next;
        return () => undefined;
      }),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(async () => {
        lifecycle.push("destroy");
      }),
    };
    await installTauriCloseCapture({
      appWindow,
      activeProject: () => project,
      bridge: { closeActiveProject },
      timeoutMs: 50,
    });

    const preventDefault = vi.fn();
    const repeatedPreventDefault = vi.fn();
    const closeRequests = Promise.all([
      handler({ preventDefault }),
      handler({ preventDefault: repeatedPreventDefault }),
    ]);

    await Promise.resolve();
    expect(appWindow.destroy).not.toHaveBeenCalled();
    capture.resolve(undefined);
    await closeRequests;

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(repeatedPreventDefault).toHaveBeenCalledOnce();
    expect(closeActiveProject).toHaveBeenCalledWith(project);
    expect(lifecycle).toEqual(["capture", "destroy"]);
    expect(appWindow.destroy).toHaveBeenCalledOnce();
    expect(appWindow.close).not.toHaveBeenCalled();
  });

  it("bounds a stalled final-close capture before destroying the Tauri window", async () => {
    let handler!: (event: { preventDefault(): void }) => Promise<void>;
    const appWindow = {
      onCloseRequested: vi.fn(async (next) => {
        handler = next;
        return () => undefined;
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    await installTauriCloseCapture({
      appWindow,
      activeProject: () => ({ id: "A", path: "D:\\Work\\A" }),
      bridge: { closeActiveProject: vi.fn(() => new Promise<void>(() => undefined)) },
      timeoutMs: 0,
    });

    await handler({ preventDefault: vi.fn() });
    expect(appWindow.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the Tauri window after final-close capture rejects", async () => {
    const captureError = new Error("storage unavailable");
    const closeActiveProject = vi.fn().mockRejectedValue(captureError);
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let handler!: (event: { preventDefault(): void }) => Promise<void>;
    const appWindow = {
      onCloseRequested: vi.fn(async (next) => {
        handler = next;
        return () => undefined;
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    try {
      await installTauriCloseCapture({
        appWindow,
        activeProject: () => ({ id: "A", path: "D:\\Work\\A" }),
        bridge: { closeActiveProject },
        timeoutMs: 50,
      });

      await handler({ preventDefault: vi.fn() });

      expect(closeActiveProject).toHaveBeenCalledOnce();
      expect(appWindow.destroy).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalledWith(
        "kodade: final local activity capture failed",
        captureError,
      );
    } finally {
      logError.mockRestore();
    }
  });

  it("allows a later close request to retry failed window destruction", async () => {
    const destroyError = new Error("window busy");
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let handler!: (event: { preventDefault(): void }) => Promise<void>;
    const appWindow = {
      onCloseRequested: vi.fn(async (next) => {
        handler = next;
        return () => undefined;
      }),
      destroy: vi
        .fn()
        .mockRejectedValueOnce(destroyError)
        .mockResolvedValueOnce(undefined),
    };

    try {
      await installTauriCloseCapture({
        appWindow,
        activeProject: () => null,
        bridge: { closeActiveProject: vi.fn().mockResolvedValue(undefined) },
      });

      await handler({ preventDefault: vi.fn() });
      await handler({ preventDefault: vi.fn() });

      expect(appWindow.destroy).toHaveBeenCalledTimes(2);
      expect(logError).toHaveBeenCalledWith(
        "kodade: window destruction after activity capture failed",
        destroyError,
      );
    } finally {
      logError.mockRestore();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// A minimal window/document double that records listeners and lets a test fire
// lifecycle events and flip visibility.
function fakeLifecycle() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener(type: string, cb: () => void) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      listeners.get(type)?.delete(cb);
    },
    fire(type: string) {
      for (const cb of listeners.get(type) ?? []) cb();
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe("web lifecycle close capture", () => {
  const project = { id: "A", path: "D:\\Work\\A" };

  it("flushes the final project-close record on pagehide", async () => {
    const env = fakeLifecycle();
    const closeActiveProject = vi.fn().mockResolvedValue(undefined);
    const stop = installWebCloseCapture({
      activeProject: () => project,
      bridge: { closeActiveProject },
      win: env,
      doc: env,
    });

    env.fire("pagehide");
    await Promise.resolve();
    expect(closeActiveProject).toHaveBeenCalledWith(project);
    stop();
    expect(env.count("pagehide")).toBe(0);
    expect(env.count("visibilitychange")).toBe(0);
  });

  it("flushes when hidden but not on a mere visibility toggle to visible", async () => {
    const env = fakeLifecycle();
    const closeActiveProject = vi.fn().mockResolvedValue(undefined);
    installWebCloseCapture({
      activeProject: () => project,
      bridge: { closeActiveProject },
      win: env,
      doc: env,
    });

    env.visibilityState = "visible";
    env.fire("visibilitychange");
    expect(closeActiveProject).not.toHaveBeenCalled();

    env.visibilityState = "hidden";
    env.fire("visibilitychange");
    await Promise.resolve();
    expect(closeActiveProject).toHaveBeenCalledOnce();
  });

  it("periodically flushes only while the tab is hidden", () => {
    vi.useFakeTimers();
    try {
      const env = fakeLifecycle();
      const closeActiveProject = vi.fn().mockResolvedValue(undefined);
      const stop = installWebCloseCapture({
        activeProject: () => project,
        bridge: { closeActiveProject },
        flushIntervalMs: 1_000,
        win: env,
        doc: env,
      });

      // Visible: the periodic timer must never close the active project.
      vi.advanceTimersByTime(3_000);
      expect(closeActiveProject).not.toHaveBeenCalled();

      env.visibilityState = "hidden";
      vi.advanceTimersByTime(1_000);
      expect(closeActiveProject).toHaveBeenCalledOnce();

      stop();
      vi.advanceTimersByTime(5_000);
      expect(closeActiveProject).toHaveBeenCalledOnce(); // timer cleared
    } finally {
      vi.useRealTimers();
    }
  });
});
