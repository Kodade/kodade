// The compact sidebar rail. Extracted from ProjectsSidebar.tsx (issue #62) so
// the shared sidebar chrome can render it without importing the v1 sidebar.
// Behavior is unchanged from the v1 original.

import { useRef } from "react";
import { appStore } from "../store/appStore";
import type { Project, SessionMeta } from "../store/projects";
import { ProjectTile } from "./ProjectTile";
import { SettingsEntry } from "./settings/SettingsEntry";

// Compact project navigation: identity stays visible while secondary controls
// move into the Add and Settings footer buttons.
export function ProjectRail({
  projects,
  sessions,
  activeProjectId,
  appearance,
  onAddProject,
  openColorMenuProjectId = null,
  onOpenColorMenu,
}: {
  projects: Project[];
  sessions: SessionMeta[];
  activeProjectId: string | null;
  appearance: "dark" | "light";
  onAddProject: () => Promise<void>;
  openColorMenuProjectId?: string | null;
  onOpenColorMenu: (
    project: Project,
    opener: HTMLButtonElement,
    position: { x: number; y: number },
  ) => void;
}) {
  return (
    <nav
      className="flex h-full flex-col items-center p-2"
      aria-label="Projects"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {projects.map((project) => {
          const active = project.id === activeProjectId;
          const running = sessions.some(
            (session) =>
              session.projectId === project.id && isSessionRunning(session),
          );
          return (
            <button
              key={project.id}
              onClick={() => {
                void appStore.getState().setActiveProject(project.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenColorMenu(project, event.currentTarget, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              onKeyDown={(event) => {
                const opensContextMenu =
                  event.key === "ContextMenu" ||
                  (event.key === "F10" && event.shiftKey);
                if (!opensContextMenu) return;
                event.preventDefault();
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                onOpenColorMenu(project, event.currentTarget, {
                  x: bounds.left + bounds.width / 2,
                  y: bounds.bottom,
                });
              }}
              title={project.name}
              aria-label={`${project.name}${active ? " (active)" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-haspopup="menu"
              aria-expanded={openColorMenuProjectId === project.id}
              aria-controls={`project-color-menu-${project.id}`}
              className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md focus:outline-none focus:ring-1 focus:ring-accent ${
                active
                  ? "before:absolute before:inset-y-1 before:-left-2 before:w-0.5 before:bg-accent"
                  : "opacity-60 hover:opacity-100"
              }`}
            >
              <span className="relative flex h-7 w-7">
                <ProjectTile
                  project={project}
                  appearance={appearance}
                  size={28}
                />
                {running && (
                  <span
                    aria-hidden="true"
                    className="kd-dot-pulse absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400 text-emerald-400 ring-1 ring-surface"
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
      <RailOverflow
        onAddProject={onAddProject}
      />
    </nav>
  );
}

function RailOverflow({
  onAddProject,
}: {
  onAddProject: () => Promise<void>;
}) {
  const addTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="mt-2 flex shrink-0 flex-col gap-1">
      <button
        ref={addTriggerRef}
        onClick={() => {
          void onAddProject()
            .catch((error) => {
              console.error("kodade: project picker failed", error);
            })
            .finally(() => addTriggerRef.current?.focus());
        }}
        title="Add project"
        aria-label="Add project"
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <span className="text-base leading-none" aria-hidden="true">+</span>
      </button>
      {/* Same settings entry as full mode, icon-only. */}
      <SettingsEntry compact />
    </div>
  );
}

function isSessionRunning(session: SessionMeta): boolean {
  return !session.exited && !session.nameLocked && !!session.autoName;
}
