// Full-mode sidebar frame and its PTY workspace projection.
//
// Extracted verbatim from ProjectsSidebar.tsx (issue #62) so the v1 sidebar and
// the v2 Workspaces sidebar can share one frame. ProjectsSidebar re-exports
// everything here, so existing importers and tests are unaffected.

import { useEffect, useState, type ReactNode } from "react";
import {
  isChatSession,
  isWorkSession,
  type Project,
  type SessionMeta,
} from "../../store/projects";
import {
  REMOTE_PROJECT_PREFIX,
  REMOTE_SESSION_PREFIX,
} from "../../ssh/model";
import { AVAILABLE_PROVIDERS } from "../../providers/catalog";
import type {
  ActivityModule,
  Density,
  SessionStatus,
  WorkspaceGroupKind,
  WorkspaceSession,
  WorkspaceView,
} from "../../activity/activity";
import { WorkspaceWorkList } from "./WorkspaceWorkList";
import type { WorkspaceActions } from "./WorkspaceCard";
import { WorkspaceHeader } from "./WorkspaceHeader";

// Injectable full-mode seam for component tests. The production sidebar
// owns store subscriptions; this boundary receives the already-projected view.
export type FullWorkspaceSidebarProps = {
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
  // Workspace cards are for PTY sessions only. KödChat threads and KödWork
  // tasks are sessions too, but they belong to their own sections — without
  // this they would also appear here as empty "Workspace N" cards.
  const ptySessions = sessions.filter(
    (session) =>
      !isChatSession(session) &&
      !isWorkSession(session) &&
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
