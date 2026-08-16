// KödChat's transcript shape and its on-disk document.
//
// Transcripts live OUTSIDE the main persisted document, one JSON file per
// thread (`chats/<threadId>.json`), loaded lazily when the pane opens a thread.
// Two reasons: a chat transcript is unbounded where the main doc must stay
// small and rewritten-on-every-change, and it is the single most sensitive
// thing Kodade stores — keeping it in its own file makes the privacy boundary
// physical as well as procedural. Nothing here is ever handed to the Activity
// module or KödMem; those receive metadata facts only.

import type { ToolCall } from "../local/toolcall";
import type { ToolOutcome } from "../local/tools";
import type { AgentPlanItem } from "../agents/contract";
import {
  DEFAULT_ACCESS_LEVEL,
  DEFAULT_CHAT_SPEED,
  type ChatAccessLevel,
  type ChatSpeed,
} from "../providers/catalog";

// One rendered row of a transcript. A turn produces several: the user's
// message, any thinking, tool cards, then the assistant's answer.
export type ChatEntry =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      // Client-side conversation boundary. Provider/model switches keep the
      // visible transcript but must not replay an earlier provider's messages.
      // Optional only for source compatibility with version-1 documents.
      conversationId?: number;
      // True while the assistant's text is still arriving. Never persisted —
      // a reloaded transcript is by definition settled.
      streaming?: boolean;
      // Preserved so later authoritative provider output replaces this bubble.
      providerMessageId?: string;
    }
  | {
      kind: "thinking";
      id: string;
      text: string;
      // Preserved so raw provider thinking deltas update this entry on reload.
      providerMessageId?: string;
    }
  | {
      kind: "tool";
      id: string;
      call: ToolCall;
      outcome: ToolOutcome | null; // null while the tool is still running
      // Preserved so a later provider result closes this existing tool card.
      providerCallId?: string;
    }
  | { kind: "plan"; id: string; items: AgentPlanItem[] }
  | {
      kind: "error";
      id: string;
      message: string;
      // An auth failure is offered a login terminal rather than a retry:
      // Kodade wraps the CLI's own login flow and never proxies credentials.
      auth?: boolean;
    };

export type ChatThreadStatus = "idle" | "working" | "detached" | "error";

export type ChatThread = {
  id: string; // the SessionMeta id — a thread IS a session of kind "chat"
  projectId: string;
  providerId: string;
  title: string;
  entries: ChatEntry[];
  // The CLI's own conversation id, so the next turn resumes rather than
  // starting cold. Null until the first turn reports one.
  resumeId: string | null;
  // Monotonic client-side boundary for transports without native sessions.
  // Switching provider (or an Ollama model) increments it while preserving
  // older entries for display.
  conversationId: number;
  // The user's model pick for this thread; null runs the CLI's default.
  model: string | null;
  // Permission posture each turn spawns with (see catalog.ACCESS_LEVELS).
  access: ChatAccessLevel;
  // Thinking level id (catalog thinkingLevels); null runs the CLI's default.
  thinking: string | null;
  // Per-thread service speed. Default preserves the provider CLI's behavior.
  speed: ChatSpeed;
  status: ChatThreadStatus;
  // Set when the last run failed on authentication, so the pane can keep
  // offering the login terminal after the run settles.
  needsLogin: boolean;
  updatedAt: number;
};

// The persisted per-thread document. Versioned separately from the main doc so
// a transcript format change never risks the projects document.
export const CHAT_DOC_VERSION = 1;

export type PersistedChatThread = {
  version: number;
  id: string;
  projectId: string;
  providerId: string;
  title: string;
  resumeId: string | null;
  conversationId: number;
  model: string | null;
  access: ChatAccessLevel;
  thinking: string | null;
  speed: ChatSpeed;
  entries: ChatEntry[];
  updatedAt: number;
};

// Document name for a thread. Rust validates this again before touching disk;
// the id is a UUID in production, and anything unexpected is rejected there.
export function chatDocName(threadId: string): string {
  return `chats/${threadId}.json`;
}

// How many entries one thread keeps. Long enough that a real working session
// never loses context in the UI, bounded so a runaway agent cannot grow one
// document without limit.
export const MAX_THREAD_ENTRIES = 2_000;

// What an empty thread is called everywhere a title renders (sidebar, header).
export const DEFAULT_TITLE = "New chat";

// Filler dropped when distilling a prompt into a topic: politeness, pronouns,
// auxiliaries, articles, prepositions, and request verbs that carry no topic
// ("help", "fix", "make sure"). Content verbs ("explain", "add") are kept.
const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those", "there", "here",
  "i", "me", "my", "we", "us", "our", "you", "your", "it", "its",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did",
  "have", "has", "had", "can", "could", "would", "should", "will",
  "shall", "may", "might", "must", "to", "of", "in", "on", "at", "for",
  "with", "from", "about", "into", "and", "or", "but", "so", "if",
  "then", "how", "what", "when", "where", "why", "who", "which",
  "please", "help", "want", "need", "like", "just", "some", "any",
  "get", "got", "let", "lets", "make", "sure", "fix", "try", "trying",
  "hi", "hey", "hello", "thanks", "thank", "ok", "okay",
]);

// Threads are auto-titled from their first user message: a short 2–3 word
// topic rather than the raw line, and never a provider-numbered name.
// Falls back to DEFAULT_TITLE when nothing meaningful remains.
export function titleFromMessage(text: string): string {
  const line = text.trim().split(/\r?\n/).find((entry) => entry.trim().length > 0) ?? "";
  const words = line
    .replace(/[`*_~#>\[\]|(){}"]/g, " ") // markdown decoration → spaces
    .split(/\s+/)
    // Trim leading/trailing punctuation but keep internal chars ("note.txt").
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word.length > 0 && !TITLE_STOPWORDS.has(word.toLowerCase()));
  const title = words.slice(0, 3).join(" ");
  if (!title) return DEFAULT_TITLE;
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

export function newThread(
  id: string,
  projectId: string,
  providerId: string,
  now: number,
): ChatThread {
  return {
    id,
    projectId,
    providerId,
    title: DEFAULT_TITLE,
    entries: [],
    resumeId: null,
    conversationId: 0,
    model: null,
    access: DEFAULT_ACCESS_LEVEL,
    thinking: null,
    speed: DEFAULT_CHAT_SPEED,
    status: "idle",
    needsLogin: false,
    updatedAt: now,
  };
}

export function toPersistedThread(thread: ChatThread): PersistedChatThread {
  return {
    version: CHAT_DOC_VERSION,
    id: thread.id,
    projectId: thread.projectId,
    providerId: thread.providerId,
    title: thread.title,
    resumeId: thread.resumeId,
    conversationId: thread.conversationId,
    model: thread.model,
    access: thread.access,
    thinking: thread.thinking,
    speed: thread.speed,
    // Runtime-only streaming state never reaches disk.
    entries: thread.entries
      .slice(-MAX_THREAD_ENTRIES)
      .map((entry) =>
        entry.kind === "message" && entry.streaming
          ? {
              kind: "message" as const,
              id: entry.id,
              role: entry.role,
              text: entry.text,
              conversationId: entry.conversationId,
              providerMessageId: entry.providerMessageId,
            }
          : entry,
      ),
    updatedAt: thread.updatedAt,
  };
}

// Parse a transcript document defensively: a hand-edited or half-written file
// must degrade to "empty thread", never break the pane.
export function parsePersistedThread(raw: string): PersistedChatThread | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Record<string, unknown>;
  if (doc.version !== CHAT_DOC_VERSION) return null;
  if (typeof doc.id !== "string" || typeof doc.projectId !== "string") return null;
  const conversationId =
    typeof doc.conversationId === "number" &&
    Number.isSafeInteger(doc.conversationId) &&
    doc.conversationId >= 0
      ? doc.conversationId
      : 0;
  const entries = Array.isArray(doc.entries)
    ? doc.entries
        .map((entry) => parseEntry(entry, conversationId))
        .filter((entry): entry is ChatEntry => !!entry)
    : [];
  return {
    version: CHAT_DOC_VERSION,
    id: doc.id,
    projectId: doc.projectId,
    providerId: typeof doc.providerId === "string" ? doc.providerId : "claude",
    title: typeof doc.title === "string" ? doc.title : DEFAULT_TITLE,
    resumeId: typeof doc.resumeId === "string" ? doc.resumeId : null,
    conversationId,
    model: typeof doc.model === "string" ? doc.model : null,
    // Documents predating access levels default like new threads do.
    access:
      doc.access === "plan" || doc.access === "standard" || doc.access === "full"
        ? doc.access
        : DEFAULT_ACCESS_LEVEL,
    // Documents predating thinking levels run the CLI's default effort.
    thinking: typeof doc.thinking === "string" ? doc.thinking : null,
    // Documents predating speed tiers retain normal provider behavior.
    speed: doc.speed === "fast" ? "fast" : DEFAULT_CHAT_SPEED,
    entries: entries.slice(-MAX_THREAD_ENTRIES),
    updatedAt: typeof doc.updatedAt === "number" ? doc.updatedAt : 0,
  };
}

function parseEntry(value: unknown, fallbackConversationId = 0): ChatEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id : null;
  if (!id) return null;
  if (entry.kind === "message") {
    const role = entry.role === "user" || entry.role === "assistant" ? entry.role : null;
    if (!role || typeof entry.text !== "string") return null;
    const conversationId =
      typeof entry.conversationId === "number" &&
      Number.isSafeInteger(entry.conversationId) &&
      entry.conversationId >= 0
        ? entry.conversationId
        : fallbackConversationId;
    return {
      kind: "message",
      id,
      role,
      text: entry.text,
      conversationId,
      ...(typeof entry.providerMessageId === "string"
        ? { providerMessageId: entry.providerMessageId }
        : {}),
    };
  }
  if (entry.kind === "thinking") {
    return typeof entry.text === "string"
      ? {
          kind: "thinking",
          id,
          text: entry.text,
          ...(typeof entry.providerMessageId === "string"
            ? { providerMessageId: entry.providerMessageId }
            : {}),
        }
      : null;
  }
  if (entry.kind === "tool") {
    const call = entry.call as ToolCall | undefined;
    if (!call || typeof call.tool !== "string") return null;
    return {
      kind: "tool",
      id,
      call: { tool: call.tool, args: (call.args ?? {}) as Record<string, unknown> },
      outcome: (entry.outcome as ToolOutcome | null) ?? null,
      ...(typeof entry.providerCallId === "string"
        ? { providerCallId: entry.providerCallId }
        : {}),
    };
  }
  if (entry.kind === "plan") {
    return Array.isArray(entry.items)
      ? { kind: "plan", id, items: entry.items as AgentPlanItem[] }
      : null;
  }
  if (entry.kind === "error") {
    return typeof entry.message === "string"
      ? {
          kind: "error",
          id,
          message: entry.message,
          ...(entry.auth === true ? { auth: true } : {}),
        }
      : null;
  }
  return null;
}
