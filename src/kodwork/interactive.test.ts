import { describe, expect, it, vi } from "vitest";
import { MockAgentIpc, MockStorage } from "../ipc/mock";
import { createKodworkStore } from "./store";

const PERMISSION = JSON.stringify({
  type: "control_request",
  request_id: "permission-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "git status", cwd: "/repo" },
    tool_use_id: "tool-1",
    title: "Run git status?",
    permission_suggestions: [{ type: "addRules", rules: ["Bash(git status)"] }],
  },
});

async function setup(provider = "claude", timer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>) {
  const agent = new MockAgentIpc();
  const store = createKodworkStore({
    agent,
    storage: new MockStorage(),
    enabled: () => true,
    projectRoot: () => "/repo",
    ...(timer ? { setTimeout: timer, clearTimeout: vi.fn() } : {}),
  });
  await store.getState().start();
  await store.getState().openTask("task-1", "project-1");
  store.getState().setOutcome("task-1", "inspect the repo");
  store.getState().setProvider("task-1", provider);
  await store.getState().startTask("task-1");
  return { agent, store };
}

describe("KödWork stream input", () => {
  it("round-trips a permission request and supports mid-run steering", async () => {
    const { agent, store } = await setup();
    agent.emit("task-1#1", PERMISSION);
    expect(store.getState().tasks["task-1"]).toMatchObject({
      state: "needs-user",
      permissionRequest: { tool: "Bash", requestId: "permission-1" },
    });

    await store.getState().respondPermission("task-1", "always");
    const response = JSON.parse(agent.sends.at(-1)!.data);
    expect(response.response).toMatchObject({
      request_id: "permission-1",
      response: { behavior: "allow", updatedPermissions: expect.any(Array) },
    });
    expect(store.getState().tasks["task-1"].state).toBe("running");

    await store.getState().steerTask("task-1", "Focus on the release notes");
    expect(agent.sends.at(-1)?.data).toContain("Focus on the release notes");
  });

  it("denies an unanswered request after the bounded timeout", async () => {
    let permissionTimeout: (() => void) | null = null;
    const timer = ((fn: () => void, ms: number) => {
      if (ms === 60_000) permissionTimeout = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const { agent, store } = await setup("claude", timer);
    agent.emit("task-1#1", PERMISSION);
    expect(permissionTimeout).not.toBeNull();
    permissionTimeout!();
    await vi.waitFor(() => {
      const response = JSON.parse(agent.sends.at(-1)!.data);
      expect(response.response.response.behavior).toBe("deny");
    });
    expect(store.getState().tasks["task-1"].permissionRequest).toBeNull();
  });

  it("leaves providers without a stream-input capability on one-shot stdin", async () => {
    const { agent } = await setup("codex");
    expect(agent.starts[0].stdin).toBe("inspect the repo");
    expect(agent.sends).toEqual([]);
  });
});
