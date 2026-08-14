// OpenCode `run --format json` dialect.
//
// OpenCode 1.18.15 emits completed parts rather than token fragments: `text`,
// `reasoning`, `tool_use`, and `step_finish` frames, all carrying `sessionID`.
// The CLI itself owns permission policy and sessions; this adapter only maps
// its documented JSON output into KödChat's neutral event vocabulary.

import type { Provider, ProviderStream } from "../providers/catalog";
import type {
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
import {
  asNumber,
  asRecord,
  asString,
  planEvent,
  tokenUsage,
  type Json,
} from "./normalize";

function errorText(value: unknown): string {
  const error = asRecord(value);
  const data = asRecord(error?.data);
  return asString(data?.message) ?? asString(error?.message) ?? asString(error?.name) ?? "OpenCode failed";
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
    const sessionId = asString(value.sessionID);
    if (sessionId && sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      events.push({ type: "session", sessionId });
    }

    switch (value.type) {
      case "text": {
        const part = asRecord(value.part);
        const content = asString(part?.text);
        if (!content) return events;
        this.textSeq += 1;
        events.push({
          type: "message-complete",
          messageId: asString(part?.id) ?? `opencode-text-${this.textSeq}`,
          message: { role: "assistant", content },
        });
        return events;
      }
      case "reasoning": {
        const part = asRecord(value.part);
        const content = asString(part?.text);
        if (!content) return events;
        this.reasoningSeq += 1;
        events.push({
          type: "thinking-complete",
          messageId: asString(part?.id) ?? `opencode-reasoning-${this.reasoningSeq}`,
          text: content,
        });
        return events;
      }
      case "tool_use":
        return [...events, ...this.toolEvents(asRecord(value.part))];
      case "step_finish": {
        const next = usageOf(asRecord(value.part));
        if (next) {
          this.usage = this.usage
            ? {
                promptTokens: this.usage.promptTokens + next.promptTokens,
                completionTokens:
                  this.usage.completionTokens + next.completionTokens,
                totalTokens: this.usage.totalTokens + next.totalTokens,
              }
            : next;
        }
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
    const callId = asString(part.callID) ?? asString(part.id);
    if (!callId) return [];
    const tool = asString(part.tool) ?? "tool";
    const state = asRecord(part.state);
    const input = asRecord(state?.input) ?? {};
    const output = asString(state?.output) ?? asString(state?.error) ?? "";
    const failed = asString(state?.status) === "error";
    const events: AgentStreamEvent[] = [];
    const plan =
      /(?:todo|plan)/i.test(tool)
        ? planEvent(input.todos, ["content", "text"])
        : null;
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
  const tokens = asRecord(part?.tokens);
  if (!tokens) return null;
  const promptTokens =
    asNumber(tokens.input) ?? asNumber(tokens.input_tokens);
  const completionTokens =
    asNumber(tokens.output) ?? asNumber(tokens.output_tokens);
  return tokenUsage(promptTokens, completionTokens, tokens.total);
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
