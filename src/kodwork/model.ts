// KödWork's task shape and its on-disk document (#43).
//
// A task is "describe an outcome, an agent works in the background": the model
// keeps the outcome text, run configuration, and a PROGRESS projection (plan
// items, tool lines, status, final summary) — deliberately not a transcript.
// Task documents live outside the main persisted doc, one JSON file per task
// (`kodwork/<taskId>.json`), for the same two reasons KödChat transcripts do:
// they are unbounded relative to the main doc, and the outcome/summary text is
// private. Nothing here is ever handed to the Activity module or KödMem —
// those receive ids, counts, and short generic reasons only.

import type { AgentPlanItem } from "../agents/contract";
import type { TokenUsage } from "../inference/backend";
import type { ToolCall } from "../local/toolcall";
import { titleFromMessage } from "../chat/model";
import type { WorkspaceGroupKind } from "../activity/activity";
import {
  DEFAULT_ACCESS_LEVEL,
  type ChatAccessLevel,
} from "../providers/catalog";

// draft → running → needs-user | done | failed | cancelled. A settled task
// (done/failed/cancelled) can be resumed, which returns it to running.
export type KodworkTaskState =
  | "draft"
  | "running"
  | "needs-user"
  | "done"
  | "failed"
  | "cancelled";

export function isSettledTaskState(state: KodworkTaskState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

// The inbox group a task belongs to — the same vocabulary the Activity module
// projects (needs-user / working / settled). Drafts read as settled: they are
// waiting on the user's Start, not on the agent.
export function taskGroup(state: KodworkTaskState): WorkspaceGroupKind {
  if (state === "needs-user") return "needs-user";
  if (state === "running") return "working";
  return "settled";
}

// One tool call, summarized: name, a short detail line, and whether it landed.
// `ok` is null while the call is still running.
export type KodworkToolLine = {
  id: string;
  tool: string;
  detail: string | null;
  ok: boolean | null;
};

export type KodworkTask = {
  id: string; // the SessionMeta id — a task IS a session of kind "work"
  projectId: string;
  // Absolute folder the agent runs in. Defaults to the project root; kept on
  // the task because projects are renameable and tasks may target a subfolder.
  folder: string;
  // The outcome the user asked for. Never leaves the kodwork store.
  outcome: string;
  title: string;
  providerId: string;
  access: ChatAccessLevel;
  state: KodworkTaskState;
  plan: AgentPlanItem[];
  tools: KodworkToolLine[];
  // Short live status while the agent runs (latest thinking head). Runtime
  // color for the progress view; persisted so a reload shows the last state.
  statusText: string | null;
  // The agent's final report for the last run.
  summary: string | null;
  usage: TokenUsage | null;
  // The CLI's own session id, so a resume continues rather than starting cold.
  resumeId: string | null;
  error: string | null;
  // The last run failed on authentication — resume is pointless until the
  // user logs the CLI in through a real terminal.
  needsLogin: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  settledAt: number | null;
};

export const KODWORK_DOC_VERSION = 1;

export type PersistedKodworkTask = Omit<KodworkTask, "updatedAt"> & {
  version: number;
  updatedAt: number;
};

// Document name for a task. Rust's storage validator confines this to the app
// data dir; the id is a UUID in production.
export function kodworkDocName(taskId: string): string {
  return `kodwork/${taskId}.json`;
}

// Bounds: a runaway agent must not grow a task document without limit.
export const MAX_PLAN_ITEMS = 200;
export const MAX_TOOL_LINES = 500;
const MAX_STATUS_CHARS = 160;
const MAX_SUMMARY_CHARS = 20_000;
const MAX_TOOL_DETAIL_CHARS = 120;

export const DEFAULT_TASK_TITLE = "New task";

// A task is titled from its outcome text, same distillation as chat threads.
export function titleFromOutcome(outcome: string): string {
  const title = titleFromMessage(outcome);
  return title === "New chat" ? DEFAULT_TASK_TITLE : title;
}

// The most recent non-empty line, capped — the progress view's live status.
export function clampStatus(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return line.length > MAX_STATUS_CHARS ? `${line.slice(0, MAX_STATUS_CHARS - 1)}…` : line;
}

export function clampSummary(text: string): string {
  return text.length > MAX_SUMMARY_CHARS
    ? `${text.slice(0, MAX_SUMMARY_CHARS)}\n… truncated`
    : text;
}

// A short, human-readable detail for a tool line, from the argument keys the
// shipped dialects actually use. Stays inside the kodwork store/doc.
const DETAIL_ARG_KEYS = ["file_path", "path", "command", "pattern", "url", "query"];

export function toolDetail(call: ToolCall): string | null {
  for (const key of DETAIL_ARG_KEYS) {
    const value = call.args[key];
    if (typeof value === "string" && value.trim()) {
      const line = value.trim().split(/\r?\n/)[0]!;
      return line.length > MAX_TOOL_DETAIL_CHARS
        ? `${line.slice(0, MAX_TOOL_DETAIL_CHARS - 1)}…`
        : line;
    }
  }
  return null;
}

export function newTask(
  id: string,
  projectId: string,
  folder: string,
  providerId: string,
  now: number,
): KodworkTask {
  return {
    id,
    projectId,
    folder,
    outcome: "",
    title: DEFAULT_TASK_TITLE,
    providerId,
    access: DEFAULT_ACCESS_LEVEL,
    state: "draft",
    plan: [],
    tools: [],
    statusText: null,
    summary: null,
    usage: null,
    resumeId: null,
    error: null,
    needsLogin: false,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    settledAt: null,
  };
}

export function toPersistedTask(task: KodworkTask): PersistedKodworkTask {
  return {
    version: KODWORK_DOC_VERSION,
    ...task,
    plan: task.plan.slice(0, MAX_PLAN_ITEMS),
    tools: task.tools.slice(-MAX_TOOL_LINES),
  };
}

// Parse a task document defensively: a hand-edited or half-written file must
// degrade to "no saved task", never break the pane. A task persisted while
// running reloads as needs-user — its process died with the app, so it needs
// the user to resume, and must never reload stuck "working".
export function parsePersistedTask(raw: string): PersistedKodworkTask | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Record<string, unknown>;
  if (doc.version !== KODWORK_DOC_VERSION) return null;
  if (typeof doc.id !== "string" || typeof doc.projectId !== "string") return null;
  const state = parseState(doc.state);
  return {
    version: KODWORK_DOC_VERSION,
    id: doc.id,
    projectId: doc.projectId,
    folder: typeof doc.folder === "string" ? doc.folder : "",
    outcome: typeof doc.outcome === "string" ? doc.outcome : "",
    title: typeof doc.title === "string" && doc.title ? doc.title : DEFAULT_TASK_TITLE,
    providerId: typeof doc.providerId === "string" ? doc.providerId : "claude",
    access:
      doc.access === "plan" || doc.access === "standard" || doc.access === "full"
        ? doc.access
        : DEFAULT_ACCESS_LEVEL,
    state: state === "running" ? "needs-user" : state,
    plan: parsePlan(doc.plan),
    tools: parseTools(doc.tools),
    statusText: typeof doc.statusText === "string" ? doc.statusText : null,
    summary: typeof doc.summary === "string" ? doc.summary : null,
    usage: parseUsage(doc.usage),
    resumeId: typeof doc.resumeId === "string" ? doc.resumeId : null,
    error: typeof doc.error === "string" ? doc.error : null,
    needsLogin: doc.needsLogin === true,
    createdAt: asTime(doc.createdAt),
    updatedAt: asTime(doc.updatedAt),
    startedAt: asTimeOrNull(doc.startedAt),
    settledAt: asTimeOrNull(doc.settledAt),
  };
}

function parseState(value: unknown): KodworkTaskState {
  return value === "draft" ||
    value === "running" ||
    value === "needs-user" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : "draft";
}

function parsePlan(value: unknown): AgentPlanItem[] {
  if (!Array.isArray(value)) return [];
  const items: AgentPlanItem[] = [];
  for (const entry of value.slice(0, MAX_PLAN_ITEMS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.text !== "string") continue;
    const status =
      item.status === "pending" || item.status === "in-progress" || item.status === "completed"
        ? item.status
        : "pending";
    items.push({ text: item.text, status });
  }
  return items;
}

function parseTools(value: unknown): KodworkToolLine[] {
  if (!Array.isArray(value)) return [];
  const lines: KodworkToolLine[] = [];
  for (const entry of value.slice(-MAX_TOOL_LINES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const line = entry as Record<string, unknown>;
    if (typeof line.id !== "string" || typeof line.tool !== "string") continue;
    lines.push({
      id: line.id,
      tool: line.tool,
      detail: typeof line.detail === "string" ? line.detail : null,
      ok: typeof line.ok === "boolean" ? line.ok : null,
    });
  }
  return lines;
}

function parseUsage(value: unknown): TokenUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const usage = value as Record<string, unknown>;
  if (
    typeof usage.promptTokens !== "number" ||
    typeof usage.completionTokens !== "number" ||
    typeof usage.totalTokens !== "number"
  ) {
    return null;
  }
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
}

function asTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asTimeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
