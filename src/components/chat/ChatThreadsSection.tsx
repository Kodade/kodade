// The sidebar's KödChat section — the v1 sidebar's ONE project list. Every
// project renders exactly once here as an expandable group of chat threads,
// with new-chat, close-chat, and the project actions (color, remove) that used
// to live in the separate zero-session "Projects" section.
//
// The rows themselves live in sidebar/rows.tsx (extracted in issue #62 so the
// v2 Workspaces sidebar shares them) and are re-exported here unchanged.

import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { appStore, chatStore, themeStore } from "../../store/appStore";
import type { ChatState } from "../../chat/store";
import type { ProjectsState } from "../../store/projects";
import { isChatSession } from "../../store/projects";
import {
  ChatThreadRow,
  SidebarProjectGroup,
} from "../sidebar/rows";

export { ChatThreadRow, threadState } from "../sidebar/rows";

export function ChatThreadsSection({
  projectsStore = appStore,
  chatThreadsStore = chatStore,
}: {
  projectsStore?: StoreApi<ProjectsState>;
  chatThreadsStore?: StoreApi<ChatState>;
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
  const appearance = useStore(themeStore, (s) => s.resolved.appearance);

  if (projects.length === 0) return null;

  return (
    <section className="mb-4" aria-label="KödChat threads" data-testid="chat-threads">
      <h2 className="px-1 text-[11px] font-semibold tracking-[0.14em] text-text-dim">
        KödChat
      </h2>
      <div className="mt-1 space-y-0.5">
        {projects.map((project) => {
          const projectThreads = sessions.filter(
            (session) => session.projectId === project.id && isChatSession(session),
          );
          const open = expanded[project.id] ?? project.id === activeProjectId;
          return (
            <SidebarProjectGroup
              key={project.id}
              project={project}
              open={open}
              count={projectThreads.length}
              appearance={appearance}
              projectsStore={projectsStore}
            >
              {open && projectThreads.length > 0 && (
                <ul className="ml-3 space-y-0.5 border-l border-border pl-2">
                  {projectThreads.map((session) => (
                    <ChatThreadRow
                      key={session.id}
                      session={session}
                      thread={threads[session.id]}
                      selected={activeSessionByProject[project.id] === session.id}
                      onActivate={() => {
                        void projectsStore
                          .getState()
                          .activateSession(project.id, session.id);
                      }}
                      onClose={() => {
                        // This drops the chat, its transcript (via app wiring),
                        // and any terminal embedded in the thread workspace.
                        void projectsStore.getState().closeWorkspace(session.id);
                      }}
                    />
                  ))}
                </ul>
              )}
            </SidebarProjectGroup>
          );
        })}
      </div>
    </section>
  );
}
