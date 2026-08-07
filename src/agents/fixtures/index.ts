// NDJSON captured from real runs of the shipped CLIs, loaded as raw text so the
// dialect tests parse exactly the bytes those CLIs printed. Machine-specific
// noise (tool inventories, MCP server lists, local paths in banner frames) was
// stripped; every event shape is untouched.

import claudeToolTurn from "./claude-tool-turn.jsonl?raw";
import codexToolTurn from "./codex-tool-turn.jsonl?raw";
import grokToolTurn from "./grok-tool-turn.jsonl?raw";

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

// Claude Code: one turn that thinks, calls Read, then answers.
export const CLAUDE_TOOL_TURN = lines(claudeToolTurn);
// Codex: the same turn, in its flat item dialect.
export const CODEX_TOOL_TURN = lines(codexToolTurn);
// Grok Build: one turn that thinks, calls read_file, then answers.
export const GROK_TOOL_TURN = lines(grokToolTurn);
