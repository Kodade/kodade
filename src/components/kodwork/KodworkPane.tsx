// KödWork's task detail tab (#43): the composer for a draft, and a PROGRESS
// view — plan items, tool-call lines, live status, final summary, usage — for
// a started task. Deliberately not a chat transcript surface; conversation
// belongs to KödChat.
//
// Reuses the KödChat composer idioms (rounded input surface, ComposerMenu
// chips) so the two agent surfaces read as one design language.

import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { appStore, kodworkStore } from "../../store/appStore";
import type { KodworkState } from "../../kodwork/store";
import type { KodworkTask, KodworkToolLine } from "../../kodwork/model";
import type { AgentPlanItem } from "../../agents/contract";
import {
  ACCESS_LEVELS,
  AVAILABLE_PROVIDERS,
  type ChatAccessLevel,
} from "../../providers/catalog";
import { ComposerMenu } from "../chat/ComposerMenu";
import { ProviderLogo } from "../chat/ProviderLogo";

// Only CLIs with a verified headless stream can run a background task; Ollama
// (HTTP chat, no tool loop) is intentionally absent.
const TASK_PROVIDERS = AVAILABLE_PROVIDERS.filter(
  (provider) => provider.stream !== undefined,
);

const STATE_LABEL: Record<KodworkTask["state"], string> = {
  draft: "Draft",
  running: "Working",
  "needs-user": "Needs you",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATE_CLASS: Record<KodworkTask["state"], string> = {
  draft: "text-text-dim",
  running: "text-accent",
  "needs-user": "text-red-400",
  done: "text-[var(--kd-success)]",
  failed: "text-[var(--kd-error)]",
  cancelled: "text-text-dim",
};

export function KodworkPane({
  taskId,
  workStore = kodworkStore,
}: {
  taskId: string;
  workStore?: StoreApi<KodworkState>;
}) {
  const task = useStore(workStore, (s) => s.tasks[taskId]);

  if (!task) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <p className="text-sm text-text-dim">This KödWork task is no longer open.</p>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col overflow-y-auto bg-bg">
      {task.state === "draft" ? (
        <TaskComposer task={task} workStore={workStore} />
      ) : (
        <TaskProgress task={task} workStore={workStore} />
      )}
    </div>
  );
}

// --- Draft composer ---

function TaskComposer({
  task,
  workStore,
}: {
  task: KodworkTask;
  workStore: StoreApi<KodworkState>;
}) {
  const projectPath = useStore(
    appStore,
    (s) => s.projects.find((project) => project.id === task.projectId)?.path ?? null,
  );
  const provider = TASK_PROVIDERS.find((entry) => entry.id === task.providerId);
  const accessLevel = ACCESS_LEVELS.find((level) => level.id === task.access);
  const canStart = task.outcome.trim().length > 0 && !!provider;

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-sm font-semibold text-text">New KödWork task</h1>
      <p className="mt-1 text-xs text-text-dim">
        Describe the outcome. The agent works in the background with your own
        installed CLI; progress and results land here.
      </p>

      <div className="mt-4 rounded-xl border border-border bg-surface focus-within:border-accent/70">
        <textarea
          value={task.outcome}
          onChange={(event) =>
            workStore.getState().setOutcome(task.id, event.target.value)
          }
          rows={6}
          aria-label="Outcome"
          placeholder="What should be true when this task is done?"
          className="w-full resize-none bg-transparent px-3.5 py-3 text-sm text-text placeholder:text-text-dim focus:outline-none"
        />
      </div>

      <label className="mt-3 block text-[11px] text-text-dim" htmlFor="kodwork-folder">
        Folder
      </label>
      <input
        id="kodwork-folder"
        type="text"
        value={task.folder}
        onChange={(event) => workStore.getState().setFolder(task.id, event.target.value)}
        placeholder={projectPath ?? "Project root"}
        spellCheck={false}
        className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-text placeholder:text-text-dim focus:border-accent/70 focus:outline-none"
      />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <ComposerMenu
          label="Provider"
          value={task.providerId}
          onSelect={(id) => workStore.getState().setProvider(task.id, id)}
          options={TASK_PROVIDERS.map((entry) => ({
            id: entry.id,
            label: entry.name,
            icon: <ProviderLogo providerId={entry.id} size={20} />,
          }))}
        >
          <ProviderLogo providerId={task.providerId} size={18} />
          <span className="max-w-[130px] truncate">
            {provider?.name ?? task.providerId}
          </span>
        </ComposerMenu>
        <ComposerMenu
          label="Access level"
          value={task.access}
          onSelect={(id) =>
            workStore.getState().setAccess(task.id, id as ChatAccessLevel)
          }
          options={ACCESS_LEVELS.map((level) => ({
            id: level.id,
            label: level.label,
            description: level.description,
          }))}
          menuWidthClass="min-w-[260px]"
        >
          <span>{accessLevel?.label}</span>
        </ComposerMenu>
        <div className="flex-1" />
        <button
          type="button"
          disabled={!canStart}
          onClick={() => void workStore.getState().startTask(task.id)}
          className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-text hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-accent"
        >
          Start task
        </button>
      </div>
      {task.error && (
        <p className="mt-3 text-xs text-[var(--kd-error)]">{task.error}</p>
      )}
    </div>
  );
}

// --- Progress view ---

function TaskProgress({
  task,
  workStore,
}: {
  task: KodworkTask;
  workStore: StoreApi<KodworkState>;
}) {
  const running = task.state === "running";
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-text">{task.title}</h1>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs">
            <span className={STATE_CLASS[task.state]}>
              {running && (
                <span
                  aria-hidden="true"
                  className="kd-dot-pulse mr-1 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle"
                />
              )}
              {STATE_LABEL[task.state]}
            </span>
            <span className="truncate text-text-dim" title={task.folder}>
              · {task.folder}
            </span>
          </p>
        </div>
        {running ? (
          <button
            type="button"
            onClick={() => void workStore.getState().cancelTask(task.id)}
            className="shrink-0 rounded border border-border px-2.5 py-1 text-xs text-text hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void workStore.getState().resumeTask(task.id)}
            disabled={task.needsLogin}
            title={
              task.needsLogin
                ? "Log the CLI in through a terminal first"
                : "Continue this task"
            }
            className="shrink-0 rounded border border-border px-2.5 py-1 text-xs text-text hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            Resume
          </button>
        )}
      </div>

      {/* The outcome the agent is working toward. */}
      <section className="mt-4 rounded-lg border border-border bg-surface px-3 py-2">
        <h2 className="text-[10px] uppercase tracking-[0.12em] text-text-dim">
          Outcome
        </h2>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-text">
          {task.outcome}
        </p>
      </section>

      {task.plan.length > 0 && (
        <section className="mt-4">
          <h2 className="text-[10px] uppercase tracking-[0.12em] text-text-dim">Plan</h2>
          <ul className="mt-1 space-y-1">
            {task.plan.map((item, index) => (
              <PlanRow key={index} item={item} />
            ))}
          </ul>
        </section>
      )}

      {task.tools.length > 0 && (
        <section className="mt-4">
          <h2 className="text-[10px] uppercase tracking-[0.12em] text-text-dim">
            Tool activity
          </h2>
          <ul className="mt-1 space-y-0.5">
            {task.tools.map((line) => (
              <ToolRow key={line.id} line={line} />
            ))}
          </ul>
        </section>
      )}

      {running && task.statusText && (
        <p
          data-testid="kodwork-status"
          className="mt-4 flex items-center gap-1.5 text-xs text-text-dim"
        >
          <span
            aria-hidden="true"
            className="kd-dot-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
          <span className="min-w-0 truncate">{task.statusText}</span>
        </p>
      )}

      {task.error && (
        <p className="mt-4 whitespace-pre-wrap break-words text-xs text-[var(--kd-error)]">
          {task.error}
        </p>
      )}

      {task.summary && (
        <section className="mt-4 rounded-lg border border-border bg-surface px-3 py-2">
          <h2 className="text-[10px] uppercase tracking-[0.12em] text-text-dim">
            Summary
          </h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-text">
            {task.summary}
          </p>
        </section>
      )}

      {task.usage && (
        <p className="mt-4 text-[11px] tabular-nums text-text-dim" data-testid="kodwork-usage">
          Tokens: {task.usage.promptTokens.toLocaleString()} prompt ·{" "}
          {task.usage.completionTokens.toLocaleString()} completion ·{" "}
          {task.usage.totalTokens.toLocaleString()} total
        </p>
      )}
    </div>
  );
}

function PlanRow({ item }: { item: AgentPlanItem }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        aria-hidden="true"
        className={`mt-1 h-2 w-2 shrink-0 rounded-full border ${
          item.status === "completed"
            ? "border-accent bg-accent"
            : item.status === "in-progress"
              ? "kd-dot-pulse border-accent bg-accent/40"
              : "border-border bg-transparent"
        }`}
      />
      <span
        className={`min-w-0 break-words ${
          item.status === "completed" ? "text-text-dim line-through" : "text-text"
        }`}
      >
        {item.text}
      </span>
      <span className="sr-only">{item.status}</span>
    </li>
  );
}

function ToolRow({ line }: { line: KodworkToolLine }) {
  return (
    <li className="flex items-center gap-2 text-xs text-text-dim">
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          line.ok === null
            ? "kd-dot-pulse bg-accent"
            : line.ok
              ? "bg-text-dim/40"
              : "bg-red-400"
        }`}
      />
      <span className="shrink-0 font-medium text-text">{line.tool}</span>
      {line.detail && <span className="min-w-0 truncate">{line.detail}</span>}
      {line.ok === false && <span className="sr-only">failed</span>}
    </li>
  );
}
