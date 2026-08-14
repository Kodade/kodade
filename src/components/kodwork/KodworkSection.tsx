// The sidebar's KödWork section (#43): every project's task list, grouped by
// attention (needs you / working / settled). Modeled on ChatThreadsSection —
// same disclosure, row, and close affordances — but rows open the task's
// editor tab instead of selecting a chat surface.
//
// Grouping comes from the Activity module's projection when it knows the
// session (the kodwork store feeds it metadata-only facts), falling back to
// the task's own state for sessions it hasn't seen yet.

import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import {
  activityModule as defaultActivityModule,
  appStore,
  filesStore,
  kodworkStore,
} from "../../store/appStore";
import type { ActivityModule, WorkspaceGroupKind } from "../../activity/activity";
import type { KodworkState } from "../../kodwork/store";
import { DEFAULT_TASK_TITLE, taskGroup, type KodworkTask } from "../../kodwork/model";
import type { ProjectsState, SessionMeta } from "../../store/projects";
import { isWorkSession } from "../../store/projects";

const GROUP_ORDER: WorkspaceGroupKind[] = ["needs-user", "working", "settled"];

const GROUP_LABEL: Record<WorkspaceGroupKind, string> = {
  "needs-user": "needs you",
  working: "working",
  settled: "settled",
};

const DOT_CLASS: Record<WorkspaceGroupKind, string> = {
  working: "kd-dot-pulse bg-accent",
  "needs-user": "bg-red-400",
  settled: "bg-text-dim/40",
};

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

export function KodworkSection({
  projectsStore = appStore,
  workStore = kodworkStore,
  activity = defaultActivityModule,
}: {
  projectsStore?: StoreApi<ProjectsState>;
  workStore?: StoreApi<KodworkState>;
  activity?: ActivityModule;
} = {}) {
  const projects = useStore(projectsStore, (s) => s.projects);
  const sessions = useStore(projectsStore, (s) => s.sessions);
  const expanded = useStore(projectsStore, (s) => s.expandedProjects);
  const activeProjectId = useStore(projectsStore, (s) => s.activeProjectId);
  const tasks = useStore(workStore, (s) => s.tasks);

  if (projects.length === 0) return null;

  // Attention/status projection for grouping. Re-derived on task/session
  // changes — every group transition coincides with a store update.
  const view = activity.workspaceView(Date.now());
  const projectedGroup = new Map<string, WorkspaceGroupKind>(
    view.groups.flatMap((group) =>
      group.sessions.map((session) => [session.sessionId, group.kind] as const),
    ),
  );

  return (
    <section className="mb-4" aria-label="KödWork tasks" data-testid="kodwork-tasks">
      <h2 className="px-1 text-[11px] font-semibold tracking-[0.14em] text-text-dim">
        KödWork
      </h2>
      <div className="mt-1 space-y-0.5">
        {projects.map((project) => {
          const workSessions = sessions.filter(
            (session) => session.projectId === project.id && isWorkSession(session),
          );
          const open = expanded[project.id] ?? project.id === activeProjectId;
          return (
            <div key={project.id} data-kodwork-project={project.id}>
              <div className="group flex items-center gap-0.5 rounded px-1 hover:bg-surface-hover">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${project.name} tasks`}
                  onClick={() =>
                    projectsStore.getState().toggleProjectExpanded(project.id)
                  }
                  className="flex h-5 w-4 shrink-0 items-center justify-center text-xs text-text-dim hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                </button>
                <span className="min-w-0 flex-1 truncate py-1 text-left text-xs text-text-dim">
                  {project.name}
                  <span className="ml-1.5 tabular-nums text-[10px]">
                    {workSessions.length || ""}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`New task in ${project.name}`}
                  title="New KödWork task"
                  onClick={() =>
                    void newTask(projectsStore, workStore, project.id, project.path)
                  }
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <span aria-hidden="true" className="text-sm leading-none">
                    +
                  </span>
                </button>
              </div>
              {open && workSessions.length > 0 && (
                <TaskGroups
                  sessions={workSessions}
                  tasks={tasks}
                  projectedGroup={projectedGroup}
                  onOpen={(taskId) =>
                    void openTask(
                      projectsStore,
                      workStore,
                      project.id,
                      project.path,
                      taskId,
                    )
                  }
                  onClose={(taskId) => {
                    // Closing drops the session and (via app wiring) its task
                    // document; the tab goes with it.
                    filesStore.getState().closeTab({ kind: "kodwork", taskId });
                    void projectsStore.getState().closeSession(taskId);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TaskGroups({
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

function TaskRow({
  session,
  task,
  group,
  onOpen,
  onClose,
}: {
  session: SessionMeta;
  task: KodworkTask | undefined;
  group: WorkspaceGroupKind;
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
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[group]}`}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="sr-only">{GROUP_LABEL[group]}</span>
      </button>
      <button
        type="button"
        aria-label={`Close task ${label}`}
        title="Close task (deletes its record)"
        onClick={onClose}
        className="absolute right-0.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-text-dim opacity-0 hover:text-text focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-accent group-focus-within/task:opacity-100 group-hover/task:opacity-100"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}

// Wait for the files store to point at `path` before opening a tab there —
// activating a background project re-roots the tree asynchronously.
function whenRootIs(path: string, timeoutMs = 3_000): Promise<boolean> {
  if (filesStore.getState().rootPath === path) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(filesStore.getState().rootPath === path);
    }, timeoutMs);
    const unsubscribe = filesStore.subscribe((state) => {
      if (state.rootPath !== path) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

async function newTask(
  projectsStore: StoreApi<ProjectsState>,
  workStore: StoreApi<KodworkState>,
  projectId: string,
  projectPath: string,
): Promise<void> {
  if (projectsStore.getState().activeProjectId !== projectId) {
    await projectsStore.getState().setActiveProject(projectId);
  }
  const taskId = projectsStore.getState().addWorkSession(projectId);
  if (!taskId) return;
  await workStore.getState().openTask(taskId, projectId);
  if (await whenRootIs(projectPath)) {
    filesStore.getState().openKodworkTab(taskId);
  }
}

async function openTask(
  projectsStore: StoreApi<ProjectsState>,
  workStore: StoreApi<KodworkState>,
  projectId: string,
  projectPath: string,
  taskId: string,
): Promise<void> {
  if (projectsStore.getState().activeProjectId !== projectId) {
    await projectsStore.getState().setActiveProject(projectId);
  }
  await workStore.getState().openTask(taskId, projectId);
  if (await whenRootIs(projectPath)) {
    filesStore.getState().openKodworkTab(taskId);
  }
}
