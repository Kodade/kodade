// KödWork's task store (Zustand vanilla, headless-testable, #43). Owns the
// task documents and the run lifecycle; every dependency is injected so tests
// drive it with the IPC mocks. Copies KödChat's store discipline
// (src/chat/store.ts): one run per turn with `<taskId>#<turn>` ids so a late
// exit from a cancelled run can never be mistaken for the new one, run
// bookkeeping outside React state, and debounced per-task persistence
// serialized through a write chain.
//
// Privacy boundary (load-bearing): outcome text, plan text, tool details, and
// the final summary never leave this store. The `activity` hooks receive ids,
// a provider id, and a short fixed reason; the KödMem completion checkpoint
// receives ids and counts only.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentStreamAdapter, AgentStreamEvent } from "../agents/contract";
import { adapterFor } from "../agents/registry";
import type { AgentIpc, MemoryIpc, StorageIpc, Unlisten } from "../ipc/contract";
import type { TokenUsage } from "../inference/backend";
import { developmentFeatureEnabled } from "../release/manifest";
import { containsLikelySecret } from "../local/checkpointGuard";
import type { ChatAccessLevel } from "../providers/catalog";
import { nativeEquals, nativeIsDescendant } from "../platform/native-path";
import {
  encodeClaudePermissionResponse,
  encodeClaudeUserMessage,
} from "../agents/claude-input";
import {
  MAX_PLAN_ITEMS,
  MAX_TOOL_LINES,
  advanceRecurrence,
  clampStatus,
  clampSummary,
  kodworkDocName,
  newTask,
  nextRecurrenceAt,
  recurrenceFromInput,
  parsePersistedTask,
  titleFromOutcome,
  toPersistedTask,
  toolDetail,
  DEFAULT_TASK_TITLE,
  type KodworkRecurrenceInput,
  type KodworkScheduleReceipt,
  type KodworkTask,
} from "./model";
import { templatePrompt, type KodworkTemplate } from "./templates";
import {
  EMPTY_KODWORK_REVIEW,
  type KodworkLedger,
  type KodworkRestorePlan,
} from "./ledger";

// New tasks default to Claude Code; the composer can pick any streaming CLI.
export const DEFAULT_KODWORK_PROVIDER = "claude";

// What a run without an explicit instruction resumes with.
const RESUME_PROMPT = "Continue working toward the outcome.";
const DOOM_LOOP_REJECTIONS = 3;
const PERMISSION_TIMEOUT_MS = 60_000;

function addUsage(left: TokenUsage | null, right: TokenUsage | null): TokenUsage | null {
  if (!left) return right;
  if (!right) return left;
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

// The one narrow KödMem seam the store needs: resolve the task folder to a
// workspace and write the completion checkpoint.
export type KodworkMemory = Pick<MemoryIpc, "resolveWorkspace" | "checkpoint">;

// Metadata-only hooks. Nothing here carries outcome, plan, or tool text.
export type KodworkActivityHooks = {
  // The task produced output (drives the "working" pulse).
  streamed?(projectId: string, taskId: string): void;
  // The task started or stopped running. `process` is the provider id while
  // running and null once settled — the same shape a terminal-foreground fact
  // has, so the Activity module groups tasks working/settled itself.
  working?(projectId: string, taskId: string, process: string | null): void;
  // The task wants the user: an auth failure, a crash, or nothing (cleared).
  attention?(projectId: string, taskId: string, reason: string | null): void;
};

export type KodworkDeps = {
  agent: AgentIpc;
  storage: StorageIpc;
  // Absent memory (tests that don't care) simply skips the checkpoint.
  memory?: KodworkMemory;
  // Resolved at task-creation and spawn time — projects are renameable.
  projectRoot(projectId: string): string | null;
  adapters?: (providerId: string) => AgentStreamAdapter | null;
  // Respect the compiled release profile. When disabled the store refuses to
  // register or run anything, matching the unavailable surface.
  enabled?: () => boolean;
  newId?: () => string;
  now?: () => number;
  activity?: KodworkActivityHooks;
  ledger?: KodworkLedger;
  templates?: {
    list(projectRoot: string, providerId: string): Promise<KodworkTemplate[]>;
  };
  createScheduledSession?(projectId: string): string | null;
  // Debounce for task-document writes; a streaming run reports many events.
  persistDebounceMs?: number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
};

export type KodworkState = {
  tasks: Record<string, KodworkTask>;
  templates: KodworkTemplate[];
  templatesLoading: boolean;
  templatesError: string | null;
  pendingRestore: KodworkRestorePlan | null;
  // Tasks whose document has been read (or created), so opening twice doesn't
  // re-read the disk.
  loaded: Record<string, boolean>;

  // Begin listening for run events. Idempotent per call; returns a teardown.
  start(): Promise<Unlisten>;
  // Register a task the projects store already created as a "work" session,
  // then load its document from disk if it has one.
  openTask(taskId: string, projectId: string): Promise<void>;
  // Draft edits (no-ops while the task is running).
  setOutcome(taskId: string, outcome: string): void;
  setFolder(taskId: string, folder: string): void;
  setProvider(taskId: string, providerId: string): void;
  setAccess(taskId: string, access: ChatAccessLevel): void;
  loadTemplates(taskId: string): Promise<void>;
  applyTemplate(taskId: string, templateId: string): void;
  setRecurrence(taskId: string, recurrence: KodworkRecurrenceInput | null): void;
  reconcileSchedules(at?: number): Promise<void>;
  tickSchedules(at?: number): Promise<void>;
  // Run the task fresh. Resolves once the run has STARTED — progress arrives
  // through the event stream.
  startTask(taskId: string): Promise<void>;
  // Continue a settled/needs-user task on the CLI's saved session. Falls back
  // to a fresh start when no resume id was captured.
  resumeTask(taskId: string, instruction?: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  setReviewFeedback(taskId: string, feedback: string): void;
  acceptReview(taskId: string): Promise<void>;
  rejectReview(taskId: string): Promise<void>;
  prepareRestore(taskId: string): Promise<void>;
  confirmRestore(taskId: string): Promise<void>;
  cancelRestore(taskId: string): void;
  noteHumanChange(path: string): void;
  respondPermission(taskId: string, decision: "once" | "always" | "deny"): Promise<void>;
  steerTask(taskId: string, message: string): Promise<void>;
  // Drop a task and its document (its session was closed).
  removeTask(taskId: string): Promise<void>;
  // Flush any pending debounced document write.
  flush(taskId: string): Promise<void>;
};

const DEFAULT_PERSIST_DEBOUNCE_MS = 400;

// `<taskId>#<turn>` — split back out when an event arrives.
function taskIdOfRun(runId: string): string {
  const hash = runId.lastIndexOf("#");
  return hash === -1 ? runId : runId.slice(0, hash);
}

export function createKodworkStore(deps: KodworkDeps): StoreApi<KodworkState> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());
  const adapters = deps.adapters ?? adapterFor;
  const enabled = deps.enabled ?? (() => developmentFeatureEnabled("work"));
  const setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle));
  const debounceMs = deps.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;

  // Live run bookkeeping, outside React state.
  type Run = {
    runId: string;
    parser: ReturnType<AgentStreamAdapter["createParser"]>;
    // Adapter callId → tool-line id, so completion marks the right line.
    toolLines: Map<string, string>;
    // Accumulated answer/thinking text per adapter messageId.
    messageText: Map<string, string>;
    thinkingText: Map<string, string>;
    cancelled: boolean;
    failed: boolean;
    usage: TokenUsage | null;
    turn: number;
    interactive: boolean;
    permissionTimer: ReturnType<typeof setTimeout> | null;
  };
  const runs = new Map<string, Run>();
  const runByRunId = new Map<string, string>(); // runId → taskId
  const turns = new Map<string, number>();
  const humanChanges = new Map<string, Set<string>>();

  // Per-task debounced write handles, plus a chain so two writes for one task
  // can never land out of order.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let writeChain: Promise<void> = Promise.resolve();

  const store = createStore<KodworkState>((set, get) => {
    const persistNow = (taskId: string): Promise<void> => {
      const task = get().tasks[taskId];
      if (!task) return Promise.resolve();
      const doc = JSON.stringify(toPersistedTask(task));
      const run = async () => {
        try {
          await deps.storage.writeDoc(kodworkDocName(taskId), doc);
        } catch (error) {
          console.error(`kodade: KödWork task write failed (${taskId}):`, error);
        }
      };
      writeChain = writeChain.then(run);
      return writeChain;
    };

    const persistDebounced = (taskId: string) => {
      const existing = pending.get(taskId);
      if (existing) clearTimer(existing);
      pending.set(
        taskId,
        setTimer(() => {
          pending.delete(taskId);
          void persistNow(taskId);
        }, debounceMs),
      );
    };

    // Mutate one task, stamping updatedAt. Missing tasks are ignored — a late
    // event for a removed task must not resurrect it.
    const patch = (taskId: string, change: (task: KodworkTask) => KodworkTask) => {
      set((state) => {
        const task = state.tasks[taskId];
        if (!task) return state;
        const next = change(task);
        if (next === task) return state;
        return {
          tasks: { ...state.tasks, [taskId]: { ...next, updatedAt: now() } },
        };
      });
    };

    // Route one normalized adapter event into the task's progress projection.
    const applyEvent = (taskId: string, run: Run, event: AgentStreamEvent) => {
      const task = get().tasks[taskId];
      if (!task) return;
      switch (event.type) {
        case "session":
          patch(taskId, (current) => ({ ...current, resumeId: event.sessionId }));
          return;
        case "message-delta": {
          const text = (run.messageText.get(event.messageId) ?? "") + event.text;
          run.messageText.set(event.messageId, text);
          patch(taskId, (current) => ({ ...current, summary: clampSummary(text) }));
          deps.activity?.streamed?.(task.projectId, taskId);
          return;
        }
        case "message-complete": {
          run.messageText.set(event.messageId, event.message.content);
          patch(taskId, (current) => ({
            ...current,
            summary: clampSummary(event.message.content),
          }));
          deps.activity?.streamed?.(task.projectId, taskId);
          return;
        }
        case "thinking-delta": {
          const text = (run.thinkingText.get(event.messageId) ?? "") + event.text;
          run.thinkingText.set(event.messageId, text);
          patch(taskId, (current) => ({ ...current, statusText: clampStatus(text) }));
          return;
        }
        case "thinking-complete":
          run.thinkingText.set(event.messageId, event.text);
          patch(taskId, (current) => ({ ...current, statusText: clampStatus(event.text) }));
          return;
        case "plan":
          patch(taskId, (current) => ({
            ...current,
            plan: event.items.slice(0, MAX_PLAN_ITEMS),
          }));
          return;
        case "tool-call-started": {
          const id = newId();
          run.toolLines.set(event.callId, id);
          patch(taskId, (current) => ({
            ...current,
            tools: [
              ...current.tools,
              { id, tool: event.call.tool, detail: toolDetail(event.call), ok: null },
            ].slice(-MAX_TOOL_LINES),
          }));
          deps.activity?.streamed?.(task.projectId, taskId);
          return;
        }
        case "tool-call-completed": {
          const lineId = run.toolLines.get(event.callId);
          if (!lineId) return;
          const ok =
            event.outcome.status === "executed" || event.outcome.status === "answer";
          patch(taskId, (current) => ({
            ...current,
            tools: current.tools.map((line) =>
              line.id === lineId ? { ...line, ok } : line,
            ),
          }));
          return;
        }
        case "auth-error":
          patch(taskId, (current) => ({
            ...current,
            needsLogin: true,
            error: event.message,
          }));
          return;
        case "permission-request": {
          if (run.permissionTimer) clearTimer(run.permissionTimer);
          run.permissionTimer = setTimer(() => {
            void get().respondPermission(taskId, "deny");
          }, PERMISSION_TIMEOUT_MS);
          patch(taskId, (current) => ({
            ...current,
            state: "needs-user",
            permissionRequest: event.request,
          }));
          deps.activity?.attention?.(task.projectId, taskId, "approve a tool request");
          return;
        }
        case "tool-denied":
          patch(taskId, (current) => ({
            ...current,
            deniedTools: [...current.deniedTools, { tool: event.tool, detail: event.detail }].slice(-50),
          }));
          return;
        case "error":
          run.failed = true;
          patch(taskId, (current) => ({ ...current, error: event.message }));
          return;
        case "done":
          run.usage = event.usage ?? null;
          if (run.interactive) void deps.agent.end?.({ id: run.runId });
          settle(taskId, run);
          return;
      }
    };

    // Close out a run: decide the terminal state, notify the inbox, persist,
    // and (on success only) write the KödMem completion checkpoint.
    const settle = (taskId: string, run: Run) => {
      if (runs.get(taskId)?.runId !== run.runId) return;
      runs.delete(taskId);
      if (run.permissionTimer) clearTimer(run.permissionTimer);
      runByRunId.delete(run.runId);
      patch(taskId, (task) => ({
        ...task,
        state: run.cancelled
          ? "cancelled"
          : task.needsLogin
            ? "needs-user"
            : run.failed
              ? "failed"
              : "done",
        statusText: null,
        usage: addUsage(task.usage, run.usage),
        settledAt: now(),
        permissionRequest: null,
        review: deps.ledger
          ? task.review
          : { ...task.review, status: "accepted" as const },
      }));
      const task = get().tasks[taskId];
      if (task && deps.ledger) {
        const outcomeState =
          task.state === "draft" || task.state === "running"
            ? "failed"
            : task.state;
        void finishReview(task, run.turn, outcomeState);
        return;
      }
      if (task) {
        deps.activity?.working?.(task.projectId, taskId, null);
        deps.activity?.attention?.(
          task.projectId,
          taskId,
          task.state === "needs-user"
            ? "needs login"
            : task.state === "failed"
              ? "the agent failed"
              : null,
        );
        // Success is the only outcome worth remembering; a failed or cancelled
        // run left nothing done.
        if (task.state === "done") void checkpoint(task, run.turn);
      }
      void persistNow(taskId);
    };

    const finishReview = async (
      task: KodworkTask,
      turn: number,
      outcomeState: "done" | "failed" | "cancelled" | "needs-user",
    ) => {
      try {
        const collected = await deps.ledger!.finish(task);
        const touched = humanChanges.get(task.id) ?? new Set<string>();
        const review = {
          ...collected,
          files: collected.files.map((file) => ({
            ...file,
            humanTouched: [...touched].some((path) => nativeEquals(path, file.path)),
          })),
        };
        humanChanges.delete(task.id);
        patch(task.id, (current) => ({
          ...current,
          review:
            review.files.length > 0
              ? review
              : { ...review, status: "accepted" as const },
          state: review.files.length > 0 ? "needs-user" : outcomeState,
          reviewOutcomeState: review.files.length > 0 ? outcomeState : null,
        }));
        const current = get().tasks[task.id];
        if (!current) return;
        deps.activity?.working?.(current.projectId, current.id, null);
        deps.activity?.attention?.(
          current.projectId,
          current.id,
          review.files.length > 0
            ? "review task output"
            : current.state === "needs-user"
              ? "needs login"
              : current.state === "failed"
                ? "the agent failed"
                : null,
        );
        if (review.files.length === 0) {
          await deps.ledger!.accept(task.id);
          if (current.state === "done") void checkpoint(current, turn);
        }
        void persistNow(current.id);
      } catch (error) {
        patch(task.id, (current) => ({
          ...current,
          state: "failed",
          error: `Could not collect task output: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }));
        const current = get().tasks[task.id];
        if (current) {
          deps.activity?.working?.(current.projectId, current.id, null);
          deps.activity?.attention?.(
            current.projectId,
            current.id,
            "output review failed",
          );
        }
      }
    };

    // The KödMem completion checkpoint. Ids and counts ONLY — the outcome,
    // plan, and summary text never leave this store. Failures are non-fatal.
    const checkpoint = async (task: KodworkTask, turn: number) => {
      if (!deps.memory) return;
      try {
        const workspace = await deps.memory.resolveWorkspace(task.folder);
        if (!workspace) return;
        const done = task.plan.filter((item) => item.status === "completed").length;
        const payload = {
          workspaceId: workspace.id,
          summary: `KödWork task completed: ${done}/${task.plan.length} plan items, ${task.tools.length} tool calls.`,
          decisions: [],
          nextActions: [],
          changedPaths: task.review.files.map((file) => file.relativePath),
          source: "kodade" as const,
          sourceClient: "kodwork" as const,
          sessionId: task.id,
          idempotencyKey: `kodwork:${task.id}:${turn}`,
        };
        if (containsLikelySecret(JSON.stringify(payload))) {
          console.warn(`kodade: KödWork checkpoint blocked by secret scan (${task.id})`);
          return;
        }
        await deps.memory.checkpoint(payload);
      } catch (error) {
        console.error(`kodade: KödWork checkpoint failed (${task.id}):`, error);
      }
    };

    const onLine = (runId: string, line: string) => {
      const taskId = runByRunId.get(runId) ?? taskIdOfRun(runId);
      const run = runs.get(taskId);
      if (!run || run.runId !== runId) return; // a stale/cancelled run
      for (const event of run.parser.line(line)) applyEvent(taskId, run, event);
      persistDebounced(taskId);
    };

    const onExit = (runId: string, code: number | null, stderr: string) => {
      const taskId = runByRunId.get(runId) ?? taskIdOfRun(runId);
      const run = runs.get(taskId);
      if (!run || run.runId !== runId) return;
      for (const event of run.parser.end(code, stderr)) applyEvent(taskId, run, event);
      // `end` always yields a `done`, but settle defensively — a task must
      // never be stuck "running" after its process is gone.
      settle(taskId, run);
    };

    // Shared spawn path for startTask and resumeTask.
    const spawnRun = async (
      taskId: string,
      prompt: string,
      resumeId: string | null,
      resetProgress: boolean,
    ) => {
      if (!enabled()) return;
      const task = get().tasks[taskId];
      if (!task || runs.has(taskId) || !prompt.trim()) return;
      const adapter = adapters(task.providerId);
      if (!adapter) {
        patch(taskId, (current) => ({
          ...current,
          error: `${task.providerId} is not yet supported in KödWork.`,
        }));
        void persistNow(taskId);
        return;
      }
      const cwd = task.folder || deps.projectRoot(task.projectId);
      if (!cwd) return;

      if (deps.ledger) {
        try {
          await deps.ledger.begin(task);
          humanChanges.set(task.id, new Set());
        } catch (error) {
          patch(taskId, (current) => ({
            ...current,
            state: "failed",
            error: `Could not start output ledger: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }));
          return;
        }
      }

      const turn = (turns.get(taskId) ?? 0) + 1;
      turns.set(taskId, turn);
      const runId = `${taskId}#${turn}`;
      const run: Run = {
        runId,
        parser: adapter.createParser(),
        toolLines: new Map(),
        messageText: new Map(),
        thinkingText: new Map(),
        cancelled: false,
        failed: false,
        usage: null,
        turn,
        interactive: false,
        permissionTimer: null,
      };
      runs.set(taskId, run);
      runByRunId.set(runId, taskId);

      patch(taskId, (current) => ({
        ...current,
        state: "running",
        title:
          current.title === DEFAULT_TASK_TITLE
            ? titleFromOutcome(current.outcome)
            : current.title,
        error: null,
        needsLogin: false,
        statusText: null,
        startedAt: now(),
        settledAt: null,
        review: {
          ...current.review,
          status: "collecting",
          feedback: "",
        },
        reviewOutcomeState: null,
        ...(resetProgress
          ? {
              plan: [],
              tools: [],
              summary: null,
              usage: null,
              resumeId: null,
              rejectionFingerprints: [],
              doomLoop: false,
              permissionRequest: null,
              deniedTools: [],
            }
          : {}),
      }));
      deps.activity?.attention?.(task.projectId, taskId, null);
      deps.activity?.working?.(task.projectId, taskId, task.providerId);
      deps.activity?.streamed?.(task.projectId, taskId);
      void persistNow(taskId);

      const spawn = adapter.spawn({
        prompt,
        cwd,
        resumeId,
        model: null,
        access: task.access,
        interactive: true,
      });
      run.interactive = spawn.initialInput !== undefined;
      try {
        await deps.agent.start({
          id: runId,
          cwd,
          bin: spawn.bin,
          args: spawn.args,
          ...(spawn.stdin === undefined ? {} : { stdin: spawn.stdin }),
        });
        if (spawn.initialInput !== undefined) {
          await deps.agent.send({ id: runId, data: spawn.initialInput });
        }
      } catch (error) {
        // The CLI is missing, or the run id collided. Record it and settle so
        // the task is startable again.
        applyEvent(taskId, run, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        settle(taskId, run);
      }
    };

    return {
      tasks: {},
      templates: [],
      templatesLoading: false,
      templatesError: null,
      loaded: {},
      pendingRestore: null,

      async start(): Promise<Unlisten> {
        const offEvent = await deps.agent.onEvent((event) => onLine(event.id, event.line));
        const offExit = await deps.agent.onExit((event) =>
          onExit(event.id, event.code, event.stderr),
        );
        return () => {
          offEvent();
          offExit();
        };
      },

      async openTask(taskId: string, projectId: string) {
        if (!enabled()) return;
        if (!get().tasks[taskId]) {
          set((state) => ({
            tasks: {
              ...state.tasks,
              [taskId]: newTask(
                taskId,
                projectId,
                deps.projectRoot(projectId) ?? "",
                DEFAULT_KODWORK_PROVIDER,
                now(),
              ),
            },
          }));
        }
        if (get().loaded[taskId]) return;
        set((state) => ({ loaded: { ...state.loaded, [taskId]: true } }));
        let raw: string | null = null;
        try {
          raw = await deps.storage.readDoc(kodworkDocName(taskId));
        } catch (error) {
          console.error(`kodade: KödWork task read failed (${taskId}):`, error);
          return;
        }
        if (!raw) return;
        const doc = parsePersistedTask(raw);
        if (!doc) return;
        // A run started while the read was in flight owns the task now.
        if (runs.has(taskId)) return;
        patch(taskId, (task) => ({
          ...task,
          folder: doc.folder || task.folder,
          outcome: doc.outcome,
          title: doc.title,
          providerId: doc.providerId,
          access: doc.access,
          state: doc.state,
          plan: doc.plan,
          tools: doc.tools,
          statusText: doc.statusText,
          summary: doc.summary,
          usage: doc.usage,
          review: doc.review,
          reviewOutcomeState: doc.reviewOutcomeState,
          rejectionFingerprints: doc.rejectionFingerprints,
          doomLoop: doc.doomLoop,
          alwaysAllowedTools: doc.alwaysAllowedTools,
          deniedTools: doc.deniedTools,
          recurrence: doc.recurrence,
          scheduleReceipts: doc.scheduleReceipts,
          scheduledFromTaskId: doc.scheduledFromTaskId,
          resumeId: doc.resumeId,
          error: doc.error,
          needsLogin: doc.needsLogin,
          createdAt: doc.createdAt || task.createdAt,
          startedAt: doc.startedAt,
          settledAt: doc.settledAt,
        }));
      },

      setOutcome(taskId: string, outcome: string) {
        if (runs.has(taskId)) return;
        patch(taskId, (task) =>
          task.outcome === outcome
            ? task
            : {
                ...task,
                outcome,
                // Drafts re-title live; a started task keeps its name.
                title: task.state === "draft" ? titleFromOutcome(outcome) : task.title,
              },
        );
        persistDebounced(taskId);
      },

      setFolder(taskId: string, folder: string) {
        if (runs.has(taskId)) return;
        patch(taskId, (task) => (task.folder === folder ? task : { ...task, folder }));
        persistDebounced(taskId);
      },

      setProvider(taskId: string, providerId: string) {
        if (runs.has(taskId)) return;
        patch(taskId, (task) =>
          task.providerId === providerId
            ? task
            : // Another CLI cannot resume this one's session.
              { ...task, providerId, resumeId: null },
        );
        persistDebounced(taskId);
      },

      setAccess(taskId: string, access: ChatAccessLevel) {
        if (runs.has(taskId)) return;
        patch(taskId, (task) => (task.access === access ? task : { ...task, access }));
        persistDebounced(taskId);
      },

      async loadTemplates(taskId: string) {
        const task = get().tasks[taskId];
        if (!task || !deps.templates) return;
        set({ templatesLoading: true, templatesError: null });
        try {
          const templates = await deps.templates.list(task.folder, task.providerId);
          set({ templates, templatesLoading: false });
        } catch (error) {
          set({
            templates: [],
            templatesLoading: false,
            templatesError: error instanceof Error ? error.message : String(error),
          });
        }
      },

      applyTemplate(taskId: string, templateId: string) {
        if (runs.has(taskId)) return;
        const template = get().templates.find((candidate) => candidate.id === templateId);
        if (!template) return;
        patch(taskId, (task) => {
          const outcome = templatePrompt(template, task.folder);
          return { ...task, outcome, title: titleFromOutcome(outcome) };
        });
        persistDebounced(taskId);
      },

      setRecurrence(taskId: string, recurrence: KodworkRecurrenceInput | null) {
        if (runs.has(taskId)) return;
        patch(taskId, (task) => ({
          ...task,
          recurrence: recurrence ? recurrenceFromInput(recurrence, now()) : null,
        }));
        persistDebounced(taskId);
      },

      async reconcileSchedules(at = now()) {
        for (const task of Object.values(get().tasks)) {
          if (!task.recurrence) continue;
          let recurrence = task.recurrence;
          const receipts: KodworkScheduleReceipt[] = [];
          let count = 0;
          while (recurrence.nextRunAt <= at && count < 100) {
            receipts.push({
              scheduledFor: recurrence.nextRunAt,
              recordedAt: at,
              status: "missed" as const,
              sessionId: null,
              message: "missed — Ködade was not running",
            });
            recurrence = advanceRecurrence(recurrence);
            count += 1;
          }
          if (receipts.length === 0) continue;
          if (recurrence.nextRunAt <= at) {
            recurrence = {
              ...recurrence,
              nextRunAt: nextRecurrenceAt(recurrence, at),
            };
          }
          patch(task.id, (current) => ({
            ...current,
            recurrence,
            scheduleReceipts: [...current.scheduleReceipts, ...receipts].slice(-100),
          }));
          await persistNow(task.id);
        }
      },

      async tickSchedules(at = now()) {
        const due = Object.values(get().tasks).filter(
          (task) => task.recurrence && task.recurrence.nextRunAt <= at,
        );
        for (const source of due) {
          let nextRecurrence = source.recurrence!;
          const dueSlots: number[] = [];
          while (nextRecurrence.nextRunAt <= at && dueSlots.length < 100) {
            dueSlots.push(nextRecurrence.nextRunAt);
            nextRecurrence = advanceRecurrence(nextRecurrence);
          }
          if (nextRecurrence.nextRunAt <= at) {
            nextRecurrence = {
              ...nextRecurrence,
              nextRunAt: nextRecurrenceAt(nextRecurrence, at),
            };
          }
          const scheduledFor = dueSlots.at(-1)!;
          const sessionId = source.outcome.trim()
            ? (deps.createScheduledSession?.(source.projectId) ?? null)
            : null;
          const receipt = sessionId
            ? {
                scheduledFor,
                recordedAt: at,
                status: "started" as const,
                sessionId,
                message: "started while Ködade was running",
              }
            : {
                scheduledFor,
                recordedAt: at,
                status: "missed" as const,
                sessionId: null,
                message: source.outcome.trim()
                  ? "missed — task session could not be created"
                  : "missed — task outcome is empty",
              };
          patch(source.id, (current) => ({
            ...current,
            recurrence: current.recurrence ? nextRecurrence : null,
            scheduleReceipts: [
              ...current.scheduleReceipts,
              ...dueSlots.slice(0, -1).map((slot) => ({
                scheduledFor: slot,
                recordedAt: at,
                status: "missed" as const,
                sessionId: null,
                message: "missed — Ködade could not run this slot on time",
              })),
              receipt,
            ].slice(-100),
          }));
          await persistNow(source.id);
          if (!sessionId) continue;
          const scheduled = {
            ...newTask(
              sessionId,
              source.projectId,
              source.folder,
              source.providerId,
              at,
            ),
            outcome: source.outcome,
            title: source.title,
            access: source.access,
            scheduledFromTaskId: source.id,
          };
          set((state) => ({
            tasks: { ...state.tasks, [sessionId]: scheduled },
            loaded: { ...state.loaded, [sessionId]: true },
          }));
          await persistNow(sessionId);
          await spawnRun(sessionId, scheduled.outcome, null, true);
        }
      },

      async startTask(taskId: string) {
        const task = get().tasks[taskId];
        if (!task) return;
        // A fresh run starts a new CLI session and a fresh progress view.
        await spawnRun(taskId, task.outcome, null, true);
      },

      async resumeTask(taskId: string, instruction?: string) {
        const task = get().tasks[taskId];
        if (!task) return;
        if (!task.resumeId) return get().startTask(taskId);
        // A resumed run keeps the progress it already earned.
        await spawnRun(
          taskId,
          instruction?.trim() || RESUME_PROMPT,
          task.resumeId,
          false,
        );
      },

      async cancelTask(taskId: string) {
        const run = runs.get(taskId);
        if (!run) return;
        run.cancelled = true;
        try {
          await deps.agent.cancel({ id: run.runId });
        } catch (error) {
          console.error(`kodade: KödWork cancel failed (${taskId}):`, error);
        }
        // The exit event still arrives and settles the task as cancelled.
      },

      setReviewFeedback(taskId: string, feedback: string) {
        patch(taskId, (task) => ({
          ...task,
          review: { ...task.review, feedback },
        }));
        persistDebounced(taskId);
      },

      async acceptReview(taskId: string) {
        const task = get().tasks[taskId];
        if (!task || task.review.status !== "pending" || !deps.ledger) return;
        await deps.ledger.accept(taskId);
        patch(taskId, (current) => ({
          ...current,
          state: current.reviewOutcomeState ?? "done",
          reviewOutcomeState: null,
          review: {
            ...current.review,
            status: "accepted",
            files: [],
            feedback: "",
          },
        }));
        const accepted = get().tasks[taskId];
        deps.activity?.attention?.(
          task.projectId,
          taskId,
          accepted?.state === "needs-user"
            ? "needs login"
            : accepted?.state === "failed"
              ? "the agent failed"
              : null,
        );
        if (accepted?.state === "done") {
          await checkpoint(task, turns.get(taskId) ?? 1);
        }
        await persistNow(taskId);
      },

      async rejectReview(taskId: string) {
        const task = get().tasks[taskId];
        if (!task || task.review.status !== "pending" || !deps.ledger) return;
        const fingerprint = task.review.fingerprint;
        const history = fingerprint
          ? [...task.rejectionFingerprints, fingerprint].slice(-DOOM_LOOP_REJECTIONS)
          : task.rejectionFingerprints;
        if (
          history.length === DOOM_LOOP_REJECTIONS &&
          history.every((value) => value === history[0])
        ) {
          patch(taskId, (current) => ({
            ...current,
            rejectionFingerprints: history,
            doomLoop: true,
            error: "This task produced the same output three times. Review the approach before spending more tokens.",
          }));
          deps.activity?.attention?.(task.projectId, taskId, "task may be looping");
          await persistNow(taskId);
          return;
        }
        patch(taskId, (current) => ({
          ...current,
          rejectionFingerprints: history,
        }));
        const prompt = await deps.ledger.compileFeedback(task.review);
        await spawnRun(taskId, prompt, task.resumeId, false);
      },

      async prepareRestore(taskId: string) {
        const task = get().tasks[taskId];
        if (!task || task.review.status !== "pending" || !deps.ledger) return;
        set({ pendingRestore: await deps.ledger.prepareRestore(task) });
      },

      async confirmRestore(taskId: string) {
        const task = get().tasks[taskId];
        const plan = get().pendingRestore;
        if (!task || !plan || plan.taskId !== taskId || !deps.ledger) return;
        patch(taskId, (current) => ({
          ...current,
          review: { ...current.review, status: "restoring" },
        }));
        const result = await deps.ledger.applyRestore(plan);
        if (!result.ok) {
          await deps.ledger.rollbackRestore(plan);
          patch(taskId, (current) => ({
            ...current,
            review: { ...current.review, status: "restore-failed" },
            error: `Restore verification failed: ${result.reason}`,
          }));
          set({ pendingRestore: null });
          return;
        }
        patch(taskId, (current) => ({
          ...current,
          state: "cancelled",
          review: { ...EMPTY_KODWORK_REVIEW },
        }));
        set({ pendingRestore: null });
        await persistNow(taskId);
      },

      cancelRestore(taskId: string) {
        if (get().pendingRestore?.taskId === taskId) {
          set({ pendingRestore: null });
        }
      },

      noteHumanChange(path: string) {
        for (const [taskId, run] of runs) {
          const task = get().tasks[taskId];
          if (!task || run.cancelled) continue;
          if (nativeEquals(path, task.folder) || nativeIsDescendant(path, task.folder)) {
            const touched = humanChanges.get(taskId) ?? new Set<string>();
            touched.add(path);
            humanChanges.set(taskId, touched);
          }
        }
      },

      async respondPermission(taskId, decision) {
        const run = runs.get(taskId);
        const task = get().tasks[taskId];
        const request = task?.permissionRequest;
        if (!run || !task || !request || !run.interactive) return;
        if (run.permissionTimer) {
          clearTimer(run.permissionTimer);
          run.permissionTimer = null;
        }
        try {
          await deps.agent.send({
            id: run.runId,
            data: encodeClaudePermissionResponse(request, decision),
          });
          patch(taskId, (current) => ({
            ...current,
            state: "running",
            permissionRequest: null,
            alwaysAllowedTools:
              decision === "always" && !current.alwaysAllowedTools.includes(request.tool)
                ? [...current.alwaysAllowedTools, request.tool].slice(-100)
                : current.alwaysAllowedTools,
          }));
          deps.activity?.attention?.(task.projectId, taskId, null);
          persistDebounced(taskId);
        } catch (error) {
          run.failed = true;
          patch(taskId, (current) => ({
            ...current,
            error: `Could not answer permission request: ${error instanceof Error ? error.message : String(error)}`,
          }));
        }
      },

      async steerTask(taskId, message) {
        const run = runs.get(taskId);
        if (!run?.interactive || !message.trim()) return;
        await deps.agent.send({
          id: run.runId,
          data: encodeClaudeUserMessage(message.trim()),
        });
      },

      async removeTask(taskId: string) {
        const handle = pending.get(taskId);
        if (handle) {
          clearTimer(handle);
          pending.delete(taskId);
        }
        const run = runs.get(taskId);
        if (run) {
          runs.delete(taskId);
          runByRunId.delete(run.runId);
          try {
            await deps.agent.cancel({ id: run.runId });
          } catch {
            // Already gone: removal must still complete.
          }
        }
        if (deps.ledger) {
          try {
            await deps.ledger.accept(taskId);
          } catch {
            // Drafts and already-finalized tasks have no active ledger.
          }
        }
        turns.delete(taskId);
        humanChanges.delete(taskId);
        set((state) => {
          const tasks = { ...state.tasks };
          const loaded = { ...state.loaded };
          delete tasks[taskId];
          delete loaded[taskId];
          return { tasks, loaded };
        });
        try {
          await deps.storage.deleteDoc(kodworkDocName(taskId));
        } catch (error) {
          console.error(`kodade: KödWork task delete failed (${taskId}):`, error);
        }
      },

      async flush(taskId: string) {
        const handle = pending.get(taskId);
        if (handle) {
          clearTimer(handle);
          pending.delete(taskId);
        }
        await persistNow(taskId);
      },
    };
  });

  return store;
}
