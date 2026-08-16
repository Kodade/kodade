// NDJSON captured from real runs of the shipped CLIs, loaded as raw text so the
// dialect tests parse exactly the bytes those CLIs printed. Machine-specific
// noise (tool inventories, MCP server lists, local paths in banner frames) was
// stripped; every event shape is untouched.

import claudeToolTurn from "./claude-tool-turn.jsonl?raw";
import codexCollaborationTurn from "./codex-collaboration-turn.jsonl?raw";
import codexToolTurn from "./codex-tool-turn.jsonl?raw";
import grokToolTurn from "./grok-tool-turn.jsonl?raw";
import openCodeToolTurn from "./opencode-tool-turn.jsonl?raw";

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

// Claude Code: one turn that thinks, calls Read, then answers.
export const CLAUDE_TOOL_TURN = lines(claudeToolTurn);
// Codex: the same turn, in its flat item dialect.
export const CODEX_TOOL_TURN = lines(codexToolTurn);
// Codex 0.147.0: collaboration tools are flat stream items just like shell
// commands, so KödChat renders them through the same durable tool-card seam.
export const CODEX_COLLABORATION_TURN = lines(codexCollaborationTurn);
// Grok Build: one turn that thinks, calls read_file, then answers.
export const GROK_TOOL_TURN = lines(grokToolTurn);
// OpenCode 1.18.15 `run --format json`: sanitized multi-step part events plus
// a captured unauthenticated error (no local paths or credentials).
export const OPENCODE_TOOL_TURN = lines(openCodeToolTurn);
