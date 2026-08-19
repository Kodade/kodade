// The sidebar's KödChat section — now the sidebar's ONE project list. Every
// project renders exactly once here as an expandable group of chat threads,
// with new-chat, close-chat, and the project actions (color, remove) that used
// to live in the separate zero-session "Projects" section.
//
// Standalone PTY workspaces are untouched: their status-grouped cards still
// render below this section. A terminal embedded in a chat closes with that
// thread because it is part of the same workspace.

import { useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { appStore, chatStore, themeStore } from "../../store/appStore";
import type { ChatState } from "../../chat/store";
import { DEFAULT_TITLE, type ChatThread } from "../../chat/model";
import type { ProjectsState, SessionMeta } from "../../store/projects";
import { isChatSession } from "../../store/projects";
import { ProjectColorChoices } from "../workspace/ProjectColorChoices";

// What the row's dot means. `needsLogin` outranks status: an unauthenticated
// thread needs the user even though its run finished cleanly.
type ThreadState = "working" | "needs-you" | "settled";

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
            <ProjectGroup
              key={project.id}
              project={project}
              open={open}
              threadCount={projectThreads.length}
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
            </ProjectGroup>
          );
        })}
      </div>
    </section>
  );
}

function ProjectGroup({
  project,
  open,
  threadCount,
  appearance,
  projectsStore,
  children,
}: {
  project: { id: string; name: string; color?: string };
  open: boolean;
  threadCount: number;
  appearance: "dark" | "light";
  projectsStore: StoreApi<ProjectsState>;
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
          aria-label={`${open ? "Collapse" : "Expand"} ${project.name} chats`}
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
          <span className="tabular-nums text-[10px]">{threadCount || ""}</span>
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

async function newChat(
  store: StoreApi<ProjectsState>,
  projectId: string,
): Promise<void> {
  if (store.getState().activeProjectId !== projectId) {
    await store.getState().setActiveProject(projectId);
  }
  // New threads start on the user's chosen default provider (settings).
  store.getState().addChatThread(projectId, store.getState().chatProvider);
}
