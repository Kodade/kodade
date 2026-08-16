// Claude Code dialect (`claude -p --output-format stream-json`).
//
// The stream carries two overlapping layers: raw Anthropic API `stream_event`
// frames (token deltas) and Claude Code's own assembled `assistant`/`user`
// envelopes. We stream from the first and take truth from the second — the
// assembled `assistant` message is the only place a tool call's arguments
// arrive as parsed JSON rather than as `input_json_delta` fragments, and the
// `user` envelope is where tool results come back.
//
// Verified against the shipped CLI (see src/agents/fixtures/claude-tool-turn.jsonl,
// captured from a real run). Flags live in providers/catalog.ts, not here.

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
  contentToText,
  endOfRunEvents,
  failureEvent,
  parseJsonLine,
} from "./engine";
import {
  asRecord,
  asString,
  planEvent,
  type Json,
} from "./normalize";
import type { ClaudePermissionRequest } from "./claude-input";

class ClaudeParser implements AgentStreamParser {
  private messageId = "";
  private deferredFailure: AgentStreamEvent | null = null;
  // Content-block index → what kind of block it is, so a delta can be routed
  // without re-reading the block's start frame.
  private blocks = new Map<number, "text" | "thinking" | "tool_use">();

  seedMessageId(messageId: string) {
    this.messageId = messageId;
  }

  line(raw: string): AgentStreamEvent[] {
    const value = parseJsonLine(raw);
    if (!value) return [];
    switch (value.type) {
      case "system":
        return this.system(value);
      case "stream_event":
        return this.streamEvent(value);
      case "assistant":
        return this.assistant(value);
      case "user":
        return this.user(value);
      case "result":
        return this.result(value);
      case "control_request":
        return this.controlRequest(value);
      default:
        return [];
    }
  }

  private controlRequest(value: Json): AgentStreamEvent[] {
    const request = asRecord(value.request);
    const requestId = asString(value.request_id);
    if (!request || request.subtype !== "can_use_tool" || !requestId) return [];
    const tool = asString(request.tool_name);
    const input = asRecord(request.input);
    if (!tool || !input) return [];
    const permission: ClaudePermissionRequest = {
      requestId,
      tool,
      input,
      toolUseId: asString(request.tool_use_id),
      title: asString(request.title),
      description: asString(request.description),
      blockedPath: asString(request.blocked_path),
      suggestions: Array.isArray(request.permission_suggestions)
        ? request.permission_suggestions.flatMap((entry) => {
            const value = asRecord(entry);
            return value ? [value] : [];
          })
        : [],
    };
    return [{ type: "permission-request", request: permission }];
  }

  end(code: number | null, stderr: string): AgentStreamEvent[] {
    return [
      ...(this.deferredFailure ? [this.deferredFailure] : []),
      ...endOfRunEvents(false, code, stderr),
    ];
  }

  // `system/init` announces the session id that `--resume` needs next turn.
  private system(value: Json): AgentStreamEvent[] {
    if (value.subtype !== "init") return [];
    const sessionId = asString(value.session_id);
    return sessionId ? [{ type: "session", sessionId }] : [];
  }

  private streamEvent(value: Json): AgentStreamEvent[] {
    const event = asRecord(value.event);
    if (!event) return [];
    if (event.type === "message_start") {
      const message = asRecord(event.message);
      this.messageId = asString(message?.id) ?? this.messageId;
      this.blocks.clear();
      return [];
    }
    if (event.type === "content_block_start") {
      const index = typeof event.index === "number" ? event.index : -1;
      const block = asRecord(event.content_block);
      const kind = asString(block?.type);
      if (index >= 0 && (kind === "text" || kind === "thinking" || kind === "tool_use")) {
        this.blocks.set(index, kind);
      }
      return [];
    }
    if (event.type === "content_block_delta") {
      const index = typeof event.index === "number" ? event.index : -1;
      const delta = asRecord(event.delta);
      const text = asString(delta?.text);
      const thinking = asString(delta?.thinking);
      if (delta?.type === "text_delta" && text) {
        return [{ type: "message-delta", messageId: this.messageId, text }];
      }
      if (delta?.type === "thinking_delta" && thinking) {
        return [{ type: "thinking-delta", messageId: this.messageId, text: thinking }];
      }
      // input_json_delta fragments are intentionally ignored: the assembled
      // `assistant` envelope carries the same arguments already parsed.
      void index;
      return [];
    }
    return [];
  }

  // The assembled assistant message: the authoritative text, thinking, and
  // tool calls for the turn so far.
  private assistant(value: Json): AgentStreamEvent[] {
    const message = asRecord(value.message);
    if (!message) return [];
    const messageId = asString(message.id) ?? this.messageId;
    const content = Array.isArray(message.content) ? message.content : [];
    const events: AgentStreamEvent[] = [];
    for (const part of content) {
      const block = asRecord(part);
      if (!block) continue;
      if (block.type === "text") {
        const text = asString(block.text) ?? "";
        if (text) {
          events.push({
            type: "message-complete",
            messageId,
            message: { role: "assistant", content: text },
          });
        }
        continue;
      }
      if (block.type === "thinking") {
        const text = asString(block.thinking) ?? "";
        if (text) events.push({ type: "thinking-complete", messageId, text });
        continue;
      }
      if (block.type === "tool_use") {
        const callId = asString(block.id);
        const tool = asString(block.name);
        if (!callId || !tool) continue;
        const input = asRecord(block.input) ?? {};
        // TodoWrite is Claude Code's plan surface; render it as a plan block
        // rather than as one more opaque tool card.
        const plan =
          tool === "TodoWrite"
            ? planEvent(input.todos, ["content", "activeForm"])
            : null;
        if (plan) events.push(plan);
        events.push({ type: "tool-call-started", callId, call: { tool, args: input } });
      }
    }
    return events;
  }

  // Tool results come back as a synthetic `user` message.
  private user(value: Json): AgentStreamEvent[] {
    const message = asRecord(value.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const events: AgentStreamEvent[] = [];
    for (const part of content) {
      const block = asRecord(part);
      if (!block || block.type !== "tool_result") continue;
      const callId = asString(block.tool_use_id);
      if (!callId) continue;
      const result = clampToolResult(contentToText(block.content));
      events.push({
        type: "tool-call-completed",
        callId,
        outcome:
          block.is_error === true
            ? { status: "error", result }
            : { status: "executed", result },
      });
    }
    return events;
  }

  // Claude can report a `result` before its process has retired (notably while
  // delegated work is still active). It is provider output, not process exit;
  // native exit remains the only terminal signal for KödChat ownership.
  private result(value: Json): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    const sessionId = asString(value.session_id);
    if (sessionId) events.push({ type: "session", sessionId });
    if (Array.isArray(value.permission_denials)) {
      for (const raw of value.permission_denials) {
        const denial = asRecord(raw);
        if (!denial) continue;
        const tool = asString(denial.tool_name) ?? asString(denial.name) ?? "Tool";
        const input = asRecord(denial.tool_input) ?? asRecord(denial.input);
        const detail = input
          ? asString(input.command) ?? asString(input.path) ?? null
          : null;
        events.push({ type: "tool-denied", tool, detail });
      }
    }
    if (value.is_error === true) {
      const message =
        asString(value.result) ?? asString(value.subtype) ?? "the agent reported an error";
      this.deferredFailure = failureEvent(message);
    }
    return events;
  }
}

export function createClaudeAdapter(
  provider: Provider,
  stream: ProviderStream,
): AgentStreamAdapter {
  return {
    id: provider.id,
    spawn: (request: AgentRunRequest): AgentSpawn =>
      buildAgentSpawn(provider, stream, request),
    createParser: () => new ClaudeParser(),
  };
}
