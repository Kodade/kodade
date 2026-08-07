// Dialect parsing, driven by NDJSON captured from the REAL shipped CLIs
// (fixtures/*.jsonl). If a CLI changes its stream shape, these fail here rather
// than as an empty chat pane.

import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../providers/catalog";
import { adapterFor, chatProviderIds } from "./registry";
import type { AgentStreamEvent } from "./contract";
import { buildAgentArgs, looksLikeAuthFailure } from "./engine";
import { CLAUDE_TOOL_TURN, CODEX_TOOL_TURN, GROK_TOOL_TURN } from "./fixtures";

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

  it("ends with exactly one done carrying usage", () => {
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      type: "done",
      finishReason: "end_turn",
      usage: { promptTokens: 18, completionTokens: 152, totalTokens: 170 },
    });
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
      sessionId: "019fde14-62ad-7311-bb01-5bd073af3f66",
    });
  });

  it("assembles delta-only text into per-message completes at boundaries", () => {
    const complete = events.filter((e) => e.type === "message-complete");
    expect(complete).toHaveLength(2);
    expect(complete[0]).toMatchObject({
      messageId: "msg-1",
      message: {
        role: "assistant",
        content: "I'll read `hello.txt` and pull out the secret number.",
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
      text: "The file contains the secret number 4217.",
    });
    expect(events.filter((e) => e.type === "thinking-delta").length).toBeGreaterThan(0);
  });

  it("pairs a tool call with its terminal update by call id", () => {
    const started = events.find((e) => e.type === "tool-call-started");
    const completed = events.find((e) => e.type === "tool-call-completed");
    expect(started).toEqual({
      type: "tool-call-started",
      callId: "call-de276e3a-54fd-4fa0-8aab-5d4c0a1a4bdf-0",
      call: {
        tool: "read_file",
        args: { target_file: "/private/tmp/grok-smoke/hello.txt" },
      },
    });
    expect(completed).toEqual({
      type: "tool-call-completed",
      callId: "call-de276e3a-54fd-4fa0-8aab-5d4c0a1a4bdf-0",
      outcome: { status: "executed", result: "1→Ködade fixture secret: 4217\n" },
    });
  });

  it("ends with exactly one done carrying usage", () => {
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      type: "done",
      finishReason: "end_turn",
      usage: { promptTokens: 16043, completionTokens: 83, totalTokens: 16126 },
    });
  });

  it("reports a non-zero command exit as a failed tool outcome", () => {
    // Real capture: a failing command still updates with status "completed";
    // the failure lives in rawOutput.exit_code.
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

describe("run termination is uniform across dialects", () => {
  it("a crash with no terminal frame still produces one error and one done", () => {
    for (const id of chatProviderIds()) {
      const events = drain(id, [], 1, "boom: the CLI fell over");
      expect(events).toEqual([
        { type: "error", message: "boom: the CLI fell over" },
        { type: "done" },
      ]);
    }
  });

  it("stderr that reads like a login failure becomes an auth error", () => {
    for (const id of chatProviderIds()) {
      const events = drain(id, [], 1, "Not logged in. Run `codex login` to continue.");
      expect(events[0]).toMatchObject({ type: "auth-error" });
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
      adapter.spawn({ prompt: "again", cwd: "/repo", resumeId: "thread-1", model: "gpt-5" }).args,
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

  it("a fresh codex turn takes no resume args at all", () => {
    expect(adapterFor("codex")!.spawn({ prompt: "hi", cwd: "/repo" }).args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
    ]);
  });

  it("grok keeps the stdin prompt file and resumes with the session id", () => {
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
    for (const id of chatProviderIds()) {
      const args = adapterFor(id)!.spawn({ prompt: "x", cwd: "/repo" }).args;
      expect(args).not.toContain("--effort");
      expect(args.some((arg) => arg.includes("model_reasoning_effort"))).toBe(false);
    }
  });
});

describe("providers without a verified stream have no adapter", () => {
  it("opencode, ollama and KödLocal are terminal-only for now", () => {
    for (const id of ["opencode", "ollama", "kodade-local"]) {
      expect(providerOf(id).stream).toBeUndefined();
      expect(adapterFor(id)).toBeNull();
    }
    expect(chatProviderIds()).toEqual(["claude", "codex", "grok"]);
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
