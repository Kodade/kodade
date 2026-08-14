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
import type { ClaudePermissionRequest } from "../agents/claude-input";
import {
  DEFAULT_ACCESS_LEVEL,
  type ChatAccessLevel,
} from "../providers/catalog";
import {
  EMPTY_KODWORK_REVIEW,
  type KodworkFileChange,
  type KodworkReview,
} from "./ledger";

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
  // Produced files must pass this gate before a successful run is final.
  review: KodworkReview;
  // Terminal result held behind a pending output review. A failed/cancelled
  // run can still change files and must not bypass the same review gate.
  reviewOutcomeState: "done" | "failed" | "cancelled" | "needs-user" | null;
  // Fingerprints from reject/resume cycles. Three identical outputs stop the
  // loop before another paid run is started.
  rejectionFingerprints: string[];
  doomLoop: boolean;
  permissionRequest: ClaudePermissionRequest | null;
  alwaysAllowedTools: string[];
  deniedTools: { tool: string; detail: string | null }[];
  recurrence: KodworkRecurrence | null;
  scheduleReceipts: KodworkScheduleReceipt[];
  scheduledFromTaskId: string | null;
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

export type KodworkRecurrence =
  | { kind: "interval"; minutes: number; nextRunAt: number }
  | { kind: "daily"; hour: number; minute: number; nextRunAt: number };
export type KodworkRecurrenceInput =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number };

export type KodworkScheduleReceipt = {
  scheduledFor: number;
  recordedAt: number;
  status: "started" | "missed";
  sessionId: string | null;
  message: string;
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
const MAX_REVIEW_FILES = 500;
const MAX_REVIEW_TEXT_CHARS = 16 * 1024;
const MAX_REVIEW_FEEDBACK_CHARS = 20_000;

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
    review: { ...EMPTY_KODWORK_REVIEW },
    reviewOutcomeState: null,
    rejectionFingerprints: [],
    doomLoop: false,
    permissionRequest: null,
    alwaysAllowedTools: [],
    deniedTools: [],
    recurrence: null,
    scheduleReceipts: [],
    scheduledFromTaskId: null,
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
    review: {
      ...task.review,
      files: task.review.files.slice(0, MAX_REVIEW_FILES).map((file) => ({
        ...file,
        before: file.before?.slice(0, MAX_REVIEW_TEXT_CHARS) ?? null,
        after: file.after?.slice(0, MAX_REVIEW_TEXT_CHARS) ?? null,
        reasons: file.reasons.slice(0, 10).map((reason) => reason.slice(0, 240)),
      })),
      feedback: task.review.feedback.slice(0, MAX_REVIEW_FEEDBACK_CHARS),
    },
    scheduleReceipts: task.scheduleReceipts.slice(-MAX_SCHEDULE_RECEIPTS),
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
  const interrupted =
    state === "running" ||
    (!!doc.review &&
      typeof doc.review === "object" &&
      (doc.review as Record<string, unknown>).status === "collecting");
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
    state: interrupted ? "needs-user" : state,
    plan: parsePlan(doc.plan),
    tools: parseTools(doc.tools),
    statusText: typeof doc.statusText === "string" ? doc.statusText : null,
    summary: typeof doc.summary === "string" ? doc.summary : null,
    usage: parseUsage(doc.usage),
    review: interrupted ? { ...EMPTY_KODWORK_REVIEW } : parseReview(doc.review),
    reviewOutcomeState:
      doc.reviewOutcomeState === "done" ||
      doc.reviewOutcomeState === "failed" ||
      doc.reviewOutcomeState === "cancelled" ||
      doc.reviewOutcomeState === "needs-user"
        ? (interrupted ? null : doc.reviewOutcomeState)
        : null,
    rejectionFingerprints: Array.isArray(doc.rejectionFingerprints)
      ? doc.rejectionFingerprints.filter((value): value is string => typeof value === "string").slice(-3)
      : [],
    doomLoop: doc.doomLoop === true,
    // A permission request belongs to a live process and cannot survive reload.
    permissionRequest: null,
    alwaysAllowedTools: Array.isArray(doc.alwaysAllowedTools)
      ? doc.alwaysAllowedTools.filter((value): value is string => typeof value === "string").slice(0, 100)
      : [],
    deniedTools: parseDeniedTools(doc.deniedTools),
    recurrence: parseRecurrence(doc.recurrence),
    scheduleReceipts: parseScheduleReceipts(doc.scheduleReceipts),
    scheduledFromTaskId:
      typeof doc.scheduledFromTaskId === "string" ? doc.scheduledFromTaskId : null,
    resumeId: typeof doc.resumeId === "string" ? doc.resumeId : null,
    error: interrupted
      ? "Task stopped when Ködade closed. Resume to recover its original output baseline and continue."
      : typeof doc.error === "string" ? doc.error : null,
    needsLogin: doc.needsLogin === true,
    createdAt: asTime(doc.createdAt),
    updatedAt: asTime(doc.updatedAt),
    startedAt: asTimeOrNull(doc.startedAt),
    settledAt: asTimeOrNull(doc.settledAt),
  };
}

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 30 * 24 * 60;
const MAX_SCHEDULE_RECEIPTS = 100;

export function nextRecurrenceAt(
  recurrence: KodworkRecurrenceInput,
  after: number,
): number {
  if (recurrence.kind === "interval") {
    const minutes = Math.min(
      MAX_INTERVAL_MINUTES,
      Math.max(MIN_INTERVAL_MINUTES, Math.round(recurrence.minutes)),
    );
    return after + minutes * 60_000;
  }
  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setHours(recurrence.hour, recurrence.minute, 0, 0);
  if (next.getTime() <= after) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function recurrenceFromInput(
  recurrence: KodworkRecurrenceInput,
  after: number,
): KodworkRecurrence | null {
  if (recurrence.kind === "interval") {
    if (!Number.isFinite(recurrence.minutes)) return null;
    const minutes = Math.min(
      MAX_INTERVAL_MINUTES,
      Math.max(MIN_INTERVAL_MINUTES, Math.round(recurrence.minutes)),
    );
    return {
      kind: "interval",
      minutes,
      nextRunAt: nextRecurrenceAt({ kind: "interval", minutes }, after),
    };
  }
  if (
    !Number.isInteger(recurrence.hour) ||
    !Number.isInteger(recurrence.minute) ||
    recurrence.hour < 0 ||
    recurrence.hour > 23 ||
    recurrence.minute < 0 ||
    recurrence.minute > 59
  ) return null;
  return {
    ...recurrence,
    nextRunAt: nextRecurrenceAt(recurrence, after),
  };
}

export function advanceRecurrence(recurrence: KodworkRecurrence): KodworkRecurrence {
  return {
    ...recurrence,
    nextRunAt: nextRecurrenceAt(recurrence, recurrence.nextRunAt),
  };
}

export function projectedCadenceTokens(
  tasks: Record<string, KodworkTask>,
  sourceTaskId: string,
  recurrence: KodworkRecurrence,
): { averagePerRun: number; runsPer30Days: number; totalTokens: number } {
  const history = Object.values(tasks).filter(
    (task) =>
      (task.id === sourceTaskId || task.scheduledFromTaskId === sourceTaskId) &&
      task.usage !== null,
  );
  const averagePerRun = history.length
    ? Math.round(
        history.reduce((total, task) => total + (task.usage?.totalTokens ?? 0), 0) /
          history.length,
      )
    : 0;
  const runsPer30Days =
    recurrence.kind === "daily"
      ? 30
      : Math.ceil((30 * 24 * 60) / recurrence.minutes);
  return {
    averagePerRun,
    runsPer30Days,
    totalTokens: averagePerRun * runsPer30Days,
  };
}

function parseRecurrence(value: unknown): KodworkRecurrence | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.nextRunAt !== "number" || !Number.isFinite(item.nextRunAt)) return null;
  if (item.kind === "interval" && typeof item.minutes === "number") {
    const minutes = Math.round(item.minutes);
    if (minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) return null;
    return { kind: "interval", minutes, nextRunAt: item.nextRunAt };
  }
  if (
    item.kind === "daily" &&
    Number.isInteger(item.hour) &&
    Number.isInteger(item.minute) &&
    (item.hour as number) >= 0 &&
    (item.hour as number) <= 23 &&
    (item.minute as number) >= 0 &&
    (item.minute as number) <= 59
  ) {
    return {
      kind: "daily",
      hour: item.hour as number,
      minute: item.minute as number,
      nextRunAt: item.nextRunAt,
    };
  }
  return null;
}

function parseScheduleReceipts(value: unknown): KodworkScheduleReceipt[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .flatMap((entry) => {
      if (
        typeof entry.scheduledFor !== "number" ||
        typeof entry.recordedAt !== "number" ||
        (entry.status !== "started" && entry.status !== "missed") ||
        typeof entry.message !== "string"
      ) return [];
      return [{
        scheduledFor: entry.scheduledFor,
        recordedAt: entry.recordedAt,
        status: entry.status as KodworkScheduleReceipt["status"],
        sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
        message: entry.message,
      }];
    })
    .slice(-MAX_SCHEDULE_RECEIPTS);
}

export function projectTokenUsage(
  tasks: Record<string, KodworkTask>,
  projectId: string,
): TokenUsage {
  return Object.values(tasks)
    .filter((task) => task.projectId === projectId && task.usage)
    .reduce<TokenUsage>(
      (total, task) => ({
        promptTokens: total.promptTokens + (task.usage?.promptTokens ?? 0),
        completionTokens: total.completionTokens + (task.usage?.completionTokens ?? 0),
        totalTokens: total.totalTokens + (task.usage?.totalTokens ?? 0),
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );
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

function parseDeniedTools(value: unknown): { tool: string; detail: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-50).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const item = raw as Record<string, unknown>;
    return typeof item.tool === "string"
      ? [{ tool: item.tool, detail: typeof item.detail === "string" ? item.detail : null }]
      : [];
  });
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

function parseReview(value: unknown): KodworkReview {
  if (typeof value !== "object" || value === null) {
    return { ...EMPTY_KODWORK_REVIEW };
  }
  const review = value as Record<string, unknown>;
  const status =
    review.status === "collecting" ||
    review.status === "pending" ||
    review.status === "accepted" ||
    review.status === "restoring" ||
    review.status === "restore-failed"
      ? review.status
      : "idle";
  return {
    kind: review.kind === "git" || review.kind === "folder" ? review.kind : null,
    // A process cannot still be collecting after an app restart.
    status: status === "collecting" ? "pending" : status,
    files: parseReviewFiles(review.files),
    feedback:
      typeof review.feedback === "string"
        ? review.feedback.slice(0, MAX_REVIEW_FEEDBACK_CHARS)
        : "",
    fingerprint:
      typeof review.fingerprint === "string" ? review.fingerprint : null,
  };
}

function parseReviewFiles(value: unknown): KodworkFileChange[] {
  if (!Array.isArray(value)) return [];
  const files: KodworkFileChange[] = [];
  for (const raw of value.slice(0, MAX_REVIEW_FILES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const file = raw as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.relativePath !== "string") continue;
    files.push({
      path: file.path,
      relativePath: file.relativePath,
      change:
        file.change === "added" ||
        file.change === "deleted" ||
        file.change === "renamed"
          ? file.change
          : "modified",
      binary: file.binary === true,
      humanTouched: file.humanTouched === true,
      before:
        typeof file.before === "string"
          ? file.before.slice(0, MAX_REVIEW_TEXT_CHARS)
          : null,
      after:
        typeof file.after === "string"
          ? file.after.slice(0, MAX_REVIEW_TEXT_CHARS)
          : null,
      bucket:
        file.bucket === "risky" || file.bucket === "trivial"
          ? file.bucket
          : "routine",
      reasons: Array.isArray(file.reasons)
        ? file.reasons
            .filter((reason): reason is string => typeof reason === "string")
            .slice(0, 10)
            .map((reason) => reason.slice(0, 240))
        : [],
    });
  }
  return files;
}

function asTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asTimeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
