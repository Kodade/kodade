// The sidebar's KödWork section (#43): every project's task list, grouped by
// attention (needs you / working / settled). Modeled on ChatThreadsSection —
// same disclosure, row, and close affordances — but rows open the task's
// editor tab instead of selecting a chat surface.
//
// Grouping comes from the Activity module's projection when it knows the
// session (the kodwork store feeds it metadata-only facts), falling back to
// the task's own state for sessions it hasn't seen yet.

import { useEffect, useState } from "react";
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
import { projectTokenUsage } from "../../kodwork/model";
import type { ProjectsState } from "../../store/projects";
import { isWorkSession } from "../../store/projects";
import { TaskGroups } from "../sidebar/rows";

// The task rows themselves live in sidebar/rows.tsx (extracted in issue #62 so
// the v2 Workspaces sidebar shares them) and are re-exported here unchanged.
export { taskRowGroup, TaskGroups } from "../sidebar/rows";

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
  const [targetProjectId, setTargetProjectId] = useState(activeProjectId ?? "");

  useEffect(() => {
    setTargetProjectId((current) =>
      projects.some((project) => project.id === current)
        ? current
        : activeProjectId ?? "",
    );
  }, [activeProjectId, projects]);

  if (projects.length === 0) return null;

  const targetProject = projects.find((project) => project.id === targetProjectId);
  const taskProjects = projects.flatMap((project) => {
    const workSessions = sessions.filter(
      (session) => session.projectId === project.id && isWorkSession(session),
    );
    return workSessions.length > 0 ? [{ project, workSessions }] : [];
  });

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
      <div
        data-testid="kodwork-header"
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-1 gap-y-0.5 px-1"
      >
        <h2 className="col-span-2 text-[11px] font-semibold tracking-[0.14em] text-text-dim">
          KödWork
        </h2>
        <div
          data-testid="kodwork-controls"
          className="col-span-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1"
        >
          <select
            aria-label="Target project"
            value={targetProjectId}
            onChange={(event) => setTargetProjectId(event.target.value)}
            className="min-w-0 w-full truncate rounded bg-surface px-1 py-0.5 text-[10px] text-text-dim focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">Choose project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <button
            type="button"
            aria-label="New KödWork task"
            title={targetProject ? "New KödWork task" : "Choose a project first"}
            disabled={!targetProject}
            onClick={() =>
              targetProject && void newTask(
                projectsStore,
                workStore,
                targetProject.id,
                targetProject.path,
              )
            }
            className="flex h-5 shrink-0 items-center rounded px-1.5 text-[10px] text-text-dim hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <span aria-hidden="true" className="mr-0.5 text-sm leading-none">+</span>
            New task
          </button>
        </div>
      </div>
      {taskProjects.length === 0 ? (
        <p className="mt-1 px-1 text-[11px] leading-relaxed text-text-dim">
          KödWork runs outcome-based background tasks with your installed CLI. Describe
          what should be true; progress and results stay here for review.
        </p>
      ) : (
        <div className="mt-1 space-y-0.5">
          {taskProjects.map(({ project, workSessions }) => {
            const open = expanded[project.id] ?? project.id === activeProjectId;
            const usage = projectTokenUsage(tasks, project.id).totalTokens;
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
                    {usage > 0 && <span className="ml-1.5 tabular-nums text-[10px]">{usage.toLocaleString()} tokens</span>}
                  </span>
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
      )}
    </section>
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
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('[data-voice-target="kodwork-outcome"]')?.focus(),
    );
  }
}

export async function openTask(
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
