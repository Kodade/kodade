// KödChat's stream-adapter seam. One adapter per agent CLI dialect turns that
// CLI's structured stdout into the provider-neutral chat vocabulary
// (ChatMessage / ToolCall / ToolOutcome / TokenUsage), so the
// pane, the store, and the transcript format never learn a vendor's JSON.
//
// Deliberately SEPARATE from HarnessAdapter (src/harness): that contract is
// about managing a CLI's config files; this one is about reading its live
// output. The only thing they share is the discipline — a thin per-CLI dialect
// map over one shared engine, with bin/args knowledge kept in
// providers/catalog.ts rather than baked into an adapter.

import type { ChatAccessLevel, ChatSpeed } from "../providers/catalog";
import type { ChatMessage, TokenUsage } from "../inference/backend";
import type { ToolCall } from "../local/toolcall";
import type { ToolOutcome } from "../local/tools";
import type { ClaudePermissionRequest } from "./claude-input";

// One step of an agent's plan/todo list, when the dialect exposes one.
export type AgentPlanItem = {
  text: string;
  status: "pending" | "in-progress" | "completed";
};

// The normalized event union every adapter emits. Anything a dialect reports
// that doesn't map here is dropped rather than guessed at — a chat surface that
// invents structure is worse than one that shows less.
export type AgentStreamEvent =
  // The CLI's own resumable conversation id, captured so the NEXT turn can
  // resume this thread instead of starting cold.
  | { type: "session"; sessionId: string }
  // Streaming assistant text. `messageId` groups deltas belonging to one
  // assistant message so a multi-message turn renders as separate bubbles.
  | { type: "message-delta"; messageId: string; text: string }
  // The authoritative full message. Replaces whatever the deltas accumulated,
  // which is what makes a dialect with no deltas at all (codex) work unchanged.
  | { type: "message-complete"; messageId: string; message: ChatMessage }
  | { type: "thinking-delta"; messageId: string; text: string }
  | { type: "thinking-complete"; messageId: string; text: string }
  | { type: "plan"; items: AgentPlanItem[] }
  | { type: "tool-call-started"; callId: string; call: ToolCall }
  | { type: "tool-call-completed"; callId: string; outcome: ToolOutcome }
  | { type: "permission-request"; request: ClaudePermissionRequest }
  | { type: "tool-denied"; tool: string; detail: string | null }
  // The CLI could not authenticate. The pane offers a login terminal rather
  // than a retry — Kodade never proxies a provider's credentials.
  | { type: "auth-error"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; finishReason?: string; usage?: TokenUsage };

// What one chat turn needs in order to spawn.
export type AgentRunRequest = {
  prompt: string;
  cwd: string; // project root the agent runs in
  // The CLI's own session id from a previous turn on this thread, or null for
  // the first turn. Threads only stay coherent because this round-trips.
  resumeId?: string | null;
  model?: string | null;
  // The user's per-thread permission posture; omitted means the default level.
  access?: ChatAccessLevel | null;
  // Thinking level id (catalog thinkingLevels); null/omitted runs the CLI's
  // default effort.
  thinking?: string | null;
  // Per-thread speed choice. Unsupported providers ignore non-default values.
  speed?: ChatSpeed | null;
  interactive?: boolean;
};

// The argv handed to `agent_start`. Rust resolves `bin` through the login shell
// and forwards `args` untouched; `stdin` is written and closed.
export type AgentSpawn = {
  bin: string;
  args: string[];
  stdin?: string;
  // First framed message for a stream-input run. The process is started with
  // stdin open, then the caller sends this through AgentIpc.send.
  initialInput?: string;
};

// A stateful parser for ONE run. Dialects that stream partial content need to
// remember block indices and open tool calls across lines, so this is created
// per run rather than being a pure function.
export interface AgentStreamParser {
  // Parse one raw stdout line into zero or more normalized events.
  line(raw: string): AgentStreamEvent[];
  // The process exited. Adapters use this to turn a non-zero exit (or stderr
  // that reads like an auth failure) into a terminal event, and to guarantee
  // exactly one `done` per run even when the CLI died mid-stream.
  end(code: number | null, stderr: string): AgentStreamEvent[];
}

export interface AgentStreamAdapter {
  readonly id: string; // provider id from the catalog
  spawn(request: AgentRunRequest): AgentSpawn;
  createParser(): AgentStreamParser;
}
