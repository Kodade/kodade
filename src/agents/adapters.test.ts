// Dialect parsing, driven by NDJSON captured from the REAL shipped CLIs
// (fixtures/*.jsonl). If a CLI changes its stream shape, these fail here rather
// than as an empty chat pane.

import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../providers/catalog";
import { adapterFor, chatProviderIds, streamProviderIds } from "./registry";
import type { AgentStreamEvent } from "./contract";
import { buildAgentArgs, looksLikeAuthFailure } from "./engine";
import { encodeClaudeUserMessage } from "./claude-input";
import {
  DEFAULT_AMBIENT_PROMPT,
  ambientPrompt,
  ambientPromptFor,
} from "../harness/ambient";
import {
  CLAUDE_TOOL_TURN,
  CODEX_COLLABORATION_TURN,
  CODEX_TOOL_TURN,
  GROK_TOOL_TURN,
  OPENCODE_TOOL_TURN,
} from "./fixtures";

function drain(
  providerId: string,
  lines: string[],
  code: number | null = 0,
  stderr = "",
): AgentStreamEvent[] {
  const adapter = adapterFor(providerId);
  if (!adapter) throw new Error(`no adapter for ${providerId}`);
  const parser = adapter.createParser();
  const events = lines.flatMap((line) => parser.line(line));
  return [...events, ...parser.end(code, stderr)];
}

const providerOf = (id: string) => PROVIDERS.find((p) => p.id === id)!;

describe("claude dialect", () => {
  const events = drain("claude", CLAUDE_TOOL_TURN);

  it("captures the resumable session id from the init frame", () => {
    expect(events[0]).toEqual({
      type: "session",
      sessionId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("streams assistant text as deltas and then as one authoritative message", () => {
    const deltas = events.filter((e) => e.type === "message-delta");
    expect(deltas.map((e) => (e.type === "message-delta" ? e.text : ""))).toEqual([
      "The",
      " file contains:\n```\nhello world\n```",
    ]);
    const complete = events.filter((e) => e.type === "message-complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({
      type: "message-complete",
      message: { role: "assistant", content: "The file contains:\n```\nhello world\n```" },
    });
  });

  it("surfaces thinking separately from the answer", () => {
    const thinking = events.filter((e) => e.type === "thinking-complete");
    expect(thinking).toHaveLength(2);
    expect(thinking[1]).toMatchObject({
      type: "thinking-complete",
      text: 'The file contains "hello world" on the first line, followed by an empty second line.',
    });
    // Deltas arrive before the assembled block, so a pane can show live thinking.
    expect(events.filter((e) => e.type === "thinking-delta").length).toBeGreaterThan(0);
  });

  it("pairs a tool call with its result by tool_use id", () => {
    const started = events.find((e) => e.type === "tool-call-started");
    const completed = events.find((e) => e.type === "tool-call-completed");
    expect(started).toEqual({
      type: "tool-call-started",
      callId: "toolu_01JoiZje2etSxv7BfJE9wUQK",
      call: { tool: "Read", args: { file_path: "/private/tmp/kodchat-probe/note.txt" } },
    });
    expect(completed).toEqual({
      type: "tool-call-completed",
      callId: "toolu_01JoiZje2etSxv7BfJE9wUQK",
      outcome: { status: "executed", result: "1\thello world\n2\t" },
    });
  });

  it("does not treat a provider result as process completion", () => {
    const adapter = adapterFor("claude");
    if (!adapter) throw new Error("Claude adapter missing");
    const parser = adapter.createParser({ providerResultIsTerminal: false });
    const result = CLAUDE_TOOL_TURN.flatMap((line) => parser.line(line));
    const done = result.filter((e) => e.type === "done");
    expect(done).toHaveLength(0);
    expect(parser.end(0, "").filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("maps TodoWrite onto a plan block", () => {
    const planned = drain("claude", [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_1",
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
      }),
    ]);
    expect(planned.find((e) => e.type === "plan")).toEqual({
      type: "plan",
      items: [
        { text: "Read the file", status: "completed" },
        { text: "Explain it", status: "in-progress" },
      ],
    });
  });

  it("routes an is_error result through the auth classifier", () => {
    const events = drain("claude", [
      JSON.stringify({
        type: "result",
        is_error: true,
        session_id: "s1",
        result: "Invalid API key · Please run /login",
      }),
    ]);
    expect(events.find((e) => e.type === "auth-error")).toMatchObject({
      type: "auth-error",
    });
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("preserves a nonzero native exit failure after a result frame", () => {
    const adapter = adapterFor("claude");
    if (!adapter) throw new Error("Claude adapter missing");
    const parser = adapter.createParser({ providerResultIsTerminal: false });
    const events = [
      ...parser.line(JSON.stringify({ type: "result", session_id: "s1" })),
      ...parser.end(1, "native provider process failed"),
    ];
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", message: "native provider process failed" }),
      ]),
    );
  });
});

describe("codex dialect", () => {
  const events = drain("codex", CODEX_TOOL_TURN);

  it("captures the resumable thread id", () => {
    expect(events[0]).toEqual({
      type: "session",
      sessionId: "019f9d04-d92c-7541-a30f-d41f475ffebf",
    });
  });

  it("emits whole assistant messages (this dialect has no token deltas)", () => {
    expect(events.filter((e) => e.type === "message-delta")).toHaveLength(0);
    const complete = events.filter((e) => e.type === "message-complete");
    expect(complete).toHaveLength(2);
    expect(complete[1]).toMatchObject({
      message: { role: "assistant", content: "`note.txt` contains:\n\n```text\nhello world\n```" },
    });
  });

  it("opens a tool card on item.started and closes it on item.completed", () => {
    const started = events.filter((e) => e.type === "tool-call-started");
    const completed = events.filter((e) => e.type === "tool-call-completed");
    expect(started).toEqual([
      {
        type: "tool-call-started",
        callId: "item_3",
        call: { tool: "shell", args: { command: `/bin/zsh -lc "sed -n '1,200p' note.txt"` } },
      },
    ]);
    expect(completed).toEqual([
      {
        type: "tool-call-completed",
        callId: "item_3",
        outcome: { status: "executed", result: "hello world\n" },
      },
    ]);
  });

  it("renders collaboration calls as paired, sanitized tool cards", () => {
    const events = drain("codex", CODEX_COLLABORATION_TURN);
    expect(events.filter((event) => event.type === "tool-call-started")).toEqual([
      {
        type: "tool-call-started",
        callId: "item_collab_wait",
        call: {
          tool: "wait",
          args: {
            receiver_thread_ids: [],
            prompt: null,
            agents_states: {},
          },
        },
      },
    ]);
    expect(events.filter((event) => event.type === "tool-call-completed")).toEqual([
      {
        type: "tool-call-completed",
        callId: "item_collab_wait",
        outcome: { status: "executed", result: "" },
      },
    ]);
  });

  it("preserves richer collaboration fields and failures when Codex emits them", () => {
    const rich = drain("codex", [
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_collab_spawn",
          type: "collab_tool_call",
          tool: "spawn_agent",
          sender_thread_id: "thread_parent",
          receiver_thread_ids: ["thread_child"],
          prompt: "Inspect the parser",
          agents_states: { thread_child: "running" },
          internal_trace: "omit-me",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_collab_spawn",
          type: "collab_tool_call",
          tool: "spawn_agent",
          receiver_thread_ids: ["thread_child"],
          prompt: "Inspect the parser",
          agents_states: { thread_child: "completed" },
          result: "spawned thread_child",
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_collab_message",
          type: "collab_tool_call",
          tool: "send_message",
          receiver_thread_ids: ["thread_child"],
          prompt: "Send evidence",
          agents_states: { thread_child: "failed" },
          result: "delivery failed",
          status: "failed",
        },
      }),
    ]);

    expect(rich.filter((event) => event.type === "tool-call-started")).toEqual([
      {
        type: "tool-call-started",
        callId: "item_collab_spawn",
        call: {
          tool: "spawn_agent",
          args: {
            receiver_thread_ids: ["thread_child"],
            prompt: "Inspect the parser",
            agents_states: { thread_child: "running" },
          },
        },
      },
      {
        type: "tool-call-started",
        callId: "item_collab_message",
        call: {
          tool: "send_message",
          args: {
            receiver_thread_ids: ["thread_child"],
            prompt: "Send evidence",
            agents_states: { thread_child: "failed" },
          },
        },
      },
    ]);
    expect(rich.filter((event) => event.type === "tool-call-completed")).toEqual([
      {
        type: "tool-call-completed",
        callId: "item_collab_spawn",
        outcome: { status: "executed", result: "spawned thread_child" },
      },
      {
        type: "tool-call-completed",
        callId: "item_collab_message",
        outcome: { status: "error", result: "delivery failed" },
      },
    ]);
  });

  it("reports a non-zero command exit as a failed tool outcome", () => {
    const failed = drain("codex", [
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_9",
          type: "command_execution",
          command: "false",
          aggregated_output: "",
          exit_code: 1,
          status: "completed",
        },
      }),
    ]);
    expect(failed.find((e) => e.type === "tool-call-completed")).toEqual({
      type: "tool-call-completed",
      callId: "item_9",
      outcome: { status: "error", result: "exited with status 1" },
    });
    // A completed item with no prior item.started still opens its card.
    expect(failed.filter((e) => e.type === "tool-call-started")).toHaveLength(1);
  });

  it("ends with exactly one done carrying usage", () => {
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      type: "done",
      usage: { promptTokens: 50074, completionTokens: 118, totalTokens: 50192 },
    });
  });

  it("maps a todo list onto a plan block", () => {
    const planned = drain("codex", [
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_plan",
          type: "todo_list",
          items: [
            { text: "Inspect the parser", status: "in_progress" },
            { content: "Verify the change", completed: true },
          ],
        },
      }),
    ]);
    expect(planned.find((event) => event.type === "plan")).toEqual({
      type: "plan",
      items: [
        { text: "Inspect the parser", status: "in-progress" },
        { text: "Verify the change", status: "completed" },
      ],
    });
  });

  it("turns turn.failed into a failure plus a done", () => {
    const failed = drain("codex", [
      JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
    ]);
    expect(failed).toEqual([
      { type: "error", message: "stream disconnected" },
      { type: "done" },
    ]);
  });

  // Real codex runs emit config warnings as items of type `error` and then
  // complete normally. Treating those as failures would leave every thread on
  // such a machine permanently flagged "needs you".
  const WARNING_ITEM = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "error",
      message:
        "Under-development features enabled: chronicle. Under-development features are incomplete and may behave unpredictably.",
    },
  });

  it("drops error items when the turn still completes", () => {
    const events = drain("codex", [
      JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
      WARNING_ITEM,
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "done" },
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ]);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(events.filter((event) => event.type === "auth-error")).toHaveLength(0);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  });

  it("surfaces held-back error items when the turn never completes", () => {
    const events = drain(
      "codex",
      [JSON.stringify({ type: "thread.started", thread_id: "th-1" }), WARNING_ITEM],
      1,
      "",
    );
    const errors = events.filter((event) => event.type === "error");
    expect(errors[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("Under-development features"),
    });
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  });
});

describe("grok dialect", () => {
  const events = drain("grok", GROK_TOOL_TURN);

  it("captures the resumable session id from the end frame", () => {
    expect(events.find((e) => e.type === "session")).toEqual({
      type: "session",
      sessionId: "fixture-session-1",
    });
  });

  it("assembles delta-only text into per-message completes at boundaries", () => {
    const complete = events.filter((e) => e.type === "message-complete");
    expect(complete).toHaveLength(2);
    expect(complete[0]).toMatchObject({
      messageId: "msg-1",
      message: {
        role: "assistant",
        content: "I'll read `fixture.txt` and the sample value.",
      },
    });
    expect(complete[1]).toMatchObject({
      messageId: "msg-2",
      message: { role: "assistant", content: "**4217**" },
    });
    // Deltas share the id of the message they later complete into.
    const deltas = events.filter((e) => e.type === "message-delta");
    expect(deltas[0]).toMatchObject({ messageId: "msg-1", text: "I'll" });
    expect(deltas.at(-1)).toMatchObject({ messageId: "msg-2", text: "**" });
  });

  it("surfaces thinking separately from the answer", () => {
    const thinking = events.filter((e) => e.type === "thinking-complete");
    expect(thinking).toHaveLength(2);
    expect(thinking[1]).toMatchObject({
      messageId: "thinking-2",
      text: "The file contains the sample value 4217.",
    });
    expect(events.filter((e) => e.type === "thinking-delta").length).toBeGreaterThan(0);
  });

  it("pairs a tool call with its terminal update by call id", () => {
    const started = events.find((e) => e.type === "tool-call-started");
    const completed = events.find((e) => e.type === "tool-call-completed");
    expect(started).toEqual({
      type: "tool-call-started",
      callId: "call-fixture-read-1",
      call: {
        tool: "read_file",
        args: { target_file: "/fixture/hello.txt" },
      },
    });
    expect(completed).toEqual({
      type: "tool-call-completed",
      callId: "call-fixture-read-1",
      outcome: { status: "executed", result: "1→Fixture sample value: 4217\n" },
    });
  });

  it("ends with exactly one done carrying usage", () => {
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      type: "done",
      finishReason: "end_turn",
      usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 },
    });
  });

  it("reports a non-zero command exit as a failed tool outcome", () => {
    // A failing command can update with status "completed"; the failure lives
    // in rawOutput.exit_code.
    const failed = drain("grok", [
      JSON.stringify({
        type: "tool_call",
        toolCallId: "call-9",
        toolName: "run_terminal_command",
        rawInput: { command: "ls /nonexistent-kodade-dir" },
      }),
      JSON.stringify({
        type: "tool_call_update",
        toolCallId: "call-9",
        status: "completed",
        content: [],
        rawOutput: { type: "Bash", exit_code: 2 },
      }),
    ]);
    expect(failed.find((e) => e.type === "tool-call-completed")).toEqual({
      type: "tool-call-completed",
      callId: "call-9",
      outcome: { status: "error", result: "exited with status 2" },
    });
  });

  it("maps todo_write onto a plan block, skipping merge entries without text", () => {
    const planned = drain("grok", [
      JSON.stringify({
        type: "tool_call",
        toolCallId: "call-plan",
        toolName: "todo_write",
        rawInput: {
          todos: [
            { id: "1", content: "Run the failing command", status: "in_progress" },
            { id: "2", content: "Report the result", status: "pending" },
            { id: "3", status: "completed" },
          ],
          merge: false,
        },
      }),
    ]);
    expect(planned.find((e) => e.type === "plan")).toEqual({
      type: "plan",
      items: [
        { text: "Run the failing command", status: "in-progress" },
        { text: "Report the result", status: "pending" },
      ],
    });
  });
});

describe("opencode dialect", () => {
  const events = drain("opencode", OPENCODE_TOOL_TURN.slice(0, -1));

  it("captures its native session and completed message parts", () => {
    expect(events[0]).toEqual({ type: "session", sessionId: "ses_fixture" });
    expect(events.find((event) => event.type === "message-complete")).toMatchObject({
      message: { role: "assistant", content: "fixture-ok" },
    });
  });

  it("maps reasoning, tool output, and step token usage", () => {
    expect(
      events
        .filter((event) => event.type === "thinking-complete")
        .map((event) => event.text),
    ).toEqual([
      "I should inspect the fixture before answering.",
      "I should summarize the completed read.",
    ]);
    expect(events.find((event) => event.type === "tool-call-completed")).toEqual({
      type: "tool-call-completed",
      callId: "call_fixture_read",
      outcome: { status: "executed", result: "fixture-ok\n" },
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      usage: { promptTokens: 15, completionTokens: 6, totalTokens: 24 },
    });
  });

  it("maps a todo tool call onto a plan block", () => {
    const planned = drain("opencode", [
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_plan",
        part: {
          id: "part_plan",
          callID: "call_plan",
          tool: "todowrite",
          state: {
            status: "completed",
            input: {
              todos: [
                { content: "Inspect the parser", status: "in-progress" },
                { text: "Verify the change", status: "completed" },
              ],
            },
            output: "updated",
          },
        },
      }),
    ]);
    expect(planned.find((event) => event.type === "plan")).toEqual({
      type: "plan",
      items: [
        { text: "Inspect the parser", status: "in-progress" },
        { text: "Verify the change", status: "completed" },
      ],
    });
  });

  it("ignores malformed output and makes the captured auth failure actionable", () => {
    const noisy = drain("opencode", ["not json", OPENCODE_TOOL_TURN.at(-1)!], 1);
    expect(noisy).toEqual([
      { type: "session", sessionId: "ses_auth_fixture" },
      { type: "auth-error", message: "OpenRouter API key is missing." },
      { type: "done" },
    ]);
  });
});

describe("run termination is uniform across dialects", () => {
  it("a crash with no terminal frame still produces one error and one done", () => {
    for (const id of streamProviderIds()) {
      const events = drain(id, [], 1, "boom: the CLI fell over");
      expect(events).toEqual([
        { type: "error", message: "boom: the CLI fell over" },
        { type: "done" },
      ]);
    }
  });

  it("stderr that reads like a login failure becomes an auth error", () => {
    for (const id of streamProviderIds()) {
      const events = drain(id, [], 1, "Not logged in. Run `codex login` to continue.");
      expect(events[0]).toMatchObject({ type: "auth-error" });
    }
  });

  // Each shipped CLI complains about being signed out in its own words. All
  // four must reach the transcript's auth card, since that card is the only
  // in-chat path back to a signed-in provider (issue #63).
  it("classifies each shipped CLI's own signed-out wording", () => {
    const wording: Record<string, string> = {
      claude: "Invalid API key · Please run /login",
      codex: "stream error: unauthorized; run `codex login` to continue",
      grok: "Error: authentication failed (401): no credentials found",
      opencode: "Error: OpenRouter API key is missing.",
    };
    for (const [id, stderr] of Object.entries(wording)) {
      expect(drain(id, [], 1, stderr)[0]).toMatchObject({
        type: "auth-error",
        message: stderr,
      });
    }
  });

  it("a clean exit after the CLI reported done adds nothing", () => {
    const events = drain("codex", [JSON.stringify({ type: "turn.completed" })], 0, "");
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});

describe("argv comes from the catalog, not the adapters", () => {
  // Standard access must pre-approve commands and out-of-project reads:
  // headless `-p` runs cannot answer a permission prompt, so anything not
  // allowed here is silently denied (the original all-tools-fail bug).
  const CLAUDE_STANDARD = [
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash",
    "Read",
    "WebFetch",
    "WebSearch",
  ];

  it("claude resumes with the session id and pipes the prompt", () => {
    const adapter = adapterFor("claude")!;
    expect(adapter.spawn({ prompt: "hi", cwd: "/repo" })).toEqual({
      bin: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        ...CLAUDE_STANDARD,
      ],
      stdin: "hi",
    });
    expect(
      adapter.spawn({ prompt: "again", cwd: "/repo", resumeId: "sess-1", model: "opus" }).args,
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...CLAUDE_STANDARD,
      "--model",
      "opus",
      "--resume",
      "sess-1",
    ]);
  });

  it("codex keeps exec options ahead of the resume subcommand", () => {
    const adapter = adapterFor("codex")!;
    // Order is load-bearing: `codex exec resume --json` is a parse error.
    expect(
      adapter.spawn({
        prompt: "again",
        cwd: "/repo",
        resumeId: "thread-1",
        model: "gpt-5",
        speed: "default",
      }).args,
    ).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--model",
      "gpt-5",
      "resume",
      "thread-1",
      "-",
    ]);
  });

  it("codex fast mode adds both per-turn overrides before resume", () => {
    const args = adapterFor("codex")!.spawn({
      prompt: "again",
      cwd: "/repo",
      resumeId: "thread-1",
      speed: "fast",
    }).args;

    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-c",
      "features.fast_mode=true",
      "-c",
      "service_tier=fast",
      "resume",
      "thread-1",
      "-",
    ]);
  });

  it("a fresh codex turn takes no resume args at all", () => {
    expect(adapterFor("codex")!.spawn({ prompt: "hi", cwd: "/repo" }).args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
    ]);
  });

  it("grok launches either supported model and keeps resume after model args", () => {
    const adapter = adapterFor("grok")!;
    expect(adapter.spawn({ prompt: "hi", cwd: "/repo" })).toEqual({
      bin: "grok",
      args: [
        "--prompt-file",
        "/dev/stdin",
        "--output-format",
        "streaming-json",
        "--permission-mode",
        "acceptEdits",
      ],
      stdin: "hi",
    });
    expect(
      adapter.spawn({ prompt: "next", cwd: "/repo", model: "grok-4.6" }),
    ).toEqual({
      bin: "grok",
      args: [
        "--prompt-file",
        "/dev/stdin",
        "--output-format",
        "streaming-json",
        "--permission-mode",
        "acceptEdits",
        "--model",
        "grok-4.6",
      ],
      stdin: "next",
    });
    expect(
      adapter.spawn({ prompt: "again", cwd: "/repo", resumeId: "sess-1", model: "grok-4.5" })
        .args,
    ).toEqual([
      "--prompt-file",
      "/dev/stdin",
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "acceptEdits",
      "--model",
      "grok-4.5",
      "--resume",
      "sess-1",
    ]);
  });

  it("opencode runs JSON through stdin, maps access to its own agents, and resumes natively", () => {
    const adapter = adapterFor("opencode")!;
    expect(adapter.spawn({ prompt: "hi", cwd: "/repo", access: "plan" })).toEqual({
      bin: "opencode",
      args: ["run", "--format", "json", "--thinking", "--agent", "plan"],
      stdin: "hi",
    });
    expect(
      adapter.spawn({
        prompt: "again",
        cwd: "/repo",
        access: "full",
        resumeId: "ses_fixture",
        model: "openrouter/fixture-model",
      }).args,
    ).toEqual([
      "run",
      "--format",
      "json",
      "--thinking",
      "--agent",
      "build",
      "--auto",
      "--model",
      "openrouter/fixture-model",
      "--session",
      "ses_fixture",
    ]);
  });

  it("access levels map to each CLI's own posture flags", () => {
    const claude = adapterFor("claude")!;
    const codex = adapterFor("codex")!;
    const grok = adapterFor("grok")!;
    expect(claude.spawn({ prompt: "x", cwd: "/repo", access: "plan" }).args).toContain("plan");
    expect(codex.spawn({ prompt: "x", cwd: "/repo", access: "plan" }).args).toContain(
      "read-only",
    );
    expect(grok.spawn({ prompt: "x", cwd: "/repo", access: "plan" }).args).toContain("plan");
    expect(claude.spawn({ prompt: "x", cwd: "/repo", access: "full" }).args).toContain(
      "--dangerously-skip-permissions",
    );
    expect(codex.spawn({ prompt: "x", cwd: "/repo", access: "full" }).args).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(grok.spawn({ prompt: "x", cwd: "/repo", access: "full" }).args).toContain(
      "bypassPermissions",
    );
  });

  it("bypass flags appear ONLY when the user explicitly chose full access", () => {
    // The posture pin, updated for access levels: the default never bypasses.
    const banned = [
      "--dangerously-skip-permissions",
      "--dangerously-bypass-approvals-and-sandbox",
      "bypassPermissions",
      "danger-full-access",
    ];
    for (const access of [undefined, "plan", "standard"] as const) {
      const claude = adapterFor("claude")!.spawn({ prompt: "x", cwd: "/repo", access }).args;
      const codex = adapterFor("codex")!.spawn({ prompt: "x", cwd: "/repo", access }).args;
      const grok = adapterFor("grok")!.spawn({ prompt: "x", cwd: "/repo", access }).args;
      for (const args of [claude, codex, grok]) {
        for (const flag of banned) expect(args).not.toContain(flag);
      }
    }
    const claudeDefault = adapterFor("claude")!.spawn({ prompt: "x", cwd: "/repo" }).args;
    const codexDefault = adapterFor("codex")!.spawn({ prompt: "x", cwd: "/repo" }).args;
    const grokDefault = adapterFor("grok")!.spawn({ prompt: "x", cwd: "/repo" }).args;
    expect(claudeDefault).toContain("acceptEdits");
    expect(codexDefault).toContain("workspace-write");
    expect(grokDefault).toContain("acceptEdits");
  });

  it("templates are only substituted when the caller supplied a value", () => {
    const stream = providerOf("claude").stream!;
    expect(
      buildAgentArgs(stream, { prompt: "", cwd: "", resumeId: null, model: null }),
    ).toEqual([...stream.args, ...stream.accessArgs.standard]);
  });

  it("claude places the thinking level after the model and before resume", () => {
    // `--effort <level>` verified against claude 2.1.223 --help.
    const args = adapterFor("claude")!.spawn({
      prompt: "again",
      cwd: "/repo",
      resumeId: "sess-1",
      model: "claude-opus-5",
      thinking: "xhigh",
    }).args;
    expect(args.join(" ")).toContain("--model claude-opus-5 --effort xhigh --resume sess-1");
  });

  it("codex passes thinking as a -c override, still ahead of resume", () => {
    // `-c model_reasoning_effort=<level>` verified against codex 0.146.1.
    const args = adapterFor("codex")!.spawn({
      prompt: "again",
      cwd: "/repo",
      resumeId: "thread-1",
      model: "gpt-5.6-sol",
      thinking: "ultra",
    }).args;
    expect(args.join(" ")).toContain(
      "--model gpt-5.6-sol -c model_reasoning_effort=ultra resume thread-1 -",
    );
  });

  it("drops a thinking level the chosen model does not offer", () => {
    // gpt-5.5's registry entry tops out at xhigh; a stale "ultra" (from a
    // model switch or hand-edited document) must not reach the CLI.
    const args = adapterFor("codex")!.spawn({
      prompt: "x",
      cwd: "/repo",
      model: "gpt-5.5",
      thinking: "ultra",
    }).args;
    expect(args).not.toContain("-c");
    expect(
      adapterFor("codex")!.spawn({ prompt: "x", cwd: "/repo", model: "gpt-5.5", thinking: "xhigh" })
        .args,
    ).toContain("model_reasoning_effort=xhigh");
  });

  it("no thinking pick means no thinking args at all", () => {
    for (const id of streamProviderIds()) {
      const args = adapterFor(id)!.spawn({ prompt: "x", cwd: "/repo" }).args;
      expect(args).not.toContain("--effort");
      expect(args.some((arg) => arg.includes("model_reasoning_effort"))).toBe(false);
    }
  });
});

describe("providers without a verified stream have no adapter", () => {
  it("ollama and KödLocal remain outside the CLI stream adapters", () => {
    for (const id of ["ollama", "kodade-local"]) {
      expect(providerOf(id).stream).toBeUndefined();
      expect(adapterFor(id)).toBeNull();
    }
    expect(chatProviderIds()).toEqual(["claude", "codex", "grok", "opencode", "ollama"]);
  });

  it("an unknown provider id is null, not a throw", () => {
    expect(adapterFor("nope")).toBeNull();
  });
});

describe("auth classification", () => {
  it("recognizes the vocabulary CLIs actually use", () => {
    for (const message of [
      "Not logged in",
      "Please run `claude login`",
      "Authentication failed",
      "401 Unauthorized",
      "Invalid API key",
      "OAuth token has expired",
      "login required",
    ]) {
      expect(looksLikeAuthFailure(message)).toBe(true);
    }
  });

  it("does not swallow ordinary failures", () => {
    for (const message of [
      "ENOENT: no such file or directory",
      "the model is overloaded, try again",
      "rate limit exceeded",
    ]) {
      expect(looksLikeAuthFailure(message)).toBe(false);
    }
  });
});

// Ködade's background prompt (issue #63). The pre-slice construction is
// pinned here byte-for-byte: with the prompt off, or absent, a spawn must be
// exactly what it was before the feature existed.
describe("the Ködade background prompt reaches only spawned sessions", () => {
  const AMBIENT = "You are running inside Ködade.";

  // Captured from the shipped adapters BEFORE this slice.
  const BASELINE: Record<string, { fresh: string[]; resume: string[] }> = {
    claude: {
      fresh: [
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
      resume: [
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
        "--resume",
        "s1",
      ],
    },
    codex: {
      fresh: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write"],
      resume: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "resume",
        "s1",
        "-",
      ],
    },
    grok: {
      fresh: [
        "--prompt-file",
        "/dev/stdin",
        "--output-format",
        "streaming-json",
        "--permission-mode",
        "acceptEdits",
      ],
      resume: [
        "--prompt-file",
        "/dev/stdin",
        "--output-format",
        "streaming-json",
        "--permission-mode",
        "acceptEdits",
        "--resume",
        "s1",
      ],
    },
    opencode: {
      fresh: ["run", "--format", "json", "--thinking", "--agent", "build"],
      resume: [
        "run",
        "--format",
        "json",
        "--thinking",
        "--agent",
        "build",
        "--session",
        "s1",
      ],
    },
  };

  it("no ambient prompt spawns byte-identically to the pre-slice build", () => {
    for (const [id, baseline] of Object.entries(BASELINE)) {
      const adapter = adapterFor(id)!;
      for (const ambient of [undefined, null, "", "   "]) {
        expect(adapter.spawn({ prompt: "hi", cwd: "/repo", ambient })).toEqual({
          bin: providerOf(id).bin,
          args: baseline.fresh,
          stdin: "hi",
        });
        expect(
          adapter.spawn({ prompt: "hi", cwd: "/repo", resumeId: "s1", ambient }),
        ).toEqual({
          bin: providerOf(id).bin,
          args: baseline.resume,
          stdin: "hi",
        });
      }
    }
  });

  it("claude appends it to the default system prompt, on resume too", () => {
    const adapter = adapterFor("claude")!;
    expect(adapter.spawn({ prompt: "hi", cwd: "/repo", ambient: AMBIENT })).toEqual({
      bin: "claude",
      args: [...BASELINE.claude.fresh, `--append-system-prompt=${AMBIENT}`],
      stdin: "hi",
    });
    // Each turn is a fresh process, so the flag rides every spawn — and it
    // still precedes nothing that would break argument order.
    expect(
      adapter.spawn({ prompt: "hi", cwd: "/repo", resumeId: "s1", ambient: AMBIENT }).args,
    ).toEqual([
      ...BASELINE.claude.fresh,
      `--append-system-prompt=${AMBIENT}`,
      "--resume",
      "s1",
    ]);
  });

  // An override written as a markdown bullet list is ordinary user input, and
  // `grok --rules "- Be concise."` fails outright ("unexpected argument '- '"),
  // so the note must never reach a CLI as its own argv token.
  it("an override starting with a dash can never be read as a flag", () => {
    const bullets = "- Be concise.\n- Skip preamble.";
    for (const id of ["claude", "codex", "grok"]) {
      const args = adapterFor(id)!.spawn({ prompt: "hi", cwd: "/repo", ambient: bullets }).args;
      const carrying = args.filter((arg) => arg.includes("Be concise."));
      // Exactly one argv token, and the text is always attached to its key —
      // never a bare token the CLI's parser would see as another option.
      expect(carrying).toHaveLength(1);
      expect(carrying[0]).toMatch(/^(--[a-z-]+=|developer_instructions=")/);
    }
    expect(adapterFor("grok")!.spawn({ prompt: "hi", cwd: "/repo", ambient: bullets }).args)
      .toEqual([...BASELINE.grok.fresh, `--rules=${bullets}`]);
  });

  // String.replace expands `$&` and "$`" in a replacement, so a prompt using
  // either would arrive at the CLI corrupted if any substitution used the
  // plain string form.
  it("dollar sequences in the prompt survive substitution verbatim", () => {
    const tricky = "Prefer $& over $` and $$ in examples.";
    expect(
      adapterFor("claude")!.spawn({ prompt: "hi", cwd: "/repo", ambient: tricky }).args.at(-1),
    ).toBe(`--append-system-prompt=${tricky}`);
    expect(
      adapterFor("grok")!.spawn({ prompt: "hi", cwd: "/repo", ambient: tricky }).args.at(-1),
    ).toBe(`--rules=${tricky}`);
    expect(
      adapterFor("codex")!.spawn({ prompt: "hi", cwd: "/repo", ambient: tricky }).args.at(-1),
    ).toBe(`developer_instructions="${tricky}"`);
    // The same hazard applies to every other templated value.
    expect(
      adapterFor("claude")!.spawn({ prompt: "hi", cwd: "/repo", resumeId: "$&x" }).args.at(-1),
    ).toBe("$&x");
    expect(
      adapterFor("claude")!.spawn({ prompt: "hi", cwd: "/repo", model: "$`m" }).args,
    ).toContain("$`m");
  });

  it("codex sends it as a TOML-quoted developer_instructions override", () => {
    const adapter = adapterFor("codex")!;
    expect(adapter.spawn({ prompt: "hi", cwd: "/repo", ambient: AMBIENT }).args).toEqual([
      ...BASELINE.codex.fresh,
      "-c",
      `developer_instructions="${AMBIENT}"`,
    ]);
    // Exec options must precede the resume subcommand, or codex refuses.
    expect(
      adapter.spawn({ prompt: "hi", cwd: "/repo", resumeId: "s1", ambient: AMBIENT }).args,
    ).toEqual([
      ...BASELINE.codex.fresh,
      "-c",
      `developer_instructions="${AMBIENT}"`,
      "resume",
      "s1",
      "-",
    ]);
  });

  it("codex quoting survives an override that looks like TOML", () => {
    const args = adapterFor("codex")!.spawn({
      prompt: "hi",
      cwd: "/repo",
      ambient: 'true\nsay "hi" \\ now',
    }).args;
    expect(args.at(-1)).toBe('developer_instructions="true\\nsay \\"hi\\" \\\\ now"');
  });

  // A pasted control character is illegal inside a TOML basic string; left
  // raw it would fail to parse and drop codex back to its raw-literal
  // fallback, defeating the quoting.
  it("codex escapes control characters instead of breaking the TOML value", () => {
    const args = adapterFor("codex")!.spawn({
      prompt: "hi",
      cwd: "/repo",
      ambient: "be\u0007terse\u0000now\u007f",
    }).args;
    expect(args.at(-1)).toBe('developer_instructions="be\\u0007terse\\u0000now\\u007F"');
    // Tabs and newlines keep their short escapes.
    expect(
      adapterFor("codex")!
        .spawn({ prompt: "hi", cwd: "/repo", ambient: "a\tb\nc" })
        .args.at(-1),
    ).toBe('developer_instructions="a\\tb\\nc"');
  });

  // Verified live before shipping this: a fresh codex run plus two
  // `exec resume --last` turns carrying the same override recorded the marker
  // text exactly once in the session's rollout JSONL, so the flag does NOT
  // accumulate per resume and belongs on every spawn.
  it("codex sends the override once per spawn, resume included", () => {
    const fresh = adapterFor("codex")!.spawn({ prompt: "hi", cwd: "/repo", ambient: AMBIENT });
    const resumed = adapterFor("codex")!.spawn({
      prompt: "hi",
      cwd: "/repo",
      resumeId: "s1",
      ambient: AMBIENT,
    });
    for (const spawn of [fresh, resumed]) {
      expect(
        spawn.args.filter((arg) => arg.startsWith("developer_instructions=")),
      ).toHaveLength(1);
    }
  });

  it("grok appends it through --rules, on resume too", () => {
    const adapter = adapterFor("grok")!;
    expect(adapter.spawn({ prompt: "hi", cwd: "/repo", ambient: AMBIENT }).args).toEqual([
      ...BASELINE.grok.fresh,
      `--rules=${AMBIENT}`,
    ]);
    expect(
      adapter.spawn({ prompt: "hi", cwd: "/repo", resumeId: "s1", ambient: AMBIENT }).args,
    ).toEqual([...BASELINE.grok.fresh, `--rules=${AMBIENT}`, "--resume", "s1"]);
  });

  it("opencode has no flag, so it rides the FIRST turn's stdin only", () => {
    const adapter = adapterFor("opencode")!;
    expect(adapter.spawn({ prompt: "hi", cwd: "/repo", ambient: AMBIENT })).toEqual({
      bin: "opencode",
      args: BASELINE.opencode.fresh, // argv is untouched
      stdin: `<kodade-harness>\n${AMBIENT}\n</kodade-harness>\n\nhi`,
    });
    // A resumed session already carries the note in its own history.
    expect(
      adapter.spawn({ prompt: "next", cwd: "/repo", resumeId: "s1", ambient: AMBIENT }),
    ).toEqual({
      bin: "opencode",
      args: BASELINE.opencode.resume,
      stdin: "next",
    });
  });

  it("flag providers never put the note in the prompt", () => {
    for (const id of ["claude", "codex", "grok"]) {
      const spawn = adapterFor(id)!.spawn({ prompt: "hi", cwd: "/repo", ambient: AMBIENT });
      expect(spawn.stdin).toBe("hi");
    }
  });

  it("KödWork's interactive claude spawn carries it too", () => {
    const spawn = adapterFor("claude")!.spawn({
      prompt: "hi",
      cwd: "/repo",
      ambient: AMBIENT,
      interactive: true,
    });
    expect(spawn.args).toContain(`--append-system-prompt=${AMBIENT}`);
    expect(spawn.initialInput).toBe(encodeClaudeUserMessage("hi"));
  });

  // Coverage that actually walks the chat-capable catalog: every CLI needs a
  // verified argv/stdin mechanism, and Ollama — which has no argv at all —
  // must be covered through its chat transport's system message instead
  // (asserted in chat/store.test.ts).
  it("every chat-capable provider is covered, Ollama included", () => {
    const covered: string[] = [];
    for (const id of chatProviderIds()) {
      const provider = providerOf(id);
      if (provider.stream) {
        expect(provider.stream.systemPrompt).toBeDefined();
        covered.push(id);
        continue;
      }
      // The only non-CLI chat transport. Its injection point is the system
      // message, so it has no catalog entry by design.
      expect(provider.chat?.kind).toBe("ollama");
      covered.push(id);
    }
    expect(covered).toEqual(["claude", "codex", "grok", "opencode", "ollama"]);
  });

  it("a user override replaces the default text verbatim", () => {
    const args = adapterFor("claude")!.spawn({
      prompt: "hi",
      cwd: "/repo",
      ambient: ambientPrompt("  Only speak in haiku.  "),
    }).args;
    expect(args).toContain("--append-system-prompt=Only speak in haiku.");
    expect(args).not.toContain(DEFAULT_AMBIENT_PROMPT);
  });

  it("the default is what an empty override resolves to", () => {
    expect(ambientPrompt("")).toBe(DEFAULT_AMBIENT_PROMPT);
    expect(ambientPrompt(null)).toBe(DEFAULT_AMBIENT_PROMPT);
    expect(ambientPromptFor(false, "Only speak in haiku.")).toBeNull();
    expect(ambientPromptFor(true, null)).toBe(DEFAULT_AMBIENT_PROMPT);
  });
});
