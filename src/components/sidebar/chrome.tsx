// Shared sidebar chrome: the Pane frame, the collapse toggle, the compact-rail
// branch, the project color menu, and the store-backed WorkspaceActions.
//
// Extracted from ProjectsSidebar.tsx (issue #62) so the v1 sidebar and the v2
// Workspaces sidebar render the same frame and only differ in full-mode
// content. Behavior is unchanged from the v1 original.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { Pane } from "../Pane";
import { appStore, themeStore } from "../../store/appStore";
import type { Project } from "../../store/projects";
import { PROJECT_COLORS, autoColorId } from "../../projects/colors";
import { platform } from "../../ipc/transport";
import { labelFor } from "../../shortcuts/bindings";
import { RemoteHostsSection } from "../RemoteHostsSection";
import { ProjectRail } from "../ProjectRail";
import type { WorkspaceActions } from "../workspace/WorkspaceCard";

// What the full-mode renderer needs from the chrome's store subscriptions.
export type SidebarChromeContext = {
  projects: Project[];
  appearance: "dark" | "light";
  activeProjectId: string | null;
  actions: WorkspaceActions;
};

export function SidebarChrome({
  title = "projects",
  renderFull,
}: {
  title?: string;
  renderFull: (context: SidebarChromeContext) => ReactNode;
}) {
  const projects = useStore(appStore, (s) => s.projects);
  const sessions = useStore(appStore, (s) => s.sessions);
  const activeProjectId = useStore(appStore, (s) => s.activeProjectId);
  const sidebarMode = useStore(appStore, (s) => s.sidebarMode);
  const appearance = useStore(themeStore, (s) => s.resolved.appearance);
  const [colorMenu, setColorMenu] = useState<ProjectColorMenuState | null>(
    null,
  );
  // Click-away dismisses without moving focus away from the clicked control.
  // The focused menu owns its Escape contract and focus return below.
  useEffect(() => {
    if (!colorMenu) return;
    const dismiss = () => setColorMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
    };
  }, [colorMenu]);

  const addProjectViaPicker = async () => {
    const path = await platform.pickFolder();
    if (path) await appStore.getState().addProject(path);
  };
  const actions: WorkspaceActions = {
    activateSession: (projectId, sessionId) => {
      void appStore.getState().activateSession(projectId, sessionId);
    },
    setActiveProject: (projectId) => {
      void appStore.getState().setActiveProject(projectId);
    },
    addProject: addProjectViaPicker,
    renameSession: (sessionId, name) => {
      appStore.getState().renameSession(sessionId, name);
    },
    closeWorkspace: (sessionId) => {
      void appStore.getState().closeWorkspace(sessionId);
    },
    clearSettledWorkspaces: (sessionIds) => {
      void (async () => {
        for (const sessionId of sessionIds) {
          try {
            await appStore.getState().closeWorkspace(sessionId);
          } catch (error) {
            console.error("kodade: failed to clear settled workspace", error);
          }
        }
      })();
    },
    setProjectColor: (projectId, colorId) => {
      appStore.getState().setProjectColor(projectId, colorId);
    },
    removeProject: (projectId) => {
      void appStore.getState().removeProject(projectId);
    },
  };

  return (
    <Pane
      title={sidebarMode === "rail" ? "" : title}
      className="bg-surface"
      headerAction={<SidebarToggle sidebarMode={sidebarMode} />}
      compactHeader={sidebarMode === "rail"}
    >
      {sidebarMode === "rail" ? (
        <ProjectRail
          projects={projects}
          sessions={sessions}
          activeProjectId={activeProjectId}
          appearance={appearance}
          onAddProject={addProjectViaPicker}
          openColorMenuProjectId={colorMenu?.project.id ?? null}
          onOpenColorMenu={(project, opener, position) => {
            setColorMenu({
              ...position,
              project,
              opener,
            });
          }}
        />
      ) : (
        renderFull({ projects, appearance, activeProjectId, actions })
      )}
      {colorMenu && (
        <ProjectColorPicker
          menu={colorMenu}
          appearance={appearance}
          onClose={() => setColorMenu(null)}
        />
      )}
    </Pane>
  );
}

// Remote host management lives in Settings → Advanced → KödSSH (the canonical
// surface). The sidebar's Remote section is the saved remote-project tree.
// Plain/ad-hoc SSH sessions remain ordinary workspace cards; host discovery and
// connection management live in Settings → Advanced → KödSSH.
export function SidebarRemoteSection() {
  const hasRemoteWork = useStore(
    appStore,
    (s) => s.remoteTargets.length > 0,
  );
  if (!hasRemoteWork) return null;
  return <RemoteHostsSection projectTree />;
}

// The header control never moves: whether it expands the rail or collapses the
// full list, it remains in the 38px projects header for muscle memory.
function SidebarToggle({ sidebarMode }: { sidebarMode: "full" | "rail" }) {
  const rail = sidebarMode === "rail";
  const action = rail ? "Expand projects sidebar" : "Collapse projects sidebar";

  return (
    <button
      onClick={() => appStore.getState().toggleSidebarMode()}
      title={`${action} — ${labelFor("toggle-sidebar")}`}
      aria-label={action}
      aria-pressed={rail}
      className="flex h-7 w-7 items-center justify-center rounded-md text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
    >
      <svg
        viewBox="0 0 16 16"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M2.5 3.5h11v9h-11zM6 3.5v9" />
        <path d={rail ? "m8.5 6 2 2-2 2" : "m10 6-2 2 2 2"} />
      </svg>
    </button>
  );
}

type ProjectColorMenuState = {
  x: number;
  y: number;
  project: Project;
  opener: HTMLButtonElement;
};

// Compact project identity picker: palette paint lives only in colors.ts;
// chrome is semantic so it re-skins with every app theme.
function ProjectColorPicker({
  menu,
  appearance,
  onClose,
}: {
  menu: ProjectColorMenuState;
  appearance: "dark" | "light";
  onClose: () => void;
}) {
  const autoId = autoColorId(menu.project.id);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const selected = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"]',
    );
    (selected ?? first)?.focus();
  }, [menu.project.color, menu.project.id]);

  const select = (colorId: string | null) => (event: React.MouseEvent) => {
    event.stopPropagation();
    appStore.getState().setProjectColor(menu.project.id, colorId);
    onClose();
    menu.opener.focus();
  };

  return (
    <div
      ref={menuRef}
      id={`project-color-menu-${menu.project.id}`}
      role="menu"
      aria-label={`Project color for ${menu.project.name}`}
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          menu.opener.focus();
          return;
        }

        const items = [
          ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitemradio"]',
          ) ?? []),
        ];
        const currentIndex = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        let nextIndex: number | null = null;
        if (event.key === "ArrowDown") {
          nextIndex = (currentIndex + 1) % items.length;
        } else if (event.key === "ArrowUp") {
          nextIndex = (currentIndex - 1 + items.length) % items.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = items.length - 1;
        }
        if (nextIndex === null || !items[nextIndex]) return;
        event.preventDefault();
        event.stopPropagation();
        items[nextIndex].focus();
      }}
      className="fixed z-50 grid grid-cols-3 gap-1 rounded-md border border-border bg-surface p-1.5 shadow-lg"
    >
      {PROJECT_COLORS.map((color) => {
        const selected = menu.project.color === color.id;
        return (
          <button
            key={color.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            aria-label={color.name}
            title={color.name}
            onClick={select(color.id)}
            className={`flex h-7 w-7 items-center justify-center rounded-md focus:outline-none focus:ring-1 focus:ring-accent ${
              selected
                ? "ring-2 ring-text ring-offset-1 ring-offset-surface"
                : "hover:bg-surface-hover"
            }`}
          >
            <span
              aria-hidden="true"
              className="h-4 w-4 rounded-full"
              style={{ backgroundColor: color[appearance] }}
            />
          </button>
        );
      })}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!menu.project.color}
        aria-label="Auto color"
        title={`Auto (${PROJECT_COLORS.find((color) => color.id === autoId)!.name})`}
        onClick={select(null)}
        className={`flex h-7 w-7 items-center justify-center rounded-md text-[9px] text-text-dim focus:outline-none focus:ring-1 focus:ring-accent ${
          !menu.project.color
            ? "ring-2 ring-text ring-offset-1 ring-offset-surface"
            : "hover:bg-surface-hover hover:text-text"
        }`}
      >
        auto
      </button>
    </div>
  );
}
