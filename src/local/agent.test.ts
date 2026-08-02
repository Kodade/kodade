import { describe, expect, it, vi } from "vitest";
import type {
  BackendCapabilities,
  ChatDelta,
  ChatRequest,
  ChatRequestOptions,
  ChatResponse,
  InferenceBackend,
  InferenceModel,
} from "./backend";
import { LocalAgentLoop, MAX_RETAINED_TURNS } from "./agent";
import { LOCAL_AGENT_TOOLS } from "./tools";

class ScriptedBackend implements InferenceBackend {
  requests: ChatRequest[] = [];
  summaryRequests: ChatRequest[] = [];

  constructor(
    private readonly replies: string[],
    private readonly summaries: string[] = [],
  ) {}

  async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
    this.requests.push(request);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("no scripted reply");
    yield { content: reply.slice(0, Math.ceil(reply.length / 2)) };
    yield {
      content: reply.slice(Math.ceil(reply.length / 2)),
      tokensPerSecond: 7.5,
    };
  }

  async chatOnce(request: ChatRequest): Promise<ChatResponse> {
    this.summaryRequests.push(request);
    const content = this.summaries.shift();
    if (content === undefined)
      throw new Error("no scripted checkpoint summary");
    return {
      id: "checkpoint-summary",
      role: "assistant",
      content,
      finishReason: "stop",
    };
  }

  async listModels(): Promise<InferenceModel[]> {
    return [];
  }

  async capabilities(): Promise<BackendCapabilities> {
    return {
      supports: {
        tools: false,
        grammar: true,
        constrained: true,
        embeddings: false,
      },
    };
  }
}

class StalledSummaryBackend extends ScriptedBackend {
  summaryAborted = false;

  override async chatOnce(
    request: ChatRequest,
    options?: ChatRequestOptions,
  ): Promise<ChatResponse> {
    this.summaryRequests.push(request);
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          this.summaryAborted = true;
          const error = new Error("summary aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
  }
}

function call(tool: string, args: Record<string, unknown>): string {
  return JSON.stringify({ tool, args });
}

function loop(
  backend: ScriptedBackend,
  overrides: Partial<ConstructorParameters<typeof LocalAgentLoop>[0]> = {},
) {
  const activity: string[] = [];
  const deltas: string[] = [];
  const hostCall = vi
    .fn()
    .mockResolvedValue({ kind: "text", content: "grounded bytes" });
  const instance = new LocalAgentLoop({
    backend,
    model: "qwen-4b",
    modelContextTokens: 8192,
    harnessPrompt: "PROJECT HARNESS",
    projectRoot: "/repo",
    constrained: true,
    host: { call: hostCall },
    policy: {
      entitled: true,
      enabled: true,
      confirmEveryCall: false,
      autoApproveWrite: false,
    },
    confirm: vi.fn().mockResolvedValue(true),
    onActivity: (line) => activity.push(line),
    onAnswerDelta: (text) => deltas.push(text),
    ...overrides,
  });
  return { instance, activity, deltas, hostCall };
}

describe("KödLocal agent loop", () => {
  it("executes only a strict validated call, feeds the result back, then terminates through answer", async () => {
    const backend = new ScriptedBackend([
      call("read_file", { path: "AGENTS.md" }),
      call("answer", { text: "The harness says grounded bytes." }),
    ]);
    const { instance, hostCall, activity, deltas } = loop(backend);

    const result = await instance.runUserTurn("What does AGENTS.md say?");

    expect(hostCall).toHaveBeenCalledWith("fs_read_file", {
      path: "/repo/AGENTS.md",
    });
    expect(backend.requests[0].kodGrammar).toContain("root ::=");
    expect(backend.requests[0].messages[0].content).toContain(
      "PROJECT HARNESS",
    );
    expect(backend.requests[1].messages.at(-1)?.content).toContain(
      "grounded bytes",
    );
    expect(result).toMatchObject({
      answer: "The harness says grounded bytes.",
      toolTurns: 1,
      surrendered: false,
    });
    expect(activity.some((line) => line.includes("read_file"))).toBe(true);
    expect(deltas.join("")).toBe("The harness says grounded bytes.");
  });

  it("uses bounded repair then surrenders to streamed chat without dispatching invalid text", async () => {
    const backend = new ScriptedBackend([
      "not json",
      "still bad",
      "also bad",
      "I could not use tools safely.",
    ]);
    const { instance, hostCall, activity, deltas } = loop(backend);

    const result = await instance.runUserTurn("inspect the project");

    expect(hostCall).not.toHaveBeenCalled();
    expect(result.surrendered).toBe(true);
    expect(activity.join("\n")).toContain("surrendered to chat-only");
    expect(deltas.join("")).toBe("I could not use tools safely.");
    expect(backend.requests).toHaveLength(4);
    expect(backend.requests.at(-1)?.kodGrammar).toBeUndefined();
  });

  it("feeds tool errors back but stops after six tool turns", async () => {
    const toolCalls = Array.from({ length: 6 }, () =>
      call("read_file", { path: "missing.txt" }),
    );
    const backend = new ScriptedBackend([
      ...toolCalls,
      "Stopped after repeated errors.",
    ]);
    const { instance, hostCall, activity } = loop(backend);
    hostCall.mockRejectedValue(new Error("document is unavailable"));

    const result = await instance.runUserTurn("keep trying");

    expect(hostCall).toHaveBeenCalledTimes(6);
    expect(result).toMatchObject({ toolTurns: 6, surrendered: true });
    expect(backend.requests[1].messages.at(-1)?.content).toContain(
      "document is unavailable",
    );
    expect(activity.join("\n")).toContain("maximum 6 tool turns reached");
  });

  it("lets a delegate lower but never raise the hard tool-turn budget", async () => {
    const backend = new ScriptedBackend([
      call("read_file", { path: "one.txt" }),
      call("read_file", { path: "two.txt" }),
      "Partial result after the delegated budget.",
    ]);
    const { instance, hostCall } = loop(backend, { maxToolTurns: 2 });

    const result = await instance.runUserTurn("read until the bounded handoff");

    expect(hostCall).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      toolTurns: 2,
      surrendered: true,
      stopReason: "tool-budget",
    });
  });

  it("compiles and validates only the tools a delegate explicitly allows", async () => {
    const backend = new ScriptedBackend([
      call("answer", { text: "No write capability was exposed." }),
    ]);
    const tools = LOCAL_AGENT_TOOLS.filter(
      (tool) => tool.name === "read_file" || tool.name === "answer",
    );
    const { instance } = loop(backend, { tools });

    await instance.runUserTurn("inspect without writes");

    expect(backend.requests[0].kodGrammar).toContain("read_file");
    expect(backend.requests[0].kodGrammar).not.toContain("write_file");
    expect(backend.requests[0].messages[0].content).not.toContain(
      "write_file({path, content})",
    );
  });

  it("keeps agent+harness chat but displays tools without executing when local.tools is absent", async () => {
    const backend = new ScriptedBackend([
      call("list_dir", { path: "." }),
      call("answer", { text: "I only suggested listing the directory." }),
    ]);
    const { instance, hostCall } = loop(backend, {
      policy: {
        entitled: false,
        enabled: false,
        confirmEveryCall: false,
        autoApproveWrite: false,
      },
    });

    const result = await instance.runUserTurn("what is here?");

    expect(hostCall).not.toHaveBeenCalled();
    expect(backend.requests[1].messages.at(-1)?.content).toContain(
      "suggest-only",
    );
    expect(result.surrendered).toBe(false);
  });

  it("pins the first goal separately and bounds retained recent turns", async () => {
    const totalTurns = MAX_RETAINED_TURNS + 16;
    const backend = new ScriptedBackend(
      Array.from({ length: totalTurns }, (_, index) =>
        call("answer", { text: `done-${index}` }),
      ),
    );
    const { instance } = loop(backend, { modelContextTokens: 100_000 });

    for (let index = 0; index < totalTurns; index += 1) {
      await instance.runUserTurn(`goal-${index}`);
    }

    const messages = backend.requests.at(-1)?.messages ?? [];
    expect(messages.length).toBeLessThanOrEqual(3 + MAX_RETAINED_TURNS * 2);
    expect(messages.some((message) => message.content === "goal-0")).toBe(true);
    expect(
      messages.some((message) => message.content === `goal-${totalTurns - 1}`),
    ).toBe(true);
    expect(messages.some((message) => message.content === "goal-1")).toBe(
      false,
    );
    expect(
      messages.some(
        (message) =>
          message.content === `goal-${totalTurns - MAX_RETAINED_TURNS - 2}`,
      ),
    ).toBe(false);
  });

  it("offloads a tool-bearing turn atomically with a retry-stable content key", async () => {
    async function attempt() {
      const backend = new ScriptedBackend(
        [
          call("read_file", { path: "AGENTS.md" }),
          call("answer", { text: "x".repeat(900) }),
          call("answer", { text: "second task complete" }),
        ],
        [
          JSON.stringify({
            summary:
              "Completed the first task and preserved its outcome for the next turn.",
            nextActions: ["Continue with the second task."],
          }),
        ],
      );
      const checkpoint = vi.fn().mockResolvedValue({ id: "memory-checkpoint" });
      const { instance } = loop(backend, {
        modelContextTokens: 700,
        maxTokens: 128,
        marginTokens: 32,
        memory: {
          client: { checkpoint },
          workspaceRoot: "/repo",
          sessionId: "agent-session-1",
        },
      });

      await instance.runUserTurn("first task");
      await instance.runUserTurn("y".repeat(900));
      return { backend, checkpoint };
    }

    const first = await attempt();
    const retry = await attempt();
    const transcript = first.backend.summaryRequests[0].messages[1].content;
    expect(transcript).toContain("selected tool read_file");
    expect(transcript).toContain("raw tool result withheld");
    expect(transcript).toContain("selected tool answer");
    expect(first.checkpoint).toHaveBeenCalledWith({
      workspaceRoot: "/repo",
      summary:
        "Completed the first task and preserved its outcome for the next turn.",
      nextActions: ["Continue with the second task."],
      sessionId: "agent-session-1",
      idempotencyKey: expect.stringMatching(
        /^agent-session-1:offload:[0-9a-f]{16}$/,
      ),
    });
    expect(first.checkpoint.mock.calls[0][0].idempotencyKey).toBe(
      retry.checkpoint.mock.calls[0][0].idempotencyKey,
    );
    expect(
      first.backend.requests
        .at(-1)
        ?.messages.some(
          (message) => message.content === "[earlier turns elided]",
        ),
    ).toBe(true);
  });

  it("replaces a secret-bearing assistant checkpoint draft with a generic checkpoint", async () => {
    const secret = "api_key = abcdefghijklmnop";
    const backend = new ScriptedBackend(
      [call("answer", { text: `Task complete; ${secret}` })],
      [
        JSON.stringify({
          summary: `The assistant reported ${secret}`,
          nextActions: ["Continue safely."],
        }),
      ],
    );
    const checkpoint = vi.fn().mockResolvedValue({ id: "guarded-checkpoint" });
    const { instance } = loop(backend, {
      memory: {
        client: { checkpoint },
        workspaceRoot: "/repo",
        sessionId: "secret-session",
      },
    });

    await instance.runUserTurn("finish the task");
    await instance.checkpointSession();

    expect(checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "session summary unavailable — 1 turn elided",
        nextActions: ["Continue the user's latest task."],
      }),
    );
    expect(JSON.stringify(checkpoint.mock.calls[0][0])).not.toContain(secret);
  });

  it("replaces a draft that echoes a file-result shingle with a generic checkpoint", async () => {
    const fileExcerpt =
      "This exact project configuration sentence came from a private file and must never be copied into durable model summaries.";
    const backend = new ScriptedBackend(
      [
        call("read_file", { path: "AGENTS.md" }),
        call("answer", { text: "The file was reviewed." }),
      ],
      [
        JSON.stringify({
          summary: `The file said: ${fileExcerpt}`,
          nextActions: ["Continue."],
        }),
      ],
    );
    const checkpoint = vi.fn().mockResolvedValue({ id: "guarded-checkpoint" });
    const { instance, hostCall } = loop(backend, {
      memory: {
        client: { checkpoint },
        workspaceRoot: "/repo",
        sessionId: "file-session",
      },
    });
    hostCall.mockResolvedValue({ kind: "text", content: fileExcerpt });

    await instance.runUserTurn("read the project instructions");
    await instance.checkpointSession();

    expect(checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "session summary unavailable — 1 turn elided",
      }),
    );
    expect(JSON.stringify(checkpoint.mock.calls[0][0])).not.toContain(
      fileExcerpt,
    );
  });

  it("aborts a stalled summary, restores the eight-turn cap, and continues", async () => {
    const totalTurns = MAX_RETAINED_TURNS + 3;
    const backend = new StalledSummaryBackend(
      Array.from({ length: totalTurns }, (_, index) =>
        call("answer", { text: `done-${index}` }),
      ),
    );
    const checkpoint = vi.fn().mockResolvedValue({ id: "never-written" });
    const { instance, activity } = loop(backend, {
      modelContextTokens: 2_500,
      maxTokens: 128,
      marginTokens: 32,
      summaryTimeoutMs: 10,
      memory: {
        client: { checkpoint },
        workspaceRoot: "/repo",
        sessionId: "timeout-session",
      },
    });

    for (let index = 0; index < MAX_RETAINED_TURNS + 1; index += 1) {
      await instance.runUserTurn(`goal-${index}`);
    }
    await instance.runUserTurn("z".repeat(8_000));
    await instance.runUserTurn("continue after timeout");

    expect(backend.summaryAborted).toBe(true);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(activity.join("\n")).toContain("bounded local context");
    const messages = backend.requests.at(-1)?.messages ?? [];
    expect(messages.some((message) => message.content === "done-0")).toBe(
      false,
    );
    expect(
      messages.some((message) => message.content === "[earlier turns elided]"),
    ).toBe(true);
  });

  it("writes a stable session checkpoint when the agent session ends cleanly", async () => {
    const backend = new ScriptedBackend(
      [
        call("read_file", { path: "AGENTS.md" }),
        call("answer", { text: "The task is complete." }),
      ],
      [
        JSON.stringify({
          summary: "Completed the task.",
          nextActions: ["Review the result."],
        }),
      ],
    );
    const checkpoint = vi.fn().mockResolvedValue({ id: "session-checkpoint" });
    const { instance } = loop(backend, {
      memory: {
        client: { checkpoint },
        workspaceRoot: "/repo",
        sessionId: "agent-session-2",
        checkpointSummaryPrefix: "Delegation from codex.",
      },
    });

    await instance.runUserTurn("finish the task");
    await expect(instance.checkpointSession()).resolves.toEqual({
      status: "written",
      idempotencyKey: "agent-session-2:end",
      checkpointId: "session-checkpoint",
    });
    expect(backend.summaryRequests[0].messages[1].content).toContain(
      "raw tool result withheld",
    );
    expect(backend.summaryRequests[0].messages[1].content).not.toContain(
      "grounded bytes",
    );
    expect(checkpoint).toHaveBeenCalledWith({
      workspaceRoot: "/repo",
      summary: "Delegation from codex. Completed the task.",
      nextActions: ["Review the result."],
      sessionId: "agent-session-2",
      idempotencyKey: "agent-session-2:end",
    });
  });
});
