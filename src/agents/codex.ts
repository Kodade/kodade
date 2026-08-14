// Codex dialect (`codex exec --json`).
//
// A flat item stream rather than a token stream: `thread.started` names the
// resumable thread, `turn.started`/`turn.completed` bracket the turn, and every
// piece of work is an `item` that appears (optionally) as `item.started` and
// then as `item.completed`. There are no text deltas, so assistant messages
// land whole — which the normalized union already allows, since
// `message-complete` is the authoritative event and deltas are an optimization.
//
// Verified against the shipped CLI (see src/agents/fixtures/codex-tool-turn.jsonl,
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
  endOfRunEvents,
  failureEvent,
  parseJsonLine,
} from "./engine";
import {
  asRecord,
  asString,
  planEvent,
  tokenUsageFromRecord,
  type Json,
} from "./normalize";

// Item types that represent work with a result, i.e. a tool card.
const TOOL_ITEMS = new Set([
  "command_execution",
  "mcp_tool_call",
  "file_change",
  "patch_apply",
  "web_search",
]);

class CodexParser implements AgentStreamParser {
  private done = false;
  // Item ids already reported as started, so `item.completed` for a tool that
  // never emitted `item.started` still produces a complete card.
  private startedTools = new Set<string>();
  // Codex reports ordinary config warnings ("under-development features
  // enabled", "skill descriptions were shortened") as items of type `error`,
  // and then completes the turn normally. Surfacing those as failures would
  // leave every thread on such a machine permanently flagged "needs you", so
  // they are held back: if the turn completes, they were warnings and are
  // dropped; if it fails, they are the diagnosis and get flushed.
  private pendingErrors: string[] = [];

  line(raw: string): AgentStreamEvent[] {
    const value = parseJsonLine(raw);
    if (!value) return [];
    switch (value.type) {
      case "thread.started": {
        const sessionId = asString(value.thread_id);
        return sessionId ? [{ type: "session", sessionId }] : [];
      }
      case "item.started":
        return this.item(value, false);
      case "item.updated":
        return [];
      case "item.completed":
        return this.item(value, true);
      case "turn.completed": {
        this.done = true;
        // The turn produced an answer, so anything it reported along the way
        // was a warning, not a failure.
        this.pendingErrors = [];
        const usage = tokenUsageFromRecord(value.usage);
        return [{ type: "done", ...(usage ? { usage } : {}) }];
      }
      case "turn.failed": {
        this.done = true;
        const error = asRecord(value.error);
        const message =
          asString(error?.message) ?? asString(value.message) ?? "the turn failed";
        return [...this.flushErrors(), failureEvent(message), { type: "done" }];
      }
      default:
        return [];
    }
  }

  end(code: number | null, stderr: string): AgentStreamEvent[] {
    // A run that died without a terminal frame never proved its held-back
    // messages were harmless, so they are shown alongside the exit failure.
    const held = this.done ? [] : this.flushErrors();
    return [...held, ...endOfRunEvents(this.done, code, stderr)];
  }

  private flushErrors(): AgentStreamEvent[] {
    const events = this.pendingErrors.map((message) => failureEvent(message));
    this.pendingErrors = [];
    return events;
  }

  private item(value: Json, completed: boolean): AgentStreamEvent[] {
    const item = asRecord(value.item);
    if (!item) return [];
    const id = asString(item.id) ?? "";
    const kind = asString(item.type) ?? "";

    if (kind === "agent_message") {
      // Only the completed form carries the final text.
      if (!completed) return [];
      const text = asString(item.text) ?? "";
      return text
        ? [
            {
              type: "message-complete",
              messageId: id || "agent_message",
              message: { role: "assistant", content: text },
            },
          ]
        : [];
    }

    if (kind === "reasoning") {
      if (!completed) return [];
      const text = asString(item.text) ?? asString(item.summary) ?? "";
      return text ? [{ type: "thinking-complete", messageId: id, text }] : [];
    }

    if (kind === "todo_list") {
      const entries = Array.isArray(item.items) ? item.items : item.todos;
      const plan = planEvent(entries, ["text", "content"]);
      return plan ? [plan] : [];
    }

    if (kind === "error") {
      if (completed) {
        this.pendingErrors.push(
          asString(item.message) ?? "the agent reported an error",
        );
      }
      return [];
    }

    if (!TOOL_ITEMS.has(kind)) return [];

    const events: AgentStreamEvent[] = [];
    const callId = id || `${kind}-${this.startedTools.size}`;
    if (!this.startedTools.has(callId)) {
      this.startedTools.add(callId);
      events.push({ type: "tool-call-started", callId, call: toolCall(kind, item) });
    }
    if (completed) {
      events.push({ type: "tool-call-completed", callId, outcome: outcomeOf(item) });
    }
    return events;
  }
}

// Codex items name their payload per type; normalize to {tool, args}.
function toolCall(kind: string, item: Json): { tool: string; args: Json } {
  if (kind === "command_execution") {
    return { tool: "shell", args: { command: asString(item.command) ?? "" } };
  }
  if (kind === "mcp_tool_call") {
    return {
      tool: asString(item.tool) ?? asString(item.name) ?? "mcp",
      args: {
        ...(asString(item.server) ? { server: asString(item.server)! } : {}),
        ...(asRecord(item.arguments) ?? {}),
      },
    };
  }
  if (kind === "file_change" || kind === "patch_apply") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return {
      tool: "edit",
      args: {
        files: changes
          .map((change) => asString(asRecord(change)?.path))
          .filter((path): path is string => !!path),
      },
    };
  }
  if (kind === "web_search") {
    return { tool: "web_search", args: { query: asString(item.query) ?? "" } };
  }
  return { tool: kind, args: {} };
}

function outcomeOf(item: Json): { status: "executed" | "error"; result: string } {
  const output =
    asString(item.aggregated_output) ??
    asString(item.output) ??
    asString(item.result) ??
    "";
  const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
  const failed = item.status === "failed" || (exitCode !== null && exitCode !== 0);
  const detail = clampToolResult(output);
  return failed
    ? { status: "error", result: detail || `exited with status ${exitCode ?? "unknown"}` }
    : { status: "executed", result: detail };
}

export function createCodexAdapter(
  provider: Provider,
  stream: ProviderStream,
): AgentStreamAdapter {
  return {
    id: provider.id,
    spawn: (request: AgentRunRequest): AgentSpawn =>
      buildAgentSpawn(provider, stream, request),
    createParser: () => new CodexParser(),
  };
}
