// KödChat thread store: turn lifecycle, transcript persistence, and the
// privacy boundary. Driven with the real adapters against the real IPC mocks —
// only the process is fake.

import { describe, expect, it, vi } from "vitest";
import { MockAgentIpc, MockStorage } from "../ipc/mock";
import { CLAUDE_TOOL_TURN, CODEX_TOOL_TURN } from "../agents/fixtures";
import type { ChatMessage } from "../inference/backend";
import { chatDocName, parsePersistedThread, titleFromMessage } from "./model";
import {
  createChatStore,
  parseProviderModelLines,
  providerModelKey,
  type ChatDeps,
} from "./store";
import type { OllamaChatRuntime } from "./ollama";

function setup(overrides: Partial<ChatDeps> = {}) {
  const agent = new MockAgentIpc();
  const storage = new MockStorage();
  let seq = 0;
  const store = createChatStore({
    agent,
    storage,
    projectRoot: () => "/repo",
    newId: () => `id-${++seq}`,
    now: () => 1_000,
    // Write on the next tick instead of on a timer, so tests stay synchronous.
    persistDebounceMs: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (handle) => clearTimeout(handle),
    ...overrides,
  });
  return { agent, storage, store };
}

async function openThread(store: ReturnType<typeof setup>["store"], provider = "claude") {
  await store.getState().openThread("t1", "p1", provider);
}

describe("a turn", () => {
  it("keeps a Claude run owned after its result, detaches after silence, and resumes on a later event", async () => {
    let detach: (() => void) | undefined;
    const { agent, store } = setup({
      setTimeout: (fn, ms) => {
        if (ms === 1) detach = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
      streamDetachMs: 1,
    });
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "keep working");

    agent.emit("t1#1", JSON.stringify({ type: "result", session_id: "s1" }));
    expect(store.getState().threads.t1.status).toBe("working");
    await store.getState().send("t1", "must not duplicate");
    expect(agent.starts).toHaveLength(1);

    detach?.();
    expect(store.getState().threads.t1.status).toBe("detached");

    agent.emit(
      "t1#1",
      JSON.stringify({
        type: "assistant",
        message: { id: "later", content: [{ type: "text", text: "Still working." }] },
      }),
    );
    expect(store.getState().threads.t1.status).toBe("working");
    expect(store.getState().threads.t1.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Still working." })]),
    );

    agent.exit("t1#1", 0);
    expect(store.getState().threads.t1.status).toBe("idle");
  });

  it("keeps ownership after any provider completion frame until native exit", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store, "codex");
    await store.getState().send("t1", "keep ownership");

    agent.emitLines("t1#1", CODEX_TOOL_TURN);
    expect(store.getState().threads.t1.status).toBe("working");
    await store.getState().send("t1", "must not duplicate");
    expect(agent.starts).toHaveLength(1);

    agent.exit("t1#1", 0);
    expect(store.getState().threads.t1.status).toBe("idle");
  });

  it("adopts a live native run when reopening its thread without starting another", async () => {
    const { agent, storage, store } = setup();
    agent.liveRunIds = ["t1#4"];
    storage.docs.set(
      chatDocName("t1"),
      JSON.stringify({
        version: 1,
        id: "t1",
        projectId: "p1",
        providerId: "claude",
        title: "Existing chat",
        resumeId: "s1",
        conversationId: 0,
        model: null,
        access: "standard",
        thinking: null,
        speed: "default",
        entries: [],
        updatedAt: 1,
      }),
    );
    await store.getState().start();
    await openThread(store);

    expect(store.getState().threads.t1.status).toBe("working");
    await store.getState().send("t1", "must not duplicate");
    expect(agent.starts).toHaveLength(0);

    agent.emit(
      "t1#4",
      JSON.stringify({
        type: "assistant",
        message: { id: "later", content: [{ type: "text", text: "Recovered." }] },
      }),
    );
    expect(store.getState().threads.t1.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Recovered." })]),
    );
    agent.exit("t1#4", 0);
    expect(store.getState().threads.t1.status).toBe("idle");
  });

  it("does not adopt a run that exits while its live-run snapshot is in flight", async () => {
    const { agent, storage, store } = setup();
    storage.docs.set(
      chatDocName("t1"),
      JSON.stringify({
        version: 1,
        id: "t1",
        projectId: "p1",
        providerId: "claude",
        title: "Existing chat",
        resumeId: "s1",
        conversationId: 0,
        model: null,
        access: "standard",
        thinking: null,
        speed: "default",
        entries: [],
        updatedAt: 1,
      }),
    );
    await store.getState().start();
    agent.liveRunIds = ["t1#4"];
    agent.deferListLive = true;
    const opened = store.getState().openThread("t1", "p1", "claude");
    await vi.waitFor(() => expect(agent.listLiveCalls).toBe(2));

    agent.exit("t1#4", 1, "native process failed");
    agent.resolveListLive();
    await opened;

    expect(store.getState().threads.t1.status).toBe("idle");
    await store.getState().send("t1", "a new turn is safe");
    expect(agent.starts).toHaveLength(1);
  });

  it("does not adopt a run that exits while startup reconciliation is in flight", async () => {
    const { agent, store } = setup();
    await openThread(store);
    agent.liveRunIds = ["t1#4"];
    agent.deferListLive = true;
    const started = store.getState().start();
    await vi.waitFor(() => expect(agent.listLiveCalls).toBe(2));

    agent.exit("t1#4", 1, "native process failed");
    agent.resolveListLive();
    await started;

    expect(store.getState().threads.t1.status).toBe("idle");
  });
  it("starts a headless run with the adapter's argv and the prompt on stdin", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "  read the file  ");

    expect(agent.starts).toHaveLength(1);
    expect(agent.starts[0]).toEqual({
      id: "t1#1",
      cwd: "/repo",
      bin: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Bash",
        "Read",
        "WebFetch",
        "WebSearch",
      ],
      // Trimmed, and never an argument — no quoting hazard, no length limit.
      stdin: "read the file",
    });
    expect(store.getState().threads.t1.status).toBe("working");
  });

  it("injects bounded mapped project memory for a local CLI without persisting it", async () => {
    const memory = "mapped-context-marker\n" + "🧠".repeat(20_000);
    const { agent, store } = setup({
      memoryContext: async (root) => `${root}\n${memory}`,
    });
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "inspect the project");

    const stdin = agent.starts[0]?.stdin ?? "";
    expect(stdin).toContain("mapped-context-marker");
    expect(stdin).toContain("## Current request\ninspect the project");
    expect(Array.from(stdin).length).toBeLessThanOrEqual(12_100);
    expect(store.getState().threads.t1.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          role: "user",
          text: "inspect the project",
        }),
      ]),
    );
    expect(JSON.stringify(store.getState().threads.t1.entries)).not.toContain(
      "mapped-context-marker",
    );
  });

  it("runs a remote project's agent through SSH in its pinned path", async () => {
    const { agent, store } = setup({
      projectRoot: () => null,
      remoteTarget: () => ({ host: "studio", path: "/srv/kodade" }),
    });
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "inspect the repo");

    expect(agent.starts[0]).toEqual({
      id: "t1#1",
      cwd: "",
      bin: "ssh",
      args: [
        "-o",
        "BatchMode=yes",
        "-T",
        "studio",
        "--",
        "cd '/srv/kodade' && exec 'claude' '-p' '--output-format' 'stream-json' '--verbose' '--include-partial-messages' '--permission-mode' 'acceptEdits' '--allowedTools' 'Bash' 'Read' 'WebFetch' 'WebSearch'",
      ],
      stdin: "inspect the repo",
    });
  });

  it("spawns with the thread's chosen model and access level", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    store.getState().setModel("t1", "claude-opus-5");
    store.getState().setAccess("t1", "full");
    await store.getState().send("t1", "go");

    const args = agent.starts[0].args;
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("claude-opus-5");
    expect(args).not.toContain("acceptEdits");
    // Switching provider forgets the model — another CLI can't run it.
    agent.exit("t1#1", 0);
    store.getState().setProvider("t1", "codex");
    expect(store.getState().threads.t1.model).toBeNull();
  });

  it("spawns with the thread's chosen thinking level", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    store.getState().setThinking("t1", "high");
    await store.getState().send("t1", "go");

    expect(agent.starts[0].args.join(" ")).toContain("--effort high");
    // Switching provider forgets the level too — another CLI has its own list.
    agent.exit("t1#1", 0);
    store.getState().setProvider("t1", "codex");
    expect(store.getState().threads.t1.thinking).toBeNull();
  });

  it("clears Codex fast mode when switching to an unsupported provider", async () => {
    const { store } = setup();
    await openThread(store, "codex");
    store.getState().setSpeed("t1", "fast");
    expect(store.getState().threads.t1.speed).toBe("fast");

    store.getState().setProvider("t1", "claude");
    expect(store.getState().threads.t1.speed).toBe("default");

    store.getState().setSpeed("t1", "fast");
    expect(store.getState().threads.t1.speed).toBe("default");
  });

  it("locks the Codex speed choice for the duration of a turn", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store, "codex");
    store.getState().setSpeed("t1", "fast");
    await store.getState().send("t1", "go");

    store.getState().setSpeed("t1", "default");
    expect(store.getState().threads.t1.speed).toBe("fast");
    expect(agent.starts[0].args).toContain("features.fast_mode=true");

    agent.exit("t1#1", 0);
    store.getState().setSpeed("t1", "default");
    expect(store.getState().threads.t1.speed).toBe("default");
  });

  it("renders the claude stream into user, thinking, tool and assistant entries", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "read note.txt");

    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);

    const entries = store.getState().threads.t1.entries;
    expect(entries[0]).toMatchObject({ kind: "message", role: "user", text: "read note.txt" });
    expect(entries.filter((e) => e.kind === "thinking")).toHaveLength(2);
    const tool = entries.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      call: { tool: "Read", args: { file_path: "/private/tmp/kodchat-probe/note.txt" } },
      outcome: { status: "executed", result: "1\thello world\n2\t" },
    });
    const answer = entries.filter((e) => e.kind === "message" && e.role === "assistant");
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({
      text: "The file contains:\n```\nhello world\n```",
    });
    // Settled: no entry is still marked streaming.
    expect(entries.some((e) => e.kind === "message" && e.streaming)).toBe(false);
    expect(store.getState().threads.t1.status).toBe("idle");
  });

  it("captures the CLI's session id so the next turn resumes it", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store, "codex");
    await store.getState().send("t1", "first");
    agent.emitLines("t1#1", CODEX_TOOL_TURN);
    agent.exit("t1#1", 0);

    expect(store.getState().threads.t1.resumeId).toBe(
      "019f9d04-d92c-7541-a30f-d41f475ffebf",
    );

    await store.getState().send("t1", "second");
    expect(agent.starts[1]).toMatchObject({
      id: "t1#2",
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "resume",
        "019f9d04-d92c-7541-a30f-d41f475ffebf",
        "-",
      ],
    });
  });

  it("names the thread from the first user message only", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "Explain the terminal registry\nand its hosts");
    expect(store.getState().threads.t1.title).toBe("Explain terminal registry");
    agent.exit("t1#1", 0);
    await store.getState().send("t1", "now describe something else");
    expect(store.getState().threads.t1.title).toBe("Explain terminal registry");
  });

  it("ignores an empty message and refuses a second concurrent turn", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "   ");
    expect(agent.starts).toHaveLength(0);

    await store.getState().send("t1", "one");
    await store.getState().send("t1", "two");
    expect(agent.starts).toHaveLength(1);
  });

  it("drops events from a superseded run", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "one");
    agent.exit("t1#1", 0);
    await store.getState().send("t1", "two");

    // A late line from the finished first run must not land in turn two.
    agent.emit(
      "t1#1",
      JSON.stringify({
        type: "assistant",
        message: { id: "m", role: "assistant", content: [{ type: "text", text: "stale" }] },
      }),
    );
    expect(
      store.getState().threads.t1.entries.some((e) => e.kind === "message" && e.text === "stale"),
    ).toBe(false);
  });
});

describe("dynamic OpenCode models", () => {
  it("bounds, sanitizes, and deduplicates plugin-influenced model output", () => {
    const noisy = [
      "openrouter/anthropic/claude-sonnet",
      "openrouter/anthropic/claude-sonnet",
      "\u001b[32mopenrouter/~anthropic/claude-fable-latest\u001b[0m",
      "plugin loaded successfully",
      "bad id/model with spaces",
      `provider/${"x".repeat(300)}`,
      ...Array.from({ length: 700 }, (_, index) => `provider/model-${index}`),
    ];

    const models = parseProviderModelLines(noisy);
    expect(models.slice(0, 2)).toEqual([
      {
        id: "openrouter/anthropic/claude-sonnet",
        label: "openrouter/anthropic/claude-sonnet",
      },
      {
        id: "openrouter/~anthropic/claude-fable-latest",
        label: "openrouter/~anthropic/claude-fable-latest",
      },
    ]);
    expect(models).toHaveLength(512);
    expect(models.some((model) => model.id.includes(" "))).toBe(false);
  });

  it("discovers from the project root and forwards only the exact selected option", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store, "opencode");

    expect(agent.starts[0]).toEqual({
      id: "provider-models:opencode#1",
      cwd: "/repo",
      bin: "opencode",
      args: ["models"],
      stdin: "",
    });
    agent.emit("provider-models:opencode#1", "openrouter/~anthropic/claude-fable-latest");
    agent.emit("provider-models:opencode#1", "plugin diagnostic noise");
    agent.exit("provider-models:opencode#1", 0);
    await vi.waitFor(() =>
      expect(store.getState().providerModels[providerModelKey("opencode", "p1")]).toMatchObject({
        status: "ready",
        models: [
          {
            id: "openrouter/~anthropic/claude-fable-latest",
            label: "openrouter/~anthropic/claude-fable-latest",
          },
        ],
      }),
    );

    store
      .getState()
      .setModel("t1", "openrouter/~anthropic/claude-fable-latest");
    await store.getState().send("t1", "hello");
    expect(agent.starts[1]?.args).toContain("openrouter/~anthropic/claude-fable-latest");
  });

  it("keeps Default usable when discovery fails", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store, "opencode");
    agent.exit("provider-models:opencode#1", 1, "plugin failed");
    await vi.waitFor(() =>
      expect(
        store.getState().providerModels[providerModelKey("opencode", "p1")]?.status,
      ).toBe("unavailable"),
    );

    await store.getState().send("t1", "use the configured default");
    expect(agent.starts[1]?.args).not.toContain("--model");
  });

  it("times out, cancels, and resolves a hung model command", async () => {
    let fireTimeout: (() => void) | null = null;
    const clearDiscoveryTimeout = vi.fn();
    const { agent, store } = setup({
      modelDiscoveryTimeoutMs: 25,
      modelDiscoverySetTimeout: (fn) => {
        fireTimeout = fn;
        return 99 as unknown as ReturnType<typeof setTimeout>;
      },
      modelDiscoveryClearTimeout: clearDiscoveryTimeout,
    });
    await store.getState().start();
    await openThread(store, "opencode");
    const refresh = store.getState().refreshProviderModels("opencode", "p1");

    expect(fireTimeout).not.toBeNull();
    fireTimeout!();
    await refresh;

    expect(agent.cancels).toEqual([{ id: "provider-models:opencode#1" }]);
    expect(
      store.getState().providerModels[providerModelKey("opencode", "p1")],
    ).toMatchObject({
      status: "unavailable",
      models: [],
      message: expect.stringContaining("Default"),
    });
    expect(clearDiscoveryTimeout).not.toHaveBeenCalled();
  });

  it("isolates simultaneous project catalogs and never discovers locally for a remote thread", async () => {
    const { agent, store } = setup({
      projectRoot: (projectId) => `/repos/${projectId}`,
      remoteTarget: (projectId) =>
        projectId === "remote" ? { host: "studio", path: "/srv/project" } : null,
    });
    await store.getState().start();
    await store.getState().openThread("t1", "alpha", "opencode");
    await store.getState().openThread("t2", "beta", "opencode");
    await store.getState().openThread("t3", "remote", "opencode");

    expect(agent.starts.map(({ id, cwd }) => ({ id, cwd }))).toEqual([
      { id: "provider-models:opencode#1", cwd: "/repos/alpha" },
      { id: "provider-models:opencode#2", cwd: "/repos/beta" },
    ]);
    agent.emit("provider-models:opencode#2", "beta/model");
    agent.exit("provider-models:opencode#2", 0);
    agent.emit("provider-models:opencode#1", "alpha/model");
    agent.exit("provider-models:opencode#1", 0);

    expect(
      store.getState().providerModels[providerModelKey("opencode", "alpha")]?.models,
    ).toEqual([{ id: "alpha/model", label: "alpha/model" }]);
    expect(
      store.getState().providerModels[providerModelKey("opencode", "beta")]?.models,
    ).toEqual([{ id: "beta/model", label: "beta/model" }]);
    expect(
      store.getState().providerModels[providerModelKey("opencode", "remote")],
    ).toBeUndefined();
  });

  it("cannot switch provider or model while an OpenCode turn is active", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store, "opencode");
    agent.emit("provider-models:opencode#1", "openrouter/model-a");
    agent.exit("provider-models:opencode#1", 0);
    store.getState().setModel("t1", "openrouter/model-a");
    await store.getState().send("t1", "go");

    store.getState().setProvider("t1", "ollama");
    store.getState().setModel("t1", "other/model");
    expect(store.getState().threads.t1).toMatchObject({
      providerId: "opencode",
      model: "openrouter/model-a",
      status: "working",
    });

    agent.emit(
      "t1#1",
      JSON.stringify({
        type: "text",
        sessionID: "ses-active",
        part: { id: "part-1", text: "done" },
      }),
    );
    agent.exit("t1#1", 0);
    expect(store.getState().threads.t1).toMatchObject({
      providerId: "opencode",
      model: "openrouter/model-a",
      resumeId: "ses-active",
      status: "idle",
    });
  });
});

describe("failures", () => {
  it("shows an auth card and flags the thread for login", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "hi");
    agent.exit("t1#1", 1, "Not logged in. Run `claude login` to continue.");

    const error = store.getState().threads.t1.entries.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error", auth: true });
    expect(store.getState().threads.t1.needsLogin).toBe(true);
    expect(store.getState().threads.t1.status).toBe("idle");
  });

  it("reports an ordinary crash without offering a login", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "hi");
    agent.exit("t1#1", 1, "segmentation fault");

    expect(store.getState().threads.t1.entries.at(-1)).toMatchObject({
      kind: "error",
      message: "segmentation fault",
    });
    expect(store.getState().threads.t1.needsLogin).toBe(false);
    expect(store.getState().threads.t1.status).toBe("error");
  });

  it("surfaces a spawn rejection in the transcript and frees the composer", async () => {
    const { agent, store } = setup();
    agent.failStartWith = new Error("claude is not installed or not on PATH");
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "hi");

    expect(store.getState().threads.t1.entries.at(-1)).toMatchObject({
      kind: "error",
      message: "claude is not installed or not on PATH",
    });
    expect(store.getState().threads.t1.status).toBe("error");
    // A failed start must not leave the thread wedged.
    await store.getState().send("t1", "retry");
    expect(agent.starts).toHaveLength(2);
  });

  it("streams Ollama over local HTTP with persisted client-side history and no agent process", async () => {
    const calls: Array<{ model: string; messages: Array<{ role: string; content: string }>; signal: AbortSignal }> = [];
    const ollama: OllamaChatRuntime = {
      async listModels() {
        return [{ id: "qwen3:8b", label: "qwen3:8b" }];
      },
      async *chat(input) {
        calls.push(input);
        yield { reasoning: "checking" };
        yield { content: "local answer" };
      },
    };
    const { agent, store } = setup({ ollama });
    await store.getState().start();
    await openThread(store, "ollama");
    await store.getState().send("t1", "hi");

    await vi.waitFor(() => expect(store.getState().threads.t1.status).toBe("idle"));
    expect(agent.starts).toHaveLength(0);
    expect(calls).toEqual([
      {
        model: "qwen3:8b",
        messages: [{ role: "user", content: "hi" }],
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(store.getState().threads.t1.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "thinking", text: "checking" }),
        expect.objectContaining({ kind: "message", role: "assistant", text: "local answer" }),
      ]),
    );
    await store.getState().send("t1", "again");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "local answer" },
      { role: "user", content: "again" },
    ]);
  });

  it("injects mapped project memory as bounded Ollama system context", async () => {
    const calls: Array<{ messages: ChatMessage[] }> = [];
    const ollama: OllamaChatRuntime = {
      async listModels() {
        return [{ id: "qwen3:8b", label: "qwen3:8b" }];
      },
      async *chat(input) {
        calls.push({ messages: input.messages });
        yield { content: "done" };
      },
    };
    const { store } = setup({
      ollama,
      memoryContext: async () => "mapped-ollama-memory",
    });
    await store.getState().start();
    await openThread(store, "ollama");
    await store.getState().send("t1", "use the project state");

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.messages).toEqual([
      { role: "system", content: "mapped-ollama-memory" },
      { role: "user", content: "use the project state" },
    ]);
  });

  it("shows the actionable local-service state when Ollama is unavailable", async () => {
    const ollama: OllamaChatRuntime = {
      async listModels() {
        throw new Error("Ollama is not running on this Mac. Install Ollama, start it, then pull a model.");
      },
      async *chat() {},
    };
    const { agent, store } = setup({ ollama });
    await openThread(store, "ollama");
    await store.getState().send("t1", "hi");
    expect(agent.starts).toHaveLength(0);
    expect(store.getState().threads.t1.entries.at(-1)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Ollama is not running"),
    });
  });

  it("recovers from unavailable discovery and a failed generation on retry", async () => {
    let available = false;
    let attempts = 0;
    const ollama: OllamaChatRuntime = {
      async listModels() {
        if (!available) throw new Error("Ollama is not running. Start it, then retry.");
        return [{ id: "qwen3:8b", label: "qwen3:8b" }];
      },
      async *chat() {
        attempts += 1;
        if (attempts === 1) throw new Error("malformed response from Ollama");
        yield { content: "retry worked" };
      },
    };
    const { store } = setup({ ollama });
    await openThread(store, "ollama");
    await vi.waitFor(() => expect(store.getState().ollama.status).toBe("unavailable"));

    available = true;
    await store.getState().refreshOllama();
    await store.getState().send("t1", "first attempt");
    await vi.waitFor(() => expect(store.getState().threads.t1.status).toBe("error"));
    expect(store.getState().threads.t1.entries.at(-1)).toMatchObject({
      kind: "error",
      message: "malformed response from Ollama",
    });

    await store.getState().send("t1", "retry");
    await vi.waitFor(() => expect(store.getState().threads.t1.status).toBe("idle"));
    expect(store.getState().threads.t1.entries.at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "retry worked",
    });
  });

  it("starts fresh history on model switch, then replays only the active conversation after reopen", async () => {
    const calls: Array<{
      model: string;
      messages: Array<{ role: string; content: string }>;
    }> = [];
    let availableModels = [
      { id: "qwen3:8b", label: "qwen3:8b" },
      { id: "llama3:8b", label: "llama3:8b" },
    ];
    const ollama: OllamaChatRuntime = {
      async listModels() {
        return availableModels;
      },
      async *chat(input) {
        calls.push({ model: input.model, messages: input.messages });
        yield { content: `${input.model} answer` };
      },
    };
    const { storage, store } = setup({ ollama });
    await openThread(store, "ollama");
    await vi.waitFor(() => expect(store.getState().ollama.status).toBe("ready"));
    store.getState().setModel("t1", "qwen3:8b");
    await store.getState().send("t1", "old model prompt");
    await vi.waitFor(() => expect(store.getState().threads.t1.status).toBe("idle"));

    store.getState().setModel("t1", "llama3:8b");
    await store.getState().send("t1", "active model prompt");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({
      model: "llama3:8b",
      messages: [{ role: "user", content: "active model prompt" }],
    });
    // The old conversation remains readable even though it was not replayed.
    expect(
      store.getState().threads.t1.entries.some(
        (entry) => entry.kind === "message" && entry.text === "old model prompt",
      ),
    ).toBe(true);
    await store.getState().flush("t1");

    calls.length = 0;
    const reopened = createChatStore({
      agent: new MockAgentIpc(),
      storage,
      projectRoot: () => "/repo",
      ollama,
      newId: (() => {
        let sequence = 0;
        return () => `reopen-${++sequence}`;
      })(),
    });
    await reopened.getState().openThread("t1", "p1", "ollama");
    await reopened.getState().refreshOllama();
    await reopened.getState().send("t1", "continue active conversation");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      model: "llama3:8b",
      messages: [
        { role: "user", content: "active model prompt" },
        { role: "assistant", content: "llama3:8b answer" },
        { role: "user", content: "continue active conversation" },
      ],
    });

    // If the persisted selection disappears, normalize to Default and create
    // another history boundary before submitting to the remaining model.
    availableModels = [{ id: "qwen3:8b", label: "qwen3:8b" }];
    await vi.waitFor(() => expect(reopened.getState().threads.t1.status).toBe("idle"));
    await reopened.getState().refreshOllama();
    expect(reopened.getState().threads.t1.model).toBeNull();
    calls.length = 0;
    await reopened.getState().send("t1", "after model removal");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      model: "qwen3:8b",
      messages: [{ role: "user", content: "after model removal" }],
    });
  });

  it("keeps the newest Ollama refresh when older requests settle out of order", async () => {
    const pending: Array<{
      resolve(models: Array<{ id: string; label: string }>): void;
      reject(error: Error): void;
    }> = [];
    const ollama: OllamaChatRuntime = {
      listModels() {
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
      async *chat() {},
    };
    const { store } = setup({ ollama });
    const older = store.getState().refreshOllama();
    const newer = store.getState().refreshOllama();
    pending[1]!.resolve([{ id: "new/model", label: "new/model" }]);
    await newer;
    pending[0]!.reject(new Error("stale failure"));
    await older;

    expect(store.getState().ollama).toEqual({
      status: "ready",
      models: [{ id: "new/model", label: "new/model" }],
      message: null,
    });
  });

  it("falls back to an available model with fresh history after a mid-turn refresh", async () => {
    let models = [
      { id: "qwen3:8b", label: "qwen3:8b" },
      { id: "llama3:8b", label: "llama3:8b" },
    ];
    let releaseFirst: (() => void) | null = null;
    const calls: Array<{
      model: string;
      messages: Array<{ role: string; content: string }>;
    }> = [];
    const ollama: OllamaChatRuntime = {
      async listModels() {
        return models;
      },
      async *chat(input) {
        calls.push({ model: input.model, messages: input.messages });
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        yield { content: `${input.model} answer` };
      },
    };
    const { store } = setup({ ollama });
    await openThread(store, "ollama");
    await vi.waitFor(() => expect(store.getState().ollama.status).toBe("ready"));
    store.getState().setModel("t1", "qwen3:8b");
    await store.getState().send("t1", "first");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    models = [{ id: "llama3:8b", label: "llama3:8b" }];
    await store.getState().refreshOllama();
    expect(store.getState().threads.t1.model).toBe("qwen3:8b");
    releaseFirst!();
    await vi.waitFor(() => expect(store.getState().threads.t1.status).toBe("idle"));

    await store.getState().send("t1", "after refresh");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({
      model: "llama3:8b",
      messages: [{ role: "user", content: "after refresh" }],
    });
  });

  it("cancel kills the run and the exit still settles the thread", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "hi");
    await store.getState().cancel("t1");

    expect(agent.cancels).toEqual([{ id: "t1#1" }]);
    agent.exit("t1#1", 143, "");
    expect(store.getState().threads.t1.status).not.toBe("working");
  });

  it("aborts an Ollama stream directly without trying to cancel a child process", async () => {
    let aborted = false;
    const ollama: OllamaChatRuntime = {
      async listModels() {
        return [{ id: "qwen3:8b", label: "qwen3:8b" }];
      },
      async *chat(input) {
        await new Promise<void>((resolve) => {
          input.signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
      },
    };
    const { agent, store } = setup({ ollama });
    await openThread(store, "ollama");
    await store.getState().send("t1", "hi");
    store.getState().setProvider("t1", "codex");
    store.getState().setModel("t1", "foreign-model");
    expect(store.getState().threads.t1).toMatchObject({
      providerId: "ollama",
      model: "qwen3:8b",
      status: "working",
    });
    await store.getState().cancel("t1");
    expect(aborted).toBe(true);
    expect(agent.cancels).toHaveLength(0);
    expect(store.getState().threads.t1.status).toBe("idle");
  });
});

describe("transcript persistence", () => {
  it("round-trips a finished thread through its own document", async () => {
    const { agent, storage, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "read note.txt");
    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);
    await store.getState().flush("t1");

    // Transcripts live OUTSIDE the main document.
    expect(storage.doc).toBeNull();
    const raw = storage.docs.get(chatDocName("t1"));
    expect(raw).toBeTruthy();
    const doc = parsePersistedThread(raw!)!;
    expect(doc.id).toBe("t1");
    expect(doc.resumeId).toBe("11111111-2222-3333-4444-555555555555");
    expect(doc.entries.some((e) => e.kind === "message" && e.streaming)).toBe(false);

    // A fresh store reading the same disk sees the same transcript.
    const reopened = createChatStore({
      agent: new MockAgentIpc(),
      storage,
      projectRoot: () => "/repo",
      newId: () => "x",
      now: () => 2_000,
    });
    await reopened.getState().openThread("t1", "p1", "claude");
    expect(reopened.getState().threads.t1.entries).toEqual(doc.entries);
    expect(reopened.getState().threads.t1.title).toBe("read note.txt");
    expect(reopened.getState().threads.t1.resumeId).toBe(doc.resumeId);
  });

  it("round-trips the thread's thinking level through its document", async () => {
    const { storage, store } = setup();
    await openThread(store);
    store.getState().setThinking("t1", "xhigh");
    await store.getState().flush("t1");

    const doc = parsePersistedThread(storage.docs.get(chatDocName("t1"))!)!;
    expect(doc.thinking).toBe("xhigh");

    const reopened = createChatStore({
      agent: new MockAgentIpc(),
      storage,
      projectRoot: () => "/repo",
    });
    await reopened.getState().openThread("t1", "p1", "claude");
    expect(reopened.getState().threads.t1.thinking).toBe("xhigh");

    // A document from before thinking levels existed parses to the default.
    expect(
      parsePersistedThread(
        JSON.stringify({ version: 1, id: "t9", projectId: "p1", entries: [] }),
      )!.thinking,
    ).toBeNull();
  });

  it("round-trips Codex fast mode and defaults older documents", async () => {
    const { storage, store } = setup();
    await openThread(store, "codex");
    store.getState().setSpeed("t1", "fast");
    await store.getState().flush("t1");

    const doc = parsePersistedThread(storage.docs.get(chatDocName("t1"))!)!;
    expect(doc.speed).toBe("fast");

    const reopened = createChatStore({
      agent: new MockAgentIpc(),
      storage,
      projectRoot: () => "/repo",
    });
    await reopened.getState().openThread("t1", "p1", "codex");
    expect(reopened.getState().threads.t1.speed).toBe("fast");

    expect(
      parsePersistedThread(
        JSON.stringify({ version: 1, id: "t9", projectId: "p1", entries: [] }),
      )!.speed,
    ).toBe("default");
  });

  it("survives a corrupt or foreign-version document", async () => {
    const { storage, store } = setup();
    await storage.writeDoc(chatDocName("t1"), "{ not json");
    await store.getState().openThread("t1", "p1", "claude");
    expect(store.getState().threads.t1.entries).toEqual([]);

    await storage.writeDoc(chatDocName("t2"), JSON.stringify({ version: 99, id: "t2" }));
    await store.getState().openThread("t2", "p1", "claude");
    expect(store.getState().threads.t2.entries).toEqual([]);
  });

  it("removing a thread deletes its document and cancels a live run", async () => {
    const { agent, storage, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "hi");
    await store.getState().flush("t1");
    expect(storage.docs.has(chatDocName("t1"))).toBe(true);

    await store.getState().removeThread("t1");
    expect(agent.cancels).toEqual([{ id: "t1#1" }]);
    expect(storage.docs.has(chatDocName("t1"))).toBe(false);
    expect(store.getState().threads.t1).toBeUndefined();
  });

  it("opening a loaded thread twice does not re-read the disk", async () => {
    const { storage, store } = setup();
    const readDoc = vi.spyOn(storage, "readDoc");
    await store.getState().openThread("t1", "p1", "claude");
    await store.getState().openThread("t1", "p1", "claude");
    expect(readDoc).toHaveBeenCalledTimes(1);
  });
});

describe("the activity boundary receives metadata only", () => {
  it("never passes transcript text to the activity hooks", async () => {
    const streamed = vi.fn();
    const attention = vi.fn();
    const { agent, store } = setup({ activity: { streamed, attention } });
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "a secret prompt nobody should log");
    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);

    expect(streamed).toHaveBeenCalledWith("p1", "t1");
    // Every argument, across every call, is an id or a fixed short reason.
    const args = [...streamed.mock.calls, ...attention.mock.calls].flat();
    for (const value of args) {
      expect(["p1", "t1", null, "needs login", "the agent failed"]).toContain(value);
    }
    // The settled turn clears attention rather than reporting its content.
    expect(attention).toHaveBeenLastCalledWith("p1", "t1", null);
  });

  it("reports needs-login attention when authentication fails", async () => {
    const attention = vi.fn();
    const { agent, store } = setup({ activity: { attention } });
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "hi");
    agent.exit("t1#1", 1, "401 Unauthorized");
    expect(attention).toHaveBeenLastCalledWith("p1", "t1", "needs login");
  });
});

describe("switching provider", () => {
  it("drops the resume id, because another CLI cannot continue that session", async () => {
    const { agent, store } = setup();
    await store.getState().start();
    await openThread(store);
    await store.getState().send("t1", "hi");
    agent.emitLines("t1#1", CLAUDE_TOOL_TURN);
    agent.exit("t1#1", 0);
    expect(store.getState().threads.t1.resumeId).toBeTruthy();

    store.getState().setProvider("t1", "codex");
    expect(store.getState().threads.t1.resumeId).toBeNull();
    await store.getState().send("t1", "again");
    expect(agent.starts[1].bin).toBe("codex");
    expect(agent.starts[1].args).not.toContain("resume");
  });
});

describe("thread titles", () => {
  it("distills the first line into a short 2-3 word topic", () => {
    expect(
      titleFromMessage("Please can you help me fix the login form validation?"),
    ).toBe("login form validation");
    expect(titleFromMessage("How do I add dark mode to the settings pane?")).toBe(
      "add dark mode",
    );
    // Original casing is preserved; only filler ("the") is dropped.
    expect(titleFromMessage("Explain the terminal registry")).toBe(
      "Explain terminal registry",
    );
    expect(titleFromMessage("read note.txt")).toBe("read note.txt");
  });

  it("strips markdown decoration and edge punctuation", () => {
    expect(titleFromMessage("## Fix the `parser` bug!")).toBe("parser bug");
    expect(titleFromMessage("   hello    world  ")).toBe("world");
  });

  it("falls back to New chat when nothing meaningful remains", () => {
    expect(titleFromMessage("")).toBe("New chat");
    expect(titleFromMessage("\n\n")).toBe("New chat");
    expect(titleFromMessage("hi there, can you please help me?")).toBe("New chat");
  });

  it("caps a runaway single word defensively", () => {
    expect(titleFromMessage("x".repeat(100))).toHaveLength(58); // 57 + ellipsis
  });
});
