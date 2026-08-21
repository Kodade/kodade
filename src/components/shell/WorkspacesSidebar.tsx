// The v2 shell's sidebar (issue #62, slice b): ONE list of workspaces.
//
// A workspace in v2 is a project, and everything running in it — chats,
// terminals, and tasks — lists inside its expanded row. There are no branded
// section headings here: the v1 sidebar's separate KödChat and KödWork
// sections collapse into a single "Workspaces" list.
//
// This component is mounted only by ShellV2. The v1 sidebar (ProjectsSidebar)
// is untouched, and both share the same chrome, rows, and rail.
//
// The workspace row's single `+` is deliberately chat-only for now: creating a
// terminal from the sidebar lands with the Code tab slice, and task creation
// moves to the Agents tab in a later phase. Until then the button keeps its
// accurate "New chat" labels rather than growing a menu that would be rebuilt.

import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import {
  activityModule as defaultActivityModule,
  agentsStore,
  appStore,
  chatStore,
  filesStore,
  kodworkStore,
  themeStore,
} from "../../store/appStore";
import type { ActivityModule, WorkspaceGroupKind } from "../../activity/activity";
import type { ChatState } from "../../chat/store";
import type { KodworkState } from "../../kodwork/store";
import type { ProjectsState } from "../../store/projects";
import { isChatSession, isWorkSession } from "../../store/projects";
import { RELEASE_MANIFEST, type ReleaseManifest } from "../../release/manifest";
import { SettingsEntry } from "../settings/SettingsEntry";
import { SidebarChrome, SidebarRemoteSection } from "../sidebar/chrome";
import {
  ChatThreadRow,
  SidebarProjectGroup,
  TaskGroups,
  TerminalSessionRow,
} from "../sidebar/rows";
import { projectTerminalGroups } from "../sidebar/terminals";
import { FullWorkspaceSidebar } from "../workspace/projection";
import { openAgentRun } from "./agent-runs";

export function WorkspacesSidebar() {
  return (
    <SidebarChrome
      title="workspaces"
      renderFull={({ projects, appearance, activeProjectId, actions }) => (
        <FullWorkspaceSidebar
          view={{ reducedMotion: false, groups: [] }}
          projects={projects}
          appearance={appearance}
          activeProjectId={activeProjectId}
          actions={actions}
          showTerminalShelf={false}
          lead={<WorkspacesSection />}
          supplemental={
            RELEASE_MANIFEST.features.ssh ? <SidebarRemoteSection /> : null
          }
          footer={<SettingsEntry />}
        />
      )}
    />
  );
}

// The one v2 list. Stores are injectable so the section can be tested without
// the app's singletons, matching the v1 sections' seam.
export function WorkspacesSection({
  projectsStore = appStore,
  chatThreadsStore = chatStore,
  workStore = kodworkStore,
  activity = defaultActivityModule,
  manifest = RELEASE_MANIFEST,
}: {
  projectsStore?: StoreApi<ProjectsState>;
  chatThreadsStore?: StoreApi<ChatState>;
  workStore?: StoreApi<KodworkState>;
  activity?: ActivityModule;
  // Injectable so the KödWork-disabled build can be tested directly.
  manifest?: ReleaseManifest;
} = {}) {
  const projects = useStore(projectsStore, (s) => s.projects);
  const sessions = useStore(projectsStore, (s) => s.sessions);
  const expanded = useStore(projectsStore, (s) => s.expandedProjects);
  const activeProjectId = useStore(projectsStore, (s) => s.activeProjectId);
  const activeSessionByProject = useStore(
    projectsStore,
    (s) => s.activeSessionByProject,
  );
  const threads = useStore(chatThreadsStore, (s) => s.threads);
  const tasks = useStore(workStore, (s) => s.tasks);
  const appearance = useStore(themeStore, (s) => s.resolved.appearance);

  if (projects.length === 0) return null;

  // Same compile-time boundary the v1 sidebar honors: a build without KödWork
  // shows no task rows and does not count work sessions.
  const workEnabled = manifest.features.work;

  // Attention/status projection for task grouping, same source the v1 task
  // inbox uses.
  const view = activity.workspaceView(Date.now());
  const projectedGroup = new Map<string, WorkspaceGroupKind>(
    view.groups.flatMap((group) =>
      group.sessions.map((session) => [session.sessionId, group.kind] as const),
    ),
  );

  return (
    // No visible heading: the sidebar's chrome title already says
    // "workspaces", and repeating it directly underneath read as clutter.
    <section className="mb-4" aria-label="Workspaces" data-testid="workspaces">
      <div className="mt-1 space-y-0.5">
        {projects.map((project) => {
          const projectSessions = sessions.filter(
            (session) => session.projectId === project.id,
          );
          const chats = projectSessions.filter(isChatSession);
          const workSessions = workEnabled
            ? projectSessions.filter(isWorkSession)
            : [];
          const terminals = projectTerminalGroups(sessions, project.id);
          const terminalCount = terminals.reduce(
            (sum, group) => sum + 1 + group.children.length,
            0,
          );
          const open = expanded[project.id] ?? project.id === activeProjectId;
          // Every project remembers its own last selection, but only the
          // ACTIVE project's session is actually on screen — highlighting the
          // remembered row in every expanded project read as four open
          // windows at once.
          const activeSessionId =
            project.id === activeProjectId
              ? activeSessionByProject[project.id]
              : undefined;
          return (
            <SidebarProjectGroup
              key={project.id}
              project={project}
              open={open}
              count={chats.length + terminalCount + workSessions.length}
              appearance={appearance}
              projectsStore={projectsStore}
              expandNoun="sessions"
            >
              {open && chats.length + terminals.length + workSessions.length > 0 && (
                <div data-workspace-sessions={project.id}>
                  {chats.length > 0 && (
                    <ul className="ml-3 space-y-0.5 border-l border-border pl-2">
                      {chats.map((session) => (
                        <ChatThreadRow
                          key={session.id}
                          session={session}
                          thread={threads[session.id]}
                          selected={activeSessionId === session.id}
                          onActivate={() => {
                            void projectsStore
                              .getState()
                              .activateSession(project.id, session.id);
                          }}
                          onClose={() => {
                            void projectsStore
                              .getState()
                              .closeWorkspace(session.id);
                          }}
                        />
                      ))}
                    </ul>
                  )}
                  {terminals.length > 0 && (
                    <ul
                      data-workspace-terminals={project.id}
                      className="ml-3 space-y-0.5 border-l border-border pl-2"
                    >
                      {terminals.flatMap((group) =>
                        [group.root, ...group.children].map((session) => (
                          <TerminalSessionRow
                            key={session.id}
                            session={session}
                            nested={session.id !== group.root.id}
                            selected={activeSessionId === session.id}
                            onActivate={() => {
                              void projectsStore
                                .getState()
                                .activateSession(project.id, session.id);
                            }}
                            onClose={() => {
                              // Closing a root closes its whole split group; a
                              // split child closes on its own.
                              const store = projectsStore.getState();
                              if (session.id === group.root.id) {
                                void store.closeWorkspace(session.id);
                              } else {
                                void store.closeSession(session.id);
                              }
                            }}
                          />
                        )),
                      )}
                    </ul>
                  )}
                  {workSessions.length > 0 && (
                    <TaskGroups
                      sessions={workSessions}
                      tasks={tasks}
                      projectedGroup={projectedGroup}
                      // A run opens INSIDE the Agents tab in v2 (not the Editor
                      // tab): switch tabs, then point the run area at the task.
                      onOpen={(taskId) => {
                        const projects = projectsStore.getState();
                        projects.setShellLayout({
                          ...projects.shellLayout,
                          activeTab: "agents",
                        });
                        void openAgentRun(
                          projectsStore,
                          workStore,
                          agentsStore,
                          project.id,
                          taskId,
                        );
                      }}
                      onClose={(taskId) => {
                        // Drop the run's selection if it was showing, then close
                        // the session (which removes its task document).
                        if (agentsStore.getState().selectedRunTaskId === taskId) {
                          agentsStore.getState().selectRun(null);
                        }
                        filesStore.getState().closeTab({ kind: "kodwork", taskId });
                        void projectsStore.getState().closeSession(taskId);
                      }}
                    />
                  )}
                </div>
              )}
            </SidebarProjectGroup>
          );
        })}
      </div>
    </section>
  );
}
