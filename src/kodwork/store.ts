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
import type { ChatAccessLevel } from "../providers/catalog";
import {
  MAX_PLAN_ITEMS,
  MAX_TOOL_LINES,
  clampStatus,
  clampSummary,
  kodworkDocName,
  newTask,
  parsePersistedTask,
  titleFromOutcome,
  toPersistedTask,
  toolDetail,
  DEFAULT_TASK_TITLE,
  type KodworkTask,
} from "./model";

// New tasks default to Claude Code; the composer can pick any streaming CLI.
export const DEFAULT_KODWORK_PROVIDER = "claude";

// What a run without an explicit instruction resumes with.
const RESUME_PROMPT = "Continue working toward the outcome.";

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
  // KödWork is a development feature. When disabled the store refuses to
  // register or run anything, matching the compiled-out public surface.
  enabled?: () => boolean;
  newId?: () => string;
  now?: () => number;
  activity?: KodworkActivityHooks;
  // Debounce for task-document writes; a streaming run reports many events.
  persistDebounceMs?: number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
};

export type KodworkState = {
  tasks: Record<string, KodworkTask>;
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
  // Run the task fresh. Resolves once the run has STARTED — progress arrives
  // through the event stream.
  startTask(taskId: string): Promise<void>;
  // Continue a settled/needs-user task on the CLI's saved session. Falls back
  // to a fresh start when no resume id was captured.
  resumeTask(taskId: string, instruction?: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
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
  };
  const runs = new Map<string, Run>();
  const runByRunId = new Map<string, string>(); // runId → taskId
  const turns = new Map<string, number>();

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
        case "error":
          run.failed = true;
          patch(taskId, (current) => ({ ...current, error: event.message }));
          return;
        case "done":
          run.usage = event.usage ?? null;
          settle(taskId, run);
          return;
      }
    };

    // Close out a run: decide the terminal state, notify the inbox, persist,
    // and (on success only) write the KödMem completion checkpoint.
    const settle = (taskId: string, run: Run) => {
      if (runs.get(taskId)?.runId !== run.runId) return;
      runs.delete(taskId);
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
        usage: run.usage ?? task.usage,
        settledAt: now(),
      }));
      const task = get().tasks[taskId];
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

    // The KödMem completion checkpoint. Ids and counts ONLY — the outcome,
    // plan, and summary text never leave this store. Failures are non-fatal.
    const checkpoint = async (task: KodworkTask, turn: number) => {
      if (!deps.memory) return;
      try {
        const workspace = await deps.memory.resolveWorkspace(task.folder);
        if (!workspace) return;
        const done = task.plan.filter((item) => item.status === "completed").length;
        await deps.memory.checkpoint({
          workspaceId: workspace.id,
          summary: `KödWork task completed: ${done}/${task.plan.length} plan items, ${task.tools.length} tool calls.`,
          decisions: [],
          nextActions: [],
          changedPaths: [],
          source: "kodade",
          sourceClient: "kodwork",
          sessionId: task.id,
          idempotencyKey: `kodwork:${task.id}:${turn}`,
        });
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
        ...(resetProgress
          ? { plan: [], tools: [], summary: null, usage: null, resumeId: null }
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
      });
      try {
        await deps.agent.start({
          id: runId,
          cwd,
          bin: spawn.bin,
          args: spawn.args,
          ...(spawn.stdin === undefined ? {} : { stdin: spawn.stdin }),
        });
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
      loaded: {},

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
        turns.delete(taskId);
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
