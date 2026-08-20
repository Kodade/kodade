// The Ködade background prompt (issue #63): a short, token-lean note every
// agent Ködade launches receives at spawn time.
//
// It is deliberately NOT written to CLAUDE.md/AGENTS.md or any other on-disk
// instruction file. Those files belong to the user's project and would follow
// the same CLIs into a plain terminal session, where none of this is true.
// Injection happens only in the spawn path (agents/engine.ts), so the note
// reaches Ködade-spawned sessions and nothing else.

// The canonical text. Single source of truth — the settings textarea shows
// this verbatim when the user has no override.
export const DEFAULT_AMBIENT_PROMPT =
  "You are running inside Ködade, a native agentic development environment " +
  "for vibe coding and agentic engineering. Your output renders in Ködade's " +
  "chat and terminal panes. Be concise and token-lean: answer directly, skip " +
  "preamble and restated context. Project instruction files and the user's " +
  "own guidance always take precedence over this note.";

// A hand-edited override is a system prompt for every run, so it is capped
// like any other persisted free-text field. Long enough for a real house
// style, short enough that it can't quietly eat a context window.
export const MAX_AMBIENT_PROMPT_LENGTH = 4_000;

// The prompt actually sent: the user's override when they wrote one, the
// default otherwise. Empty or whitespace-only overrides mean "no override",
// not "no prompt" — opting out entirely is the separate enabled flag.
export function ambientPrompt(override?: string | null): string {
  const trimmed = override?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : DEFAULT_AMBIENT_PROMPT;
}

// What the spawn path consumes: the effective prompt, or null when the user
// switched the background prompt off (spawn is then byte-identical to a build
// without this feature).
export function ambientPromptFor(
  enabled: boolean,
  override?: string | null,
): string | null {
  return enabled ? ambientPrompt(override) : null;
}

// Normalize an override for persistence: trimmed and capped, or null when it
// carries nothing (so the document stays absent-means-default).
export function normalizeAmbientOverride(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_AMBIENT_PROMPT_LENGTH);
}
