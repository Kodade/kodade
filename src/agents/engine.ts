// Shared machinery every stream adapter reuses, so each dialect file stays a
// thin map from "what this CLI prints" to the normalized event union.

import {
  DEFAULT_ACCESS_LEVEL,
  thinkingLevelsFor,
  type Provider,
  type ProviderStream,
} from "../providers/catalog";
import type { AgentRunRequest, AgentSpawn, AgentStreamEvent } from "./contract";
import { encodeClaudeUserMessage } from "./claude-input";

// Substituted into a provider's `stream` argv templates at spawn time.
const SESSION_TOKEN = "{session}";
const MODEL_TOKEN = "{model}";
const LEVEL_TOKEN = "{level}";
const PROMPT_TOKEN = "{prompt}";

// Delimiters for the stdin fallback (opencode). Explicit tags keep the note
// tellable apart from the user's own words by both the model and anyone
// reading a transcript.
const AMBIENT_OPEN = "<kodade-harness>";
const AMBIENT_CLOSE = "</kodade-harness>";

// Substitute a token with a value that is USER TEXT. String.replace expands
// `$&`, "$`" and friends in the replacement, so every substitution goes through
// a function replacer — otherwise a prompt containing `$&` is silently
// corrupted before it reaches the CLI.
function fill(arg: string, token: string, value: string): string {
  return arg.replace(token, () => value);
}

// Encode a value as a TOML basic string, for CLIs that parse a config
// override's value as TOML (codex `-c key=value`). Control characters are
// illegal inside a TOML basic string, so they are escaped too: an unescaped
// one would make the value fail to parse and fall back to a raw literal,
// which is exactly the ambiguity the quoting exists to remove.
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // \n, \r and \t are handled above; every other C0 control character
    // (plus DEL) becomes a \uXXXX escape.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (char) =>
      `\\u${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`,
    );
  return `"${escaped}"`;
}

// The background prompt for THIS spawn, or null when there is nothing to send.
function ambientFor(request: AgentRunRequest): string | null {
  const trimmed = request.ambient?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

// Prepend the note to a first-turn prompt. Resumed turns already carry it in
// the CLI's own session history, so repeating it would only cost tokens.
export function promptWithAmbient(
  stream: ProviderStream,
  request: AgentRunRequest,
): string {
  const ambient = ambientFor(request);
  if (
    ambient === null ||
    stream.systemPrompt?.via !== "stdin-preamble" ||
    request.resumeId
  ) {
    return request.prompt;
  }
  return `${AMBIENT_OPEN}\n${ambient}\n${AMBIENT_CLOSE}\n\n${request.prompt}`;
}

// Build one run's argv from the catalog's `stream` block. Order is load-bearing
// for subcommand CLIs: base options first, then the model, then the resume
// subcommand — `codex exec --json --model X resume <id> -` parses, while the
// same flags after `resume` do not.
export function buildAgentArgs(
  stream: ProviderStream,
  request: AgentRunRequest,
): string[] {
  // Access flags are exec options too, so they sit with the base args ahead
  // of any resume subcommand.
  const args = [...stream.args, ...stream.accessArgs[request.access ?? DEFAULT_ACCESS_LEVEL]];
  if (request.model && stream.modelArgs) {
    args.push(...stream.modelArgs.map((arg) => fill(arg, MODEL_TOKEN, request.model!)));
  }
  // Thinking args are exec options too, so they must precede resumeArgs. A
  // level the current model doesn't offer (stale after a model switch, or a
  // hand-edited document) is dropped rather than handed to a CLI that would
  // reject the whole run.
  if (
    request.thinking &&
    stream.thinkingArgs &&
    thinkingLevelsFor(stream, request.model ?? null).some(
      (level) => level.id === request.thinking,
    )
  ) {
    args.push(
      ...stream.thinkingArgs.map((arg) => fill(arg, LEVEL_TOKEN, request.thinking!)),
    );
  }
  const speedArgs = request.speed ? stream.speedArgs?.[request.speed] : undefined;
  if (speedArgs) args.push(...speedArgs);
  // Ködade's background prompt. Also an exec option, so it precedes any resume
  // subcommand; it is passed on every spawn because each turn is a new process
  // that rebuilds its system prompt from argv.
  const ambient = ambientFor(request);
  if (ambient && stream.systemPrompt?.via === "args") {
    const value =
      stream.systemPrompt.encode === "toml-string" ? tomlString(ambient) : ambient;
    args.push(...stream.systemPrompt.args.map((arg) => fill(arg, PROMPT_TOKEN, value)));
  }
  if (request.resumeId && stream.resumeArgs) {
    args.push(
      ...stream.resumeArgs.map((arg) => fill(arg, SESSION_TOKEN, request.resumeId!)),
    );
  }
  if (request.interactive && stream.input) args.push(...stream.input.args);
  return args;
}

// The spawn every shipped dialect uses: catalog argv, prompt over stdin. Piping
// the USER's prompt keeps argv free of their text entirely — no quoting, no
// length limit, and no chance of a prompt being read as a flag. The one thing
// that does travel in argv is Ködade's own background prompt, which the CLIs
// only accept as a flag; those templates use the single-token `--flag=value`
// form so text starting with `-` can never be parsed as an option.
export function buildAgentSpawn(
  provider: Provider,
  stream: ProviderStream,
  request: AgentRunRequest,
): AgentSpawn {
  const interactive = request.interactive === true && stream.input !== undefined;
  const prompt = promptWithAmbient(stream, request);
  return {
    bin: provider.bin,
    args: buildAgentArgs(stream, request),
    ...(interactive
      ? { initialInput: encodeClaudeUserMessage(prompt) }
      : { stdin: prompt }),
  };
}

// Parse one NDJSON line, or null when it isn't JSON at all. Agent CLIs
// occasionally print a plain banner or warning to stdout; a chat pane must
// skip those rather than break the turn.
export function parseJsonLine(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Auth failures are the one error class with a genuinely different remedy: the
// user has to log in through the CLI's own flow, in a real terminal. Every
// dialect words it differently, so match on the shared vocabulary instead.
const AUTH_PATTERNS = [
  /\bnot (?:logged in|authenticated)\b/i,
  /\bplease (?:run )?[`'"]?\w*\s*login\b/i,
  /\brun [`'"]?\w+ login\b/i,
  /\bauthentication (?:failed|required|error)\b/i,
  /\bunauthorized\b/i,
  /\b401\b/,
  /\binvalid api key\b/i,
  /\bapi key\b.*\bmissing\b/i,
  /\bapi key (?:not found|is required|missing)\b/i,
  /\b(?:oauth |access |refresh )?token (?:has )?expired\b/i,
  /\bcredentials? (?:not found|missing|invalid)\b/i,
  /\blogin required\b/i,
  /\bsession (?:has )?expired\b/i,
];

export function looksLikeAuthFailure(message: string): boolean {
  return AUTH_PATTERNS.some((pattern) => pattern.test(message));
}

// Route a failure message to the right terminal event.
export function failureEvent(message: string): AgentStreamEvent {
  return looksLikeAuthFailure(message)
    ? { type: "auth-error", message }
    : { type: "error", message };
}

// Every adapter guarantees exactly one `done` per run, so the store can settle a
// thread on a single signal no matter how the process ended. This wraps the
// shared "process exited" policy: a clean exit after the CLI already reported
// completion adds nothing; anything else becomes a failure plus a `done`.
export function endOfRunEvents(
  reportedDone: boolean,
  code: number | null,
  stderr: string,
): AgentStreamEvent[] {
  if (reportedDone) return [];
  const events: AgentStreamEvent[] = [];
  if (code !== 0) {
    const detail = stderr.trim();
    events.push(
      failureEvent(
        detail || `the agent exited with status ${code === null ? "unknown" : code}`,
      ),
    );
  } else if (stderr.trim() && looksLikeAuthFailure(stderr)) {
    // A CLI that prints an auth complaint and still exits 0 has produced no
    // answer; surface the login path rather than an empty bubble.
    events.push({ type: "auth-error", message: stderr.trim() });
  }
  events.push({ type: "done" });
  return events;
}

// Tool results arrive as free-form text in both shipped dialects; the store
// renders them inside a collapsible card, so a hard cap here keeps one `cat` of
// a large file from bloating the persisted transcript.
export const MAX_TOOL_RESULT_CHARS = 8_000;

export function clampToolResult(value: string): string {
  return value.length <= MAX_TOOL_RESULT_CHARS
    ? value
    : `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n… truncated`;
}

// Flatten whatever a dialect calls "content" into displayable text.
export function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}
