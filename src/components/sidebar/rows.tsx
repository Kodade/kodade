// Shared sidebar rows: the project disclosure group, chat thread rows, task
// rows, and terminal rows.
//
// Extracted from ChatThreadsSection.tsx and KodworkSection.tsx (issue #62) so
// the v1 sections and the v2 Workspaces sidebar render exactly the same rows.
// Both originals re-export from here, so existing importers are unaffected.

import { useRef, useState, type ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import { DEFAULT_TITLE, type ChatThread } from "../../chat/model";
import { DEFAULT_TASK_TITLE, taskGroup, type KodworkTask } from "../../kodwork/model";
import type { WorkspaceGroupKind } from "../../activity/activity";
import type { ProjectsState, SessionMeta } from "../../store/projects";
import { ProjectColorChoices } from "../workspace/ProjectColorChoices";

// What the row's dot means. `needsLogin` outranks status: an unauthenticated
// thread needs the user even though its run finished cleanly.
export type ThreadState = "working" | "needs-you" | "settled";

export function threadState(thread: ChatThread | undefined): ThreadState {
  if (!thread) return "settled";
  if (thread.status === "working") return "working";
  if (thread.needsLogin || thread.status === "error") return "needs-you";
  return "settled";
}

const DOT_CLASS: Record<ThreadState, string> = {
  working: "kd-dot-pulse bg-emerald-400 text-emerald-400",
  "needs-you": "bg-red-400",
  settled: "bg-red-400",
};

const DOT_LABEL: Record<ThreadState, string> = {
  working: "working",
  "needs-you": "needs you",
  settled: "settled",
};

export const GROUP_ORDER: WorkspaceGroupKind[] = [
  "needs-user",
  "working",
  "settled",
];

export const GROUP_LABEL: Record<WorkspaceGroupKind, string> = {
  "needs-user": "needs you",
  working: "working",
  settled: "settled",
};

const GROUP_DOT_CLASS: Record<WorkspaceGroupKind, string> = {
  working: "kd-dot-pulse bg-emerald-400 text-emerald-400",
  "needs-user": "bg-red-400",
  settled: "bg-red-400",
};

// The project disclosure row: chevron toggles, the name button activates and
// toggles, plus new-chat and remove-project affordances. `expandNoun` only
// changes the chevron's accessible name (v1 says "chats", v2 says "sessions").
export function SidebarProjectGroup({
  project,
  open,
  count,
  appearance,
  projectsStore,
  expandNoun = "chats",
  children,
}: {
  project: { id: string; name: string; color?: string };
  open: boolean;
  count: number;
  appearance: "dark" | "light";
  projectsStore: StoreApi<ProjectsState>;
  expandNoun?: string;
  children: ReactNode;
}) {
  // Same disclosure contract the old zero-session project row had: context
  // menu (or ContextMenu key / Shift+F10) opens actions, Escape closes and
  // returns focus to the project trigger.
  const [actionsOpen, setActionsOpen] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const colorTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsId = `workspace-project-actions-${project.id}`;
  const colorPickerId = `workspace-project-colors-${project.id}`;

  return (
    <div
      data-workspace-project={project.id}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setActionsOpen(true);
      }}
      onKeyDown={(event) => {
        const opensContextMenu =
          event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
        if (opensContextMenu) {
          event.preventDefault();
          event.stopPropagation();
          setActionsOpen(true);
          return;
        }
        if (event.key !== "Escape") return;
        const wasOpen = actionsOpen || colorPickerOpen;
        setActionsOpen(false);
        setColorPickerOpen(false);
        if (!wasOpen) return;
        event.stopPropagation();
        projectTriggerRef.current?.focus();
      }}
    >
      <div className="group flex items-center gap-0.5 rounded px-1 hover:bg-surface-hover">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${project.name} ${expandNoun}`}
          onClick={() =>
            projectsStore.getState().toggleProjectExpanded(project.id)
          }
          className="flex h-5 w-4 shrink-0 items-center justify-center text-xs text-text-dim hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
        <button
          ref={projectTriggerRef}
          type="button"
          aria-expanded={open}
          aria-label={`Open ${project.name} project`}
          onClick={() => {
            const shouldOpen = !open; // effective state, honors the activeProjectId fallback
            void (async () => {
              await projectsStore.getState().setActiveProject(project.id);
              // setActiveProject always force-expands; reconcile down when collapsing.
              if (!shouldOpen) projectsStore.getState().toggleProjectExpanded(project.id);
            })();
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs text-text-dim hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          <span className="tabular-nums text-[10px]">{count || ""}</span>
        </button>
        <button
          type="button"
          aria-label={`New chat in ${project.name}`}
          title="New chat"
          onClick={() => void newChat(projectsStore, project.id)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span aria-hidden="true" className="text-sm leading-none">
            +
          </span>
        </button>
        <button
          type="button"
          aria-label={`Remove ${project.name} project`}
          title="Remove project"
          onClick={() => void projectsStore.getState().removeProject(project.id)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-dim opacity-0 hover:bg-surface-hover hover:text-text focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-accent group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {actionsOpen && (
        <div
          id={actionsId}
          aria-label={`Actions for ${project.name}`}
          className="mx-1 mt-1 grid gap-1 border-t border-border pt-1"
        >
          <button
            ref={colorTriggerRef}
            type="button"
            aria-label={`Project color for ${project.name}`}
            aria-expanded={colorPickerOpen}
            aria-controls={colorPickerId}
            onClick={() => setColorPickerOpen((openNow) => !openNow)}
            className="rounded px-2 py-1 text-left text-xs text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
          >
            Project color
          </button>
          {colorPickerOpen && (
            <fieldset
              id={colorPickerId}
              aria-label={`Project color for ${project.name}`}
              className="grid grid-cols-4 gap-1 px-2 py-1"
            >
              <ProjectColorChoices
                appearance={appearance}
                selectedColor={project.color}
                onSelect={(colorId) => {
                  projectsStore.getState().setProjectColor(project.id, colorId);
                  setColorPickerOpen(false);
                  colorTriggerRef.current?.focus();
                }}
              />
            </fieldset>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export function ChatThreadRow({
  session,
  thread,
  selected,
  onActivate,
  onClose,
}: {
  session: SessionMeta;
  thread: ChatThread | undefined;
  selected: boolean;
  onActivate(): void;
  onClose(): void;
}) {
  const state = threadState(thread);
  // A renamed session (manual, or the auto-title push after the first turn)
  // always shows its name. Otherwise the loaded title takes over once the
  // thread has messages, and an empty thread reads "New chat" — never the
  // provider-numbered session name ("claude 1"), which only exists so the
  // provider can be inferred before the transcript loads.
  const label = session.nameLocked
    ? session.name
    : thread && thread.entries.length > 0
      ? thread.title
      : DEFAULT_TITLE;
  return (
    <li className="group/thread relative">
      <button
        type="button"
        onClick={onActivate}
        aria-current={selected ? "true" : undefined}
        data-thread-state={state}
        className={`flex w-full items-center gap-1.5 rounded py-1 pl-1.5 pr-6 text-left text-xs focus:outline-none focus:ring-1 focus:ring-accent ${
          selected ? "bg-surface-hover text-text" : "text-text-dim hover:bg-surface-hover hover:text-text"
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[state]}`}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="sr-only">{DOT_LABEL[state]}</span>
      </button>
      <button
        type="button"
        aria-label={`Close chat ${label}`}
        title="Close chat (deletes its transcript)"
        onClick={onClose}
        className="absolute right-0.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-text-dim opacity-0 hover:text-text focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-accent group-focus-within/thread:opacity-100 group-hover/thread:opacity-100"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}

export async function newChat(
  store: StoreApi<ProjectsState>,
  projectId: string,
): Promise<void> {
  if (store.getState().activeProjectId !== projectId) {
    await store.getState().setActiveProject(projectId);
  }
  // New threads start on the user's chosen default provider (settings).
  store.getState().addChatThread(projectId, store.getState().chatProvider);
}

// Which inbox group a task row renders in. The Activity module's projection is
// authoritative when it knows the session; the task state covers the rest
// (e.g. a draft created before any run).
export function taskRowGroup(
  task: KodworkTask | undefined,
  projected: WorkspaceGroupKind | undefined,
): WorkspaceGroupKind {
  if (task && task.state === "draft") return "settled";
  return projected ?? (task ? taskGroup(task.state) : "settled");
}

export function TaskGroups({
  sessions,
  tasks,
  projectedGroup,
  onOpen,
  onClose,
}: {
  sessions: SessionMeta[];
  tasks: Record<string, KodworkTask>;
  projectedGroup: Map<string, WorkspaceGroupKind>;
  onOpen(taskId: string): void;
  onClose(taskId: string): void;
}) {
  const grouped = new Map<WorkspaceGroupKind, SessionMeta[]>(
    GROUP_ORDER.map((kind) => [kind, []]),
  );
  for (const session of sessions) {
    grouped
      .get(taskRowGroup(tasks[session.id], projectedGroup.get(session.id)))!
      .push(session);
  }
  const populated = GROUP_ORDER.filter((kind) => grouped.get(kind)!.length > 0);

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-2">
      {populated.map((kind) => (
        <div key={kind}>
          {populated.length > 1 && (
            <p className="px-1.5 text-[10px] uppercase tracking-[0.12em] text-text-dim/70">
              {GROUP_LABEL[kind]}
            </p>
          )}
          <ul className="space-y-0.5">
            {grouped.get(kind)!.map((session) => (
              <TaskRow
                key={session.id}
                session={session}
                task={tasks[session.id]}
                group={kind}
                closable={
                  tasks[session.id]?.state !== "running" &&
                  tasks[session.id]?.review.status !== "pending"
                }
                onOpen={() => onOpen(session.id)}
                onClose={() => onClose(session.id)}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function TaskRow({
  session,
  task,
  group,
  closable,
  onOpen,
  onClose,
}: {
  session: SessionMeta;
  task: KodworkTask | undefined;
  group: WorkspaceGroupKind;
  closable: boolean;
  onOpen(): void;
  onClose(): void;
}) {
  // A manual session rename wins; otherwise the task's distilled title.
  const label = session.nameLocked
    ? session.name
    : (task?.title ?? DEFAULT_TASK_TITLE);
  return (
    <li className="group/task relative">
      <button
        type="button"
        onClick={onOpen}
        data-task-group={group}
        className="flex w-full items-center gap-1.5 rounded py-1 pl-1.5 pr-6 text-left text-xs text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${GROUP_DOT_CLASS[group]}`}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="sr-only">{GROUP_LABEL[group]}</span>
      </button>
      <button
        type="button"
        aria-label={`Close task ${label}`}
        title={closable ? "Close task (deletes its record)" : "Finish or review this task before closing it"}
        disabled={!closable}
        onClick={onClose}
        className="absolute right-0.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-text-dim opacity-0 hover:text-text disabled:cursor-not-allowed disabled:opacity-20 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-accent group-focus-within/task:opacity-100 group-hover/task:opacity-100"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}

// A terminal (PTY) session row. New in v2: the v1 sidebar never listed PTY
// sessions individually. A live session is green, an exited one red — the same
// dot vocabulary the chat and task rows use.
export function TerminalSessionRow({
  session,
  selected,
  nested = false,
  onActivate,
  onClose,
}: {
  session: SessionMeta;
  selected: boolean;
  nested?: boolean;
  onActivate(): void;
  onClose(): void;
}) {
  const state: ThreadState = session.exited ? "settled" : "working";
  return (
    <li className={`group/terminal relative ${nested ? "ml-3" : ""}`}>
      <button
        type="button"
        onClick={onActivate}
        aria-current={selected ? "true" : undefined}
        data-terminal-state={state}
        className={`flex w-full items-center gap-1.5 rounded py-1 pl-1.5 pr-6 text-left text-xs focus:outline-none focus:ring-1 focus:ring-accent ${
          selected ? "bg-surface-hover text-text" : "text-text-dim hover:bg-surface-hover hover:text-text"
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[state]}`}
        />
        <span className="min-w-0 flex-1 truncate">{session.name}</span>
        <span className="sr-only">{DOT_LABEL[state]}</span>
      </button>
      <button
        type="button"
        aria-label={`Close terminal ${session.name}`}
        title="Close terminal"
        onClick={onClose}
        className="absolute right-0.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-text-dim opacity-0 hover:text-text focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-accent group-focus-within/terminal:opacity-100 group-hover/terminal:opacity-100"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}
