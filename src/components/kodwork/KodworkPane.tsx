// KödWork's task detail tab (#43): the composer for a draft, and a PROGRESS
// view — plan items, tool-call lines, live status, final summary, usage — for
// a started task. Deliberately not a chat transcript surface; conversation
// belongs to KödChat.
//
// Reuses the KödChat composer idioms (rounded input surface, ComposerMenu
// chips) so the two agent surfaces read as one design language.

import { useStore } from "zustand";
import { useEffect, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { appStore, filesStore, kodworkStore, reviewStore } from "../../store/appStore";
import type { KodworkState } from "../../kodwork/store";
import {
  projectedCadenceTokens,
  type KodworkRecurrence,
  type KodworkRecurrenceInput,
  type KodworkTask,
  type KodworkToolLine,
} from "../../kodwork/model";
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
  const templates = useStore(workStore, (state) => state.templates);
  const templatesLoading = useStore(workStore, (state) => state.templatesLoading);
  const templatesError = useStore(workStore, (state) => state.templatesError);
  const canStart = task.outcome.trim().length > 0 && !!provider;

  useEffect(() => {
    void workStore.getState().loadTemplates(task.id);
  }, [task.id, task.providerId, workStore]);

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-sm font-semibold text-text">New KödWork task</h1>
      <p className="mt-1 text-xs text-text-dim">
        Describe the outcome. The agent works in the background with your own
        installed CLI; progress and results land here.
      </p>

      <div className="mt-4 rounded-xl border border-border bg-surface focus-within:border-accent/70">
        <textarea
          data-voice-target="kodwork-outcome"
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
        {templates.length > 0 && (
          <ComposerMenu
            label="Task template"
            value=""
            onSelect={(id) => workStore.getState().applyTemplate(task.id, id)}
            options={templates.map((template) => ({
              id: template.id,
              label: template.name,
              description: template.description,
            }))}
          >
            <span>Skill template</span>
          </ComposerMenu>
        )}
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
      {templatesLoading && <p className="mt-2 text-[10px] text-text-dim">Loading installed skill templates…</p>}
      {templatesError && <p className="mt-2 text-[10px] text-text-dim">Skill templates unavailable: {templatesError}</p>}
      <ScheduleEditor task={task} workStore={workStore} />
      {task.error && (
        <p className="mt-3 text-xs text-[var(--kd-error)]">{task.error}</p>
      )}

      {task.deniedTools.length > 0 && (
        <section className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/5 px-3 py-2">
          <h2 className="text-[10px] uppercase tracking-[0.12em] text-amber-400">Denied tools</h2>
          {task.deniedTools.map((item, index) => <p key={`${item.tool}:${index}`} className="mt-1 break-all text-xs text-text">{item.tool}{item.detail ? ` · ${item.detail}` : ""}</p>)}
          {task.access !== "full" && <p className="mt-1 text-[10px] text-text-dim">Choose a broader access level before resuming if this operation is expected.</p>}
        </section>
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
  const live = running || task.permissionRequest !== null;
  const pendingRestore = useStore(workStore, (state) => state.pendingRestore);
  const reviewing = task.review.status === "pending";
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
        {live ? (
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
            disabled={task.needsLogin || reviewing}
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

      {!running && <ScheduleEditor task={task} workStore={workStore} />}

      {task.scheduleReceipts.length > 0 && (
        <section className="mt-4">
          <h2 className="text-[10px] uppercase tracking-[0.12em] text-text-dim">Schedule receipts</h2>
          <ul className="mt-1 space-y-1 text-[10px] text-text-dim">
            {task.scheduleReceipts.slice(-5).reverse().map((receipt) => (
              <li key={`${receipt.scheduledFor}:${receipt.status}`}>
                {new Date(receipt.scheduledFor).toLocaleString()} · {receipt.message}
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {task.permissionRequest && (
        <PermissionPrompt task={task} workStore={workStore} />
      )}

      {running && <Steering task={task} workStore={workStore} />}

      {reviewing && (
        <OutputReview task={task} workStore={workStore} />
      )}

      {pendingRestore?.taskId === task.id && (
        <section
          role="dialog"
          aria-label="Restore task output"
          className="mt-4 rounded-lg border border-red-400/40 bg-red-400/5 px-3 py-2"
        >
          <p className="text-xs text-text">
            Restore {pendingRestore.files.length} changed file
            {pendingRestore.files.length === 1 ? "" : "s"} to the pre-task snapshot?
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void workStore.getState().confirmRestore(task.id)} className="rounded bg-red-500 px-2.5 py-1 text-xs text-white">Restore</button>
            <button type="button" onClick={() => workStore.getState().cancelRestore(task.id)} className="rounded border border-border px-2.5 py-1 text-xs text-text">Cancel</button>
          </div>
        </section>
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

function ScheduleEditor({ task, workStore }: { task: KodworkTask; workStore: StoreApi<KodworkState> }) {
  const tasks = useStore(workStore, (state) => state.tasks);
  const [kind, setKind] = useState<"none" | "interval" | "daily">(
    task.recurrence?.kind ?? "none",
  );
  const [minutes, setMinutes] = useState(
    task.recurrence?.kind === "interval" ? String(task.recurrence.minutes) : "60",
  );
  const [dailyTime, setDailyTime] = useState(
    task.recurrence?.kind === "daily"
      ? `${String(task.recurrence.hour).padStart(2, "0")}:${String(task.recurrence.minute).padStart(2, "0")}`
      : "09:00",
  );

  useEffect(() => {
    setKind(task.recurrence?.kind ?? "none");
  }, [task.recurrence?.kind]);

  const candidate: KodworkRecurrenceInput | null =
    kind === "interval"
      ? { kind, minutes: Math.min(43_200, Math.max(5, Number(minutes) || 5)) }
      : kind === "daily"
        ? (() => {
            const [hour = 9, minute = 0] = dailyTime.split(":").map(Number);
            return { kind, hour, minute };
          })()
        : null;
  const projected = candidate
    ? projectedCadenceTokens(tasks, task.id, {
        ...candidate,
        nextRunAt: Date.now(),
      } as KodworkRecurrence)
    : null;

  return (
    <section className="mt-4 rounded-lg border border-border bg-surface px-3 py-2" aria-label="Task schedule">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[10px] uppercase tracking-[0.12em] text-text-dim" htmlFor={`kodwork-schedule-${task.id}`}>Schedule</label>
        <select id={`kodwork-schedule-${task.id}`} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="rounded border border-border bg-bg px-2 py-1 text-xs text-text">
          <option value="none">Not recurring</option>
          <option value="interval">Interval</option>
          <option value="daily">Daily</option>
        </select>
        {kind === "interval" && <input aria-label="Interval minutes" type="number" min={5} max={43200} value={minutes} onChange={(event) => setMinutes(event.target.value)} className="w-24 rounded border border-border bg-bg px-2 py-1 text-xs text-text" />}
        {kind === "interval" && <span className="text-xs text-text-dim">minutes</span>}
        {kind === "daily" && <input aria-label="Daily time" type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} className="rounded border border-border bg-bg px-2 py-1 text-xs text-text" />}
        <button type="button" onClick={() => workStore.getState().setRecurrence(task.id, candidate)} className="ml-auto rounded border border-border px-2.5 py-1 text-xs text-text hover:bg-surface-hover">
          {candidate ? (task.recurrence ? "Update" : "Enable") : "Disable"}
        </button>
      </div>
      {projected && (
        <p className="mt-1 text-[10px] tabular-nums text-text-dim">
          Projected: {projected.totalTokens.toLocaleString()} tokens / 30 days · {projected.runsPer30Days} runs · {projected.averagePerRun.toLocaleString()} average
        </p>
      )}
      {task.recurrence && (
        <p className="mt-1 text-[10px] text-text-dim">Next run while Ködade is open: {new Date(task.recurrence.nextRunAt).toLocaleString()}</p>
      )}
    </section>
  );
}

function PermissionPrompt({ task, workStore }: { task: KodworkTask; workStore: StoreApi<KodworkState> }) {
  const request = task.permissionRequest!;
  const detail = request.title ?? request.description ?? `${request.tool} wants permission to continue.`;
  const metadata = [
    typeof request.input.command === "string" ? request.input.command : null,
    typeof request.input.path === "string" ? request.input.path : request.blockedPath,
    typeof request.input.cwd === "string" ? request.input.cwd : null,
  ].filter(Boolean).join(" · ");
  return (
    <section role="dialog" aria-label="Tool permission" className="mt-4 rounded-lg border border-amber-400/50 bg-amber-400/5 px-3 py-2">
      <h2 className="text-[10px] uppercase tracking-[0.12em] text-amber-400">Permission needed</h2>
      <p className="mt-1 text-xs text-text">{detail}</p>
      {metadata && <p className="mt-1 break-all font-mono text-[10px] text-text-dim">{metadata}</p>}
      <p className="mt-1 text-[10px] text-text-dim">Automatically denied after 60 seconds.</p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => void workStore.getState().respondPermission(task.id, "deny")} className="rounded border border-border px-2.5 py-1 text-xs text-text">Deny</button>
        <button type="button" onClick={() => void workStore.getState().respondPermission(task.id, "once")} className="rounded border border-border px-2.5 py-1 text-xs text-text">Allow once</button>
        {request.suggestions.length > 0 && <button type="button" onClick={() => void workStore.getState().respondPermission(task.id, "always")} className="rounded bg-accent px-2.5 py-1 text-xs text-accent-text">Always allow this operation</button>}
      </div>
    </section>
  );
}

function Steering({ task, workStore }: { task: KodworkTask; workStore: StoreApi<KodworkState> }) {
  const [message, setMessage] = useState("");
  return (
    <form className="mt-4 flex gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (!message.trim()) return;
      void workStore.getState().steerTask(task.id, message);
      setMessage("");
    }}>
      <input aria-label="Steer task" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Redirect this task…" className="min-w-0 flex-1 rounded border border-border bg-surface px-2.5 py-1.5 text-xs text-text focus:border-accent/70 focus:outline-none" />
      <button type="submit" disabled={!message.trim()} className="rounded border border-border px-2.5 py-1 text-xs text-text disabled:opacity-40">Send</button>
    </form>
  );
}

function OutputReview({
  task,
  workStore,
}: {
  task: KodworkTask;
  workStore: StoreApi<KodworkState>;
}) {
  return (
    <section className="mt-4 rounded-lg border border-accent/40 bg-surface px-3 py-2" aria-label="Output review">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[10px] uppercase tracking-[0.12em] text-text-dim">Output review</h2>
        <span className="text-[10px] text-text-dim">{task.review.files.length} changed</span>
      </div>
      <ul className="mt-2 space-y-2">
        {task.review.files.map((file) => (
          <li key={`${file.change}:${file.relativePath}`} className="rounded border border-border px-2 py-1.5 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <span className={file.bucket === "risky" ? "text-red-400" : file.bucket === "routine" ? "text-amber-400" : "text-text-dim"}>{file.bucket}</span>
              <button type="button" className="min-w-0 flex-1 truncate text-left text-text hover:underline" title={file.path} onClick={() => void filesStore.getState().selectFile(file.path)}>{file.relativePath}</button>
              <span className="shrink-0 text-text-dim">{file.change}</span>
            </div>
            {file.humanTouched && <p className="mt-1 text-[10px] text-amber-400">Changed by you during this task</p>}
            {file.reasons.length > 0 && <p className="mt-1 text-[10px] text-text-dim">{file.reasons.join(" · ")}</p>}
            {!file.binary && (file.before !== null || file.after !== null) && (
              <details className="mt-1 text-[10px] text-text-dim">
                <summary className="cursor-pointer">Before / after</summary>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg p-1.5">{file.before ?? "(new file)"}</pre>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg p-1.5">{file.after ?? "(deleted)"}</pre>
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
      <textarea
        aria-label="Review feedback"
        value={task.review.feedback}
        onChange={(event) => workStore.getState().setReviewFeedback(task.id, event.target.value)}
        placeholder="Feedback for another pass"
        rows={3}
        className="mt-2 w-full resize-none rounded border border-border bg-bg px-2 py-1.5 text-xs text-text placeholder:text-text-dim focus:border-accent/70 focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {task.review.kind === "git" && <button type="button" onClick={() => {
          void reviewStore.getState().openWorktree(task.folder).then(() => {
            filesStore.getState().openReviewTab();
          });
        }} className="rounded border border-border px-2.5 py-1 text-xs text-text">Open full diff</button>}
        {task.review.kind === "folder" && <button type="button" onClick={() => void workStore.getState().prepareRestore(task.id)} className="rounded border border-border px-2.5 py-1 text-xs text-text">Restore output</button>}
        <button type="button" onClick={() => void workStore.getState().rejectReview(task.id)} className="rounded border border-border px-2.5 py-1 text-xs text-text">Reject &amp; continue</button>
        <button type="button" onClick={() => void workStore.getState().acceptReview(task.id)} className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-accent-text">Accept</button>
      </div>
    </section>
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
