// Grok Build dialect (`grok --prompt-file /dev/stdin --output-format streaming-json`).
//
// An ACP-style update stream: `thought` and `text` frames carry raw token
// deltas with no message ids and no assembled envelope, `tool_call` /
// `tool_call_update` bracket tool work by call id, and one `end` frame closes
// the turn with the resumable session id and cumulative usage. Because nothing
// upstream assembles messages, this parser does: deltas accumulate per
// synthetic message id, and a boundary (tool call, kind switch, end) flushes
// the buffer as the authoritative `*-complete` event.
//
// The fixture preserves this stream shape. Flags live in providers/catalog.ts,
// not here.

import type { Provider, ProviderStream } from "../providers/catalog";
import type {
  AgentPlanItem,
  AgentRunRequest,
  AgentSpawn,
  AgentStreamAdapter,
  AgentStreamEvent,
  AgentStreamParser,
} from "./contract";
import {
  buildAgentSpawn,
  clampToolResult,
  endOfRunEvents,
  parseJsonLine,
} from "./engine";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

class GrokParser implements AgentStreamParser {
  private done = false;
  // Synthetic ids for the assembled messages, since grok's deltas carry none.
  private textSeq = 0;
  private textBuf = "";
  private thinkingSeq = 0;
  private thinkingBuf = "";
  // Call ids already reported as started, so a completion for a call that
  // somehow skipped its `tool_call` frame still produces a full card.
  private startedTools = new Set<string>();

  line(raw: string): AgentStreamEvent[] {
    const value = parseJsonLine(raw);
    if (!value) return [];
    switch (value.type) {
      case "thought": {
        const text = asString(value.data) ?? "";
        if (!text) return [];
        const events = this.flushText();
        if (!this.thinkingBuf) this.thinkingSeq += 1;
        this.thinkingBuf += text;
        events.push({
          type: "thinking-delta",
          messageId: `thinking-${this.thinkingSeq}`,
          text,
        });
        return events;
      }
      case "text": {
        const text = asString(value.data) ?? "";
        if (!text) return [];
        const events = this.flushThinking();
        if (!this.textBuf) this.textSeq += 1;
        this.textBuf += text;
        events.push({
          type: "message-delta",
          messageId: `msg-${this.textSeq}`,
          text,
        });
        return events;
      }
      case "tool_call":
        return [...this.flushAll(), ...this.toolStarted(value)];
      case "tool_call_update":
        return this.toolUpdated(value);
      case "end": {
        this.done = true;
        const events = this.flushAll();
        const sessionId = asString(value.sessionId);
        if (sessionId) events.push({ type: "session", sessionId });
        const usage = usageOf(asRecord(value.usage));
        events.push({
          type: "done",
          ...(asString(value.stopReason)
            ? { finishReason: asString(value.stopReason)! }
            : {}),
          ...(usage ? { usage } : {}),
        });
        return events;
      }
      default:
        // `available_commands` banners and per-request `usage` frames carry
        // nothing the chat pane renders; the `end` usage is cumulative.
        return [];
    }
  }

  end(code: number | null, stderr: string): AgentStreamEvent[] {
    // A run killed mid-stream still settles its partial buffers first.
    return [...this.flushAll(), ...endOfRunEvents(this.done, code, stderr)];
  }

  // Close the open assistant message, making the accumulated deltas official.
  private flushText(): AgentStreamEvent[] {
    if (!this.textBuf) return [];
    const text = this.textBuf;
    this.textBuf = "";
    return [
      {
        type: "message-complete",
        messageId: `msg-${this.textSeq}`,
        message: { role: "assistant", content: text },
      },
    ];
  }

  private flushThinking(): AgentStreamEvent[] {
    if (!this.thinkingBuf) return [];
    const text = this.thinkingBuf;
    this.thinkingBuf = "";
    return [
      { type: "thinking-complete", messageId: `thinking-${this.thinkingSeq}`, text },
    ];
  }

  private flushAll(): AgentStreamEvent[] {
    return [...this.flushThinking(), ...this.flushText()];
  }

  private toolStarted(value: Json): AgentStreamEvent[] {
    const callId = asString(value.toolCallId);
    if (!callId) return [];
    const tool =
      asString(value.toolName) ?? asString(value.title) ?? asString(value.kind) ?? "tool";
    const args = asRecord(value.rawInput) ?? {};
    this.startedTools.add(callId);
    const events: AgentStreamEvent[] = [];
    // todo_write is Grok Build's plan surface; render it as a plan block too.
    const plan = todoPlan(tool, args);
    if (plan) events.push(plan);
    events.push({ type: "tool-call-started", callId, call: { tool, args } });
    return events;
  }

  private toolUpdated(value: Json): AgentStreamEvent[] {
    const callId = asString(value.toolCallId);
    const status = asString(value.status);
    // Intermediate updates (null / in_progress) refine a running card; only a
    // terminal status closes it.
    if (!callId || (status !== "completed" && status !== "failed")) return [];
    const events: AgentStreamEvent[] = [];
    if (!this.startedTools.has(callId)) {
      this.startedTools.add(callId);
      events.push({ type: "tool-call-started", callId, call: { tool: "tool", args: {} } });
    }
    events.push({ type: "tool-call-completed", callId, outcome: outcomeOf(value, status) });
    return events;
  }
}

// Flatten a tool update's `content` parts ({type:"content",content:{text}}).
function updateText(value: Json): string {
  const parts = Array.isArray(value.content) ? value.content : [];
  return parts
    .map((part) => asString(asRecord(asRecord(part)?.content)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

// A failing command still arrives with status "completed" — the failure lives
// in rawOutput.exit_code, so check both.
function outcomeOf(
  value: Json,
  status: string,
): { status: "executed" | "error"; result: string } {
  const rawOutput = asRecord(value.rawOutput);
  const exitCode =
    typeof rawOutput?.exit_code === "number" ? rawOutput.exit_code : null;
  const failed = status === "failed" || (exitCode !== null && exitCode !== 0);
  const detail = clampToolResult(updateText(value));
  return failed
    ? { status: "error", result: detail || `exited with status ${exitCode ?? "unknown"}` }
    : { status: "executed", result: detail };
}

// Map a todo_write call's `todos` onto the neutral plan shape. Merge updates
// may carry only {id, status}; entries without text can't render and are
// skipped rather than guessed at.
function todoPlan(tool: string, input: Json): AgentStreamEvent | null {
  if (tool !== "todo_write" || !Array.isArray(input.todos)) return null;
  const items = input.todos
    .map((entry) => {
      const todo = asRecord(entry);
      const text = asString(todo?.content) ?? "";
      if (!text) return null;
      const status = asString(todo?.status);
      return {
        text,
        status:
          status === "completed"
            ? ("completed" as const)
            : status === "in_progress"
              ? ("in-progress" as const)
              : ("pending" as const),
      };
    })
    .filter((item): item is AgentPlanItem => !!item);
  return items.length > 0 ? { type: "plan", items } : null;
}

function usageOf(usage: Json | null) {
  if (!usage) return null;
  const promptTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const completionTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

export function createGrokAdapter(
  provider: Provider,
  stream: ProviderStream,
): AgentStreamAdapter {
  return {
    id: provider.id,
    spawn: (request: AgentRunRequest): AgentSpawn =>
      buildAgentSpawn(provider, stream, request),
    createParser: () => new GrokParser(),
  };
}
