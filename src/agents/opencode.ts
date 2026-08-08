// OpenCode `run --format json` dialect.
//
// OpenCode 1.18.5 emits completed parts rather than token fragments: `text`,
// `reasoning`, `tool_use`, and `step_finish` frames, all carrying `sessionID`.
// The CLI itself owns permission policy and sessions; this adapter only maps
// its documented JSON output into KödChat's neutral event vocabulary.

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
  failureEvent,
  parseJsonLine,
} from "./engine";

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorText(value: unknown): string {
  const error = record(value);
  const data = record(error?.data);
  return text(data?.message) ?? text(error?.message) ?? text(error?.name) ?? "OpenCode failed";
}

class OpenCodeParser implements AgentStreamParser {
  private done = false;
  private failed = false;
  private sessionId: string | null = null;
  private textSeq = 0;
  private reasoningSeq = 0;
  private usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;

  line(raw: string): AgentStreamEvent[] {
    const value = parseJsonLine(raw);
    if (!value) return [];
    const events: AgentStreamEvent[] = [];
    const sessionId = text(value.sessionID);
    if (sessionId && sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      events.push({ type: "session", sessionId });
    }

    switch (value.type) {
      case "text": {
        const part = record(value.part);
        const content = text(part?.text);
        if (!content) return events;
        this.textSeq += 1;
        events.push({
          type: "message-complete",
          messageId: text(part?.id) ?? `opencode-text-${this.textSeq}`,
          message: { role: "assistant", content },
        });
        return events;
      }
      case "reasoning": {
        const part = record(value.part);
        const content = text(part?.text);
        if (!content) return events;
        this.reasoningSeq += 1;
        events.push({
          type: "thinking-complete",
          messageId: text(part?.id) ?? `opencode-reasoning-${this.reasoningSeq}`,
          text: content,
        });
        return events;
      }
      case "tool_use":
        return [...events, ...this.toolEvents(record(value.part))];
      case "step_finish": {
        const next = usageOf(record(value.part));
        if (next) this.usage = next;
        return events;
      }
      case "error":
        this.failed = true;
        return [...events, failureEvent(errorText(value.error))];
      default:
        return events;
    }
  }

  end(code: number | null, stderr: string): AgentStreamEvent[] {
    if (this.done) return [];
    this.done = true;
    if (this.failed) return [{ type: "done", ...(this.usage ? { usage: this.usage } : {}) }];
    const ending = endOfRunEvents(false, code, stderr);
    if (ending.length === 1 && ending[0]?.type === "done" && this.usage) {
      return [{ type: "done", usage: this.usage }];
    }
    return ending;
  }

  private toolEvents(part: Json | null): AgentStreamEvent[] {
    if (!part) return [];
    const callId = text(part.callID) ?? text(part.id);
    if (!callId) return [];
    const tool = text(part.tool) ?? "tool";
    const state = record(part.state);
    const input = record(state?.input) ?? {};
    const output = text(state?.output) ?? text(state?.error) ?? "";
    const failed = text(state?.status) === "error";
    const events: AgentStreamEvent[] = [];
    const plan = todoPlan(tool, input);
    if (plan) events.push(plan);
    events.push({ type: "tool-call-started", callId, call: { tool, args: input } });
    events.push({
      type: "tool-call-completed",
      callId,
      outcome: { status: failed ? "error" : "executed", result: clampToolResult(output) },
    });
    return events;
  }
}

function usageOf(part: Json | null) {
  const tokens = record(part?.tokens);
  if (!tokens) return null;
  const promptTokens = number(tokens.input) ?? number(tokens.input_tokens) ?? 0;
  const completionTokens = number(tokens.output) ?? number(tokens.output_tokens) ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function todoPlan(tool: string, input: Json): AgentStreamEvent | null {
  if (!/(?:todo|plan)/i.test(tool) || !Array.isArray(input.todos)) return null;
  const items = input.todos
    .map((value) => {
      const todo = record(value);
      const itemText = text(todo?.content) ?? text(todo?.text);
      if (!itemText) return null;
      const status = text(todo?.status);
      return {
        text: itemText,
        status:
          status === "completed"
            ? ("completed" as const)
            : status === "in_progress" || status === "in-progress"
              ? ("in-progress" as const)
              : ("pending" as const),
      };
    })
    .filter((item): item is AgentPlanItem => item !== null);
  return items.length ? { type: "plan", items } : null;
}

export function createOpenCodeAdapter(
  provider: Provider,
  stream: ProviderStream,
): AgentStreamAdapter {
  return {
    id: provider.id,
    spawn: (request: AgentRunRequest): AgentSpawn => buildAgentSpawn(provider, stream, request),
    createParser: () => new OpenCodeParser(),
  };
}
