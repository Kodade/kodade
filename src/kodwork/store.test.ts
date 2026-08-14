// KödWork task store (#43): run lifecycle, the settle discipline, the KödMem
// completion checkpoint, persistence, gating, and the privacy boundary.
// Driven with the real adapters against the real IPC mocks — only the process
// is fake.

import { describe, expect, it, vi } from "vitest";
import { MockAgentIpc, MockStorage } from "../ipc/mock";
import { CLAUDE_TOOL_TURN } from "../agents/fixtures";
import type { MemoryWorkspace, NewCheckpoint } from "../ipc/contract";
import {
  kodworkDocName,
  parsePersistedTask,
  taskGroup,
  titleFromOutcome,
} from "./model";
import { createKodworkStore, type KodworkDeps, type KodworkMemory } from "./store";

// Records checkpoints; resolves every folder to one workspace unless told not to.
function fakeMemory(resolves = true) {
  const checkpoints: NewCheckpoint[] = [];
  const resolved: string[] = [];
  const memory: KodworkMemory = {
    resolveWorkspace: async (root: string) => {
      resolved.push(root);
      return resolves
        ? ({ id: "ws-1", canonicalRoot: root } as unknown as MemoryWorkspace)
        : null;
    },
    checkpoint: async (input: NewCheckpoint) => {
      checkpoints.push(input);
      return { id: `cp-${checkpoints.length}` } as never;
    },
  };
  return { memory, checkpoints, resolved };
}

function setup(overrides: Partial<KodworkDeps> = {}) {
  const agent = new MockAgentIpc();
  const storage = new MockStorage();
  const { memory, checkpoints, resolved } = fakeMemory();
  let seq = 0;
  const store = createKodworkStore({
    agent,
    storage,
    memory,
    projectRoot: () => "/repo",
    enabled: () => true,
    newId: () => `id-${++seq}`,
    now: () => 1_000,
    // Write on the next tick instead of on a timer, so tests stay synchronous.
    persistDebounceMs: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (handle) => clearTimeout(handle),
    ...overrides,
  });
  return { agent, storage, store, checkpoints, resolved };
}

// A drafted, described task ready to start.
async function draftTask(store: ReturnType<typeof setup>["store"], outcome = "tidy the docs folder") {
  await store.getState().openTask("t1", "p1");
  store.getState().setOutcome("t1", outcome);
}

// One synthetic TodoWrite frame in the claude dialect (see adapters.test.ts).
const CLAUDE_PLAN_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_plan",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_plan",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "Read the file", status: "completed" },
            { content: "Explain it", status: "in_progress" },
          ],
        },
      },
    ],
  },
});

describe("a task run", () => {
  it("spawns headlessly in the task folder with the access args and the outcome on stdin", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await draftTask(store);
    store.getState().setAccess("t1", "full");
    await store.getState().startTask("t1");

    expect(agent.starts).toHaveLength(1);
    expect(agent.starts[0]).toMatchObject({
      id: "t1#1",
      cwd: "/repo",
      bin: "claude",
      stdin: "tidy the docs folder",
    });
    expect(agent.starts[0].args).toContain("--dangerously-skip-permissions");
    expect(store.getState().tasks.t1.state).toBe("running");
    expect(store.getState().tasks.t1.title).toBe(titleFromOutcome("tidy the docs folder"));
  });

  it("defaults to Claude Code at standard access in the project root", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");

    const args = agent.starts[0].args;
    expect(store.getState().tasks.t1.providerId).toBe("claude");
    expect(store.getState().tasks.t1.folder).toBe("/repo");
    expect(args).toContain("acceptEdits");
  });

  it("projects the stream into plan items, tool lines, status, summary, and usage", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");

    agent.emit("t1#1", CLAUDE_PLAN_LINE);
    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);

    const task = store.getState().tasks.t1;
    expect(task.state).toBe("done");
    expect(task.plan).toEqual([
      { text: "Read the file", status: "completed" },
      { text: "Explain it", status: "in-progress" },
    ]);
    const read = task.tools.find((line) => line.tool === "Read");
    expect(read).toMatchObject({
      tool: "Read",
      detail: "/private/tmp/kodchat-probe/note.txt",
      ok: true,
    });
    expect(task.summary).toContain("The file contains");
    expect(task.usage).toEqual({ promptTokens: 18, completionTokens: 152, totalTokens: 170 });
    expect(task.resumeId).toBe("11111111-2222-3333-4444-555555555555");
    // Settled: the live status line is cleared.
    expect(task.statusText).toBeNull();
    expect(task.settledAt).not.toBeNull();
  });

  it("refuses an empty outcome and a second concurrent run", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await store.getState().openTask("t1", "p1");
    await store.getState().startTask("t1"); // no outcome yet
    expect(agent.starts).toHaveLength(0);

    store.getState().setOutcome("t1", "do the thing");
    await store.getState().startTask("t1");
    await store.getState().startTask("t1");
    expect(agent.starts).toHaveLength(1);
  });

  it("locks draft edits while the run is live", async () => {
    const { store } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");

    store.getState().setOutcome("t1", "changed mid-run");
    store.getState().setProvider("t1", "codex");
    store.getState().setAccess("t1", "full");
    store.getState().setFolder("t1", "/elsewhere");
    expect(store.getState().tasks.t1).toMatchObject({
      outcome: "tidy the docs folder",
      providerId: "claude",
      access: "standard",
      folder: "/repo",
    });
  });

  it("drops events from a superseded run", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    agent.exit("t1#1", 0);
    await store.getState().startTask("t1");

    // A late line from the finished first run must not touch run two.
    agent.emit("t1#1", CLAUDE_PLAN_LINE);
    expect(store.getState().tasks.t1.plan).toEqual([]);
  });
});

describe("settling", () => {
  it("cancel marks the task cancelled once the exit lands, without a checkpoint", async () => {
    const { agent, store, checkpoints } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    await store.getState().cancelTask("t1");

    expect(agent.cancels).toEqual([{ id: "t1#1" }]);
    // Still running until the process actually dies.
    expect(store.getState().tasks.t1.state).toBe("running");
    agent.exit("t1#1", 143, "");
    expect(store.getState().tasks.t1.state).toBe("cancelled");
    expect(checkpoints).toHaveLength(0);
  });

  it("a crash settles failed with the error recorded, without a checkpoint", async () => {
    const { agent, store, checkpoints } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    agent.exit("t1#1", 1, "segmentation fault");

    expect(store.getState().tasks.t1).toMatchObject({
      state: "failed",
      error: "segmentation fault",
      needsLogin: false,
    });
    expect(checkpoints).toHaveLength(0);
  });

  it("an auth failure settles needs-user and flags the login path", async () => {
    const { agent, store, checkpoints } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    agent.exit("t1#1", 1, "Not logged in. Run `claude login` to continue.");

    expect(store.getState().tasks.t1).toMatchObject({
      state: "needs-user",
      needsLogin: true,
    });
    expect(checkpoints).toHaveLength(0);
  });

  it("a failed spawn records the error and frees the task", async () => {
    const { agent, store } = setup();
    agent.failStartWith = new Error("claude is not installed or not on PATH");
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");

    expect(store.getState().tasks.t1).toMatchObject({
      state: "failed",
      error: "claude is not installed or not on PATH",
    });
    await store.getState().startTask("t1");
    expect(agent.starts).toHaveLength(2);
  });
});

describe("the completion checkpoint", () => {
  it("writes ids and counts through KödMem with sourceClient kodwork — never task text", async () => {
    const { agent, store, checkpoints, resolved } = setup();
    await store.getState().start();
    await draftTask(store, "a secret outcome nobody should log");
    await store.getState().startTask("t1");
    agent.emit("t1#1", CLAUDE_PLAN_LINE);
    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);
    await vi.waitFor(() => expect(checkpoints).toHaveLength(1));

    expect(resolved).toEqual(["/repo"]);
    // 2 tool calls: the TodoWrite that carried the plan, plus the Read.
    expect(checkpoints[0]).toEqual({
      workspaceId: "ws-1",
      summary: "KödWork task completed: 1/2 plan items, 2 tool calls.",
      decisions: [],
      nextActions: [],
      changedPaths: [],
      source: "kodade",
      sourceClient: "kodwork",
      sessionId: "t1",
      idempotencyKey: "kodwork:t1:1",
    });
    expect(JSON.stringify(checkpoints)).not.toContain("secret outcome");
  });

  it("skips the checkpoint quietly when the folder maps to no workspace", async () => {
    const { memory, checkpoints } = fakeMemory(false);
    const { agent, store } = setup({ memory });
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getState().tasks.t1.state).toBe("done");
    expect(checkpoints).toHaveLength(0);
  });
});

describe("resume", () => {
  it("continues the CLI's saved session and keeps earned progress", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    agent.emit("t1#1", CLAUDE_PLAN_LINE);
    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);
    expect(store.getState().tasks.t1.resumeId).toBe(
      "11111111-2222-3333-4444-555555555555",
    );

    await store.getState().resumeTask("t1", "also update the README");
    expect(agent.starts[1].id).toBe("t1#2");
    expect(agent.starts[1].args.join(" ")).toContain(
      "--resume 11111111-2222-3333-4444-555555555555",
    );
    expect(agent.starts[1].stdin).toBe("also update the README");
    // The plan from the first run survives a resume.
    expect(store.getState().tasks.t1.plan).toHaveLength(2);
    expect(store.getState().tasks.t1.state).toBe("running");
  });

  it("falls back to a fresh start when no session id was captured", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    agent.exit("t1#1", 1, "boom");

    await store.getState().resumeTask("t1");
    expect(agent.starts[1].args).not.toContain("--resume");
    expect(agent.starts[1].stdin).toBe("tidy the docs folder");
  });
});

describe("task persistence", () => {
  it("round-trips a settled task through its own document", async () => {
    const { agent, storage, store } = setup();
    await store.getState().start();
    await draftTask(store);
    store.getState().setAccess("t1", "plan");
    await store.getState().startTask("t1");
    agent.emit("t1#1", CLAUDE_PLAN_LINE);
    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);
    await store.getState().flush("t1");

    // Task documents live OUTSIDE the main document, in their own namespace.
    expect(storage.doc).toBeNull();
    const raw = storage.docs.get(kodworkDocName("t1"));
    expect(raw).toBeTruthy();
    const doc = parsePersistedTask(raw!)!;
    expect(doc).toMatchObject({
      id: "t1",
      state: "done",
      access: "plan",
      resumeId: "11111111-2222-3333-4444-555555555555",
    });

    // A fresh store reading the same disk sees the same task.
    const reopened = createKodworkStore({
      agent: new MockAgentIpc(),
      storage,
      projectRoot: () => "/repo",
      enabled: () => true,
    });
    await reopened.getState().openTask("t1", "p1");
    expect(reopened.getState().tasks.t1).toMatchObject({
      outcome: "tidy the docs folder",
      state: "done",
      plan: doc.plan,
      tools: doc.tools,
      usage: doc.usage,
      resumeId: doc.resumeId,
    });
  });

  it("reloads a task persisted mid-run as needs-user, never stuck running", async () => {
    const { agent, storage, store } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    agent.emit("t1#1", CLAUDE_PLAN_LINE);
    await store.getState().flush("t1");

    const reopened = createKodworkStore({
      agent: new MockAgentIpc(),
      storage,
      projectRoot: () => "/repo",
      enabled: () => true,
    });
    await reopened.getState().openTask("t1", "p1");
    expect(reopened.getState().tasks.t1.state).toBe("needs-user");
  });

  it("survives a corrupt or foreign-version document", async () => {
    const { storage, store } = setup();
    await storage.writeDoc(kodworkDocName("t1"), "{ not json");
    await store.getState().openTask("t1", "p1");
    expect(store.getState().tasks.t1.state).toBe("draft");

    await storage.writeDoc(kodworkDocName("t2"), JSON.stringify({ version: 99, id: "t2" }));
    await store.getState().openTask("t2", "p1");
    expect(store.getState().tasks.t2.state).toBe("draft");
  });

  it("removing a task deletes its document and cancels a live run", async () => {
    const { agent, storage, store } = setup();
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    await store.getState().flush("t1");
    expect(storage.docs.has(kodworkDocName("t1"))).toBe(true);

    await store.getState().removeTask("t1");
    expect(agent.cancels).toEqual([{ id: "t1#1" }]);
    expect(storage.docs.has(kodworkDocName("t1"))).toBe(false);
    expect(store.getState().tasks.t1).toBeUndefined();

    // The late exit for the cancelled run must not resurrect the task.
    agent.exit("t1#1", 143, "");
    expect(store.getState().tasks.t1).toBeUndefined();
  });
});

describe("the development gate", () => {
  it("refuses to register or run anything while KödWork is disabled", async () => {
    const { agent, store } = setup({ enabled: () => false });
    await store.getState().start();
    await store.getState().openTask("t1", "p1");
    expect(store.getState().tasks.t1).toBeUndefined();

    await store.getState().startTask("t1");
    expect(agent.starts).toHaveLength(0);
  });
});

describe("the activity boundary receives metadata only", () => {
  it("never passes task text to the activity hooks", async () => {
    const streamed = vi.fn();
    const working = vi.fn();
    const attention = vi.fn();
    const { agent, store } = setup({ activity: { streamed, working, attention } });
    await store.getState().start();
    await draftTask(store, "a secret outcome nobody should log");
    await store.getState().startTask("t1");
    agent.emit("t1#1", CLAUDE_PLAN_LINE);
    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);

    expect(streamed).toHaveBeenCalledWith("p1", "t1");
    expect(working).toHaveBeenCalledWith("p1", "t1", "claude");
    expect(working).toHaveBeenLastCalledWith("p1", "t1", null);
    // Every argument, across every call, is an id, a provider id, or a fixed
    // short reason.
    const args = [
      ...streamed.mock.calls,
      ...working.mock.calls,
      ...attention.mock.calls,
    ].flat();
    for (const value of args) {
      expect(["p1", "t1", "claude", null, "needs login", "the agent failed"]).toContain(value);
    }
    // The settled run clears attention rather than reporting content.
    expect(attention).toHaveBeenLastCalledWith("p1", "t1", null);
  });

  it("reports needs-login attention when authentication fails", async () => {
    const attention = vi.fn();
    const { agent, store } = setup({ activity: { attention } });
    await store.getState().start();
    await draftTask(store);
    await store.getState().startTask("t1");
    agent.exit("t1#1", 1, "401 Unauthorized");
    expect(attention).toHaveBeenLastCalledWith("p1", "t1", "needs login");
  });
});

describe("inbox grouping", () => {
  it("maps task states onto the workspace group vocabulary", () => {
    expect(taskGroup("draft")).toBe("settled");
    expect(taskGroup("running")).toBe("working");
    expect(taskGroup("needs-user")).toBe("needs-user");
    expect(taskGroup("done")).toBe("settled");
    expect(taskGroup("failed")).toBe("settled");
    expect(taskGroup("cancelled")).toBe("settled");
  });
});
