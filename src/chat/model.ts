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
import { DEFAULT_ACCESS_LEVEL, type ChatAccessLevel } from "../providers/catalog";

// One rendered row of a transcript. A turn produces several: the user's
// message, any thinking, tool cards, then the assistant's answer.
export type ChatEntry =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      // True while the assistant's text is still arriving. Never persisted —
      // a reloaded transcript is by definition settled.
      streaming?: boolean;
    }
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      call: ToolCall;
      outcome: ToolOutcome | null; // null while the tool is still running
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

export type ChatThreadStatus = "idle" | "working" | "error";

export type ChatThread = {
  id: string; // the SessionMeta id — a thread IS a session of kind "chat"
  projectId: string;
  providerId: string;
  title: string;
  entries: ChatEntry[];
  // The CLI's own conversation id, so the next turn resumes rather than
  // starting cold. Null until the first turn reports one.
  resumeId: string | null;
  // The user's model pick for this thread; null runs the CLI's default.
  model: string | null;
  // Permission posture each turn spawns with (see catalog.ACCESS_LEVELS).
  access: ChatAccessLevel;
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
  model: string | null;
  access: ChatAccessLevel;
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

const DEFAULT_TITLE = "New chat";

// Threads are named from their first user message — the same convention every
// chat surface uses, and better than "Chat 3" for finding one again later.
export function titleFromMessage(text: string): string {
  const line = text.trim().split(/\r?\n/).find((entry) => entry.trim().length > 0) ?? "";
  const cleaned = line.trim().replace(/\s+/g, " ");
  if (!cleaned) return DEFAULT_TITLE;
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
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
    model: null,
    access: DEFAULT_ACCESS_LEVEL,
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
    model: thread.model,
    access: thread.access,
    // Runtime-only streaming state never reaches disk.
    entries: thread.entries
      .slice(-MAX_THREAD_ENTRIES)
      .map((entry) =>
        entry.kind === "message" && entry.streaming
          ? { kind: "message" as const, id: entry.id, role: entry.role, text: entry.text }
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
  const entries = Array.isArray(doc.entries)
    ? doc.entries.map(parseEntry).filter((entry): entry is ChatEntry => !!entry)
    : [];
  return {
    version: CHAT_DOC_VERSION,
    id: doc.id,
    projectId: doc.projectId,
    providerId: typeof doc.providerId === "string" ? doc.providerId : "claude",
    title: typeof doc.title === "string" ? doc.title : DEFAULT_TITLE,
    resumeId: typeof doc.resumeId === "string" ? doc.resumeId : null,
    model: typeof doc.model === "string" ? doc.model : null,
    // Documents predating access levels default like new threads do.
    access:
      doc.access === "plan" || doc.access === "standard" || doc.access === "full"
        ? doc.access
        : DEFAULT_ACCESS_LEVEL,
    entries: entries.slice(-MAX_THREAD_ENTRIES),
    updatedAt: typeof doc.updatedAt === "number" ? doc.updatedAt : 0,
  };
}

function parseEntry(value: unknown): ChatEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id : null;
  if (!id) return null;
  if (entry.kind === "message") {
    const role = entry.role === "user" || entry.role === "assistant" ? entry.role : null;
    if (!role || typeof entry.text !== "string") return null;
    return { kind: "message", id, role, text: entry.text };
  }
  if (entry.kind === "thinking") {
    return typeof entry.text === "string"
      ? { kind: "thinking", id, text: entry.text }
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
