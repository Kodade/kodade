import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { Pane } from "./Pane";
import { appStore, themeStore } from "../store/appStore";
import {
  isChatSession,
  type Project,
  type SessionMeta,
} from "../store/projects";
import {
  PROJECT_COLORS,
  autoColorId,
} from "../projects/colors";
import { platform } from "../ipc/transport";
import {
  isRemoteSession,
  REMOTE_PROJECT_PREFIX,
  REMOTE_SESSION_PREFIX,
} from "../ssh/model";
import { labelFor } from "../shortcuts/bindings";
import { ProjectTile } from "./ProjectTile";
import { RemoteHostsSection } from "./RemoteHostsSection";
import { SettingsEntry } from "./settings/SettingsEntry";
import { ChatThreadsSection } from "./chat/ChatThreadsSection";
import { AVAILABLE_PROVIDERS } from "../providers/catalog";
import { RELEASE_MANIFEST } from "../release/manifest";
import type {
  ActivityModule,
  Density,
  SessionStatus,
  WorkspaceGroupKind,
  WorkspaceSession,
  WorkspaceView,
} from "../activity/activity";
import { WorkspaceWorkList } from "./workspace/WorkspaceWorkList";
import type { WorkspaceActions } from "./workspace/WorkspaceCard";
import { WorkspaceHeader } from "./workspace/WorkspaceHeader";

// Injectable full-mode seam for component tests. The production sidebar below
// owns store subscriptions; this boundary receives the already-projected view.
type FullWorkspaceSidebarProps = {
  view: WorkspaceView;
  projects: Project[];
  appearance: "dark" | "light";
  activeProjectId: string | null;
  actions: WorkspaceActions;
  // Rendered above the workspace cards (the KödChat project/thread tree).
  lead?: ReactNode;
  supplemental?: ReactNode;
  footer?: ReactNode;
  // The former terminal work shelf is retained only as an injectable legacy
  // seam for its isolated projection tests. The production sidebar is chat-only.
  showTerminalShelf?: boolean;
  // Store-connected agent quick-launch button, injected past the pure seam.
  launcher?: ReactNode;
};

export function FullWorkspaceSidebar({
  view,
  projects,
  appearance,
  actions,
  lead,
  supplemental,
  footer,
  launcher,
  showTerminalShelf = true,
}: FullWorkspaceSidebarProps) {
  const [query, setQuery] = useState("");

  return (
    <nav
      className="flex h-full min-w-0 flex-col p-2"
      aria-label="Köd workspace"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        setQuery("");
      }}
    >
      <WorkspaceHeader
        query={query}
        onQueryChange={setQuery}
        actions={actions}
        launcher={launcher}
      />
      {showTerminalShelf ? (
        <WorkspaceWorkList
          view={view}
          projects={projects}
          appearance={appearance}
          actions={actions}
          query={query}
          lead={lead}
          supplemental={supplemental}
        />
      ) : (
        <div data-workspace-scroll className="min-h-0 flex-1 overflow-y-auto">
          {lead}
          {supplemental}
        </div>
      )}
      {footer}
    </nav>
  );
}

const GROUP_ORDER: WorkspaceGroupKind[] = ["needs-user", "working", "settled"];
const DENSITY_RANK: Record<Density, number> = {
  compact: 0,
  standard: 1,
  expanded: 2,
};

function launchedAgentName(session: SessionMeta): string | null {
  const numberedBase = session.name.replace(/ \d+$/, "");
  const base = numberedBase.startsWith(REMOTE_SESSION_PREFIX)
    ? numberedBase.slice(REMOTE_SESSION_PREFIX.length)
    : numberedBase;
  return AVAILABLE_PROVIDERS.some((provider) => provider.id === base) ? base : null;
}

function contentDerivedWorkspaceName(
  root: SessionMeta,
  foregroundProcess: string | null,
  projectName: string,
  fallbackNumber: number,
): string {
  if (root.nameLocked) return root.name;
  const project = projectName.trim();
  const content = launchedAgentName(root) ?? foregroundProcess?.trim() ?? "";
  if (content && project) return `${content} · ${project}`;
  return content || project || `Workspace ${fallbackNumber}`;
}

export function projectWorkspaceView(
  activity: ActivityModule,
  sessions: SessionMeta[],
  now: number,
): WorkspaceView {
  const view = activity.workspaceView(now);
  const projectedById = new Map(
    view.groups.flatMap((group) => group.sessions).map((session) => [session.sessionId, session]),
  );
  // Workspace cards are for PTY sessions only. A KödChat thread is a session
  // too, but it belongs to the KödChat section — without this it would also
  // appear here as an empty "Workspace N" card with no terminal behind it.
  const ptySessions = sessions.filter(
    (session) =>
      !isChatSession(session) &&
      !session.projectId.startsWith(REMOTE_PROJECT_PREFIX),
  );
  const roots = ptySessions.filter(
    (session) => !session.workspaceId || session.workspaceId === session.id,
  );
  const workspaceNumberById = new Map<string, number>();
  const countsByProject = new Map<string, number>();
  for (const root of roots) {
    const number = (countsByProject.get(root.projectId) ?? 0) + 1;
    countsByProject.set(root.projectId, number);
    workspaceNumberById.set(root.id, number);
  }
  const grouped = new Map<WorkspaceGroupKind, WorkspaceSession[]>(
    GROUP_ORDER.map((kind) => [kind, []]),
  );

  for (const root of roots) {
    const members = ptySessions.filter(
      (session) =>
        session.projectId === root.projectId &&
        (session.workspaceId ?? session.id) === root.id,
    );
    const projected = members
      .map((session) => projectedById.get(session.id))
      .filter((session): session is WorkspaceSession => !!session);
    const base = projectedById.get(root.id) ?? projected[0];
    if (!base) continue;

    const needsUser = projected.find((session) => session.attention === "needs-user");
    const unread = projected.find((session) => session.attention === "unread");
    const status: SessionStatus = projected.some((session) => session.status === "failed")
      ? "failed"
      : projected.some((session) => session.status === "working")
        ? "working"
        : projected.some((session) => session.status === "idle")
          ? "idle"
          : "exited";
    const density = projected.reduce<Density>(
      (current, session) =>
        DENSITY_RANK[session.density] > DENSITY_RANK[current]
          ? session.density
          : current,
      "compact",
    );
    const foreground =
      projected.find((session) => session.selected)?.foregroundProcess ??
      projected.find((session) => session.foregroundProcess)?.foregroundProcess ??
      null;
    const selected = projected.some((session) => session.selected);
    const card: WorkspaceSession = {
      ...base,
      sessionId: root.id,
      name: contentDerivedWorkspaceName(
        root,
        foreground,
        base.projectName,
        workspaceNumberById.get(root.id) ?? 1,
      ),
      status,
      foregroundProcess: foreground,
      exitCode:
        projected.find((session) => session.status === "failed")?.exitCode ??
        projected.find((session) => session.status === "exited")?.exitCode ??
        null,
      attention: needsUser ? "needs-user" : unread ? "unread" : "none",
      attentionProvenance:
        needsUser?.attentionProvenance ?? unread?.attentionProvenance ?? null,
      attentionReason: needsUser?.attentionReason ?? null,
      density: selected ? "expanded" : density,
      selected,
      pinned: projected.some((session) => session.pinned),
      createdAt: Math.min(...projected.map((session) => session.createdAt)),
      lastActivityAt: Math.max(...projected.map((session) => session.lastActivityAt)),
    };
    const kind: WorkspaceGroupKind = needsUser
      ? "needs-user"
      : status === "working"
        ? "working"
        : "settled";
    grouped.get(kind)?.push(card);
  }

  return {
    reducedMotion: view.reducedMotion,
    groups: GROUP_ORDER.map((kind) => ({
      kind,
      sessions: grouped.get(kind) ?? [],
    })).filter((group) => group.sessions.length > 0),
  };
}

// Projection output is scalar metadata in a fixed order. Keeping the previous
// value when it is identical avoids a sidebar rerender for every clock tick.
function sameWorkspaceView(left: WorkspaceView, right: WorkspaceView): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// The projection owns all activity policy. This hook only refreshes the clock
// boundary and overlays live display names owned by the projects store.
function useWorkspaceView(
  activity: ActivityModule,
  sessions: SessionMeta[],
): WorkspaceView {
  const [view, setView] = useState(() =>
    projectWorkspaceView(activity, sessions, Date.now()),
  );

  useEffect(() => {
    const refresh = () => {
      const next = projectWorkspaceView(activity, sessions, Date.now());
      setView((current) => (sameWorkspaceView(current, next) ? current : next));
    };
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(timer);
  }, [activity, sessions]);

  return view;
}

type FullWorkspaceProjectionProps = Omit<FullWorkspaceSidebarProps, "view"> & {
  activity: ActivityModule;
  sessions: SessionMeta[];
};

// This is mounted only in full mode so the compact rail never starts a
// workspace projection clock.
export function FullWorkspaceProjection({
  activity,
  sessions,
  ...sidebarProps
}: FullWorkspaceProjectionProps) {
  const view = useWorkspaceView(activity, sessions);
  return <FullWorkspaceSidebar {...sidebarProps} view={view} />;
}

// Store-backed shell for the injectable full-mode seam above.
export function ProjectsSidebar() {
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
      title={sidebarMode === "rail" ? "" : "projects"}
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
        <FullWorkspaceSidebar
          view={{ reducedMotion: false, groups: [] }}
          projects={projects}
          appearance={appearance}
          activeProjectId={activeProjectId}
          actions={actions}
          showTerminalShelf={false}
          // KödChat is the sidebar's only local project list.
          lead={<ChatThreadsSection />}
          supplemental={
            RELEASE_MANIFEST.features.ssh ? <SidebarRemoteSection /> : null
          }
          // Settings lives at the bottom-left of the sidebar, not the title bar.
          footer={<SettingsEntry />}
        />
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

// Remote host management lives in Settings → SSH (the canonical surface). The
// sidebar's Remote section is the saved remote-project tree. Plain/ad-hoc
// SSH sessions remain ordinary workspace cards; host discovery and connection
// management live in Settings → SSH.
function SidebarRemoteSection() {
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
      className="flex h-7 w-7 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
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
              className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded focus:outline-none focus:ring-1 focus:ring-accent ${
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
                    className="kd-dot-pulse absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-accent ring-1 ring-surface"
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
        className="flex h-7 w-7 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <span className="text-base leading-none" aria-hidden="true">+</span>
      </button>
      {/* Same settings entry as full mode, icon-only. */}
      <SettingsEntry compact />
    </div>
  );
}

type ProjectColorMenuState = {
  x: number;
  y: number;
  project: Project;
  opener: HTMLButtonElement;
};

function isSessionRunning(session: SessionMeta): boolean {
  return !session.exited && !session.nameLocked && !!session.autoName;
}

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
            className={`flex h-7 w-7 items-center justify-center rounded-[5px] focus:outline-none focus:ring-1 focus:ring-accent ${
              selected
                ? "ring-2 ring-text ring-offset-1 ring-offset-surface"
                : "hover:bg-surface-hover"
            }`}
          >
            <span
              aria-hidden="true"
              className="h-4 w-4 rounded-[4px]"
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
        className={`flex h-7 w-7 items-center justify-center rounded-[5px] text-[9px] text-text-dim focus:outline-none focus:ring-1 focus:ring-accent ${
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
