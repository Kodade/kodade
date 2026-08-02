import type { ReactNode } from "react";
import type { WorkspaceView } from "../../activity/activity";
import type { Project } from "../../store/projects";
import { WorkspaceCard, type WorkspaceActions } from "./WorkspaceCard";
import { matchesWorkspaceSearch } from "./metadata";

const GROUP_LABELS = {
  "needs-user": "Needs You",
  working: "Working",
  settled: "Settled",
} as const;

// Terminal workspace cards, grouped by status. Projects themselves are no
// longer listed here — the KödChat section (`lead`) is the one project list,
// so a zero-session project appears exactly once in the sidebar.
export function WorkspaceWorkList({
  view,
  projects,
  appearance,
  actions,
  query,
  lead,
  supplemental,
}: {
  view: WorkspaceView;
  projects: Project[];
  appearance: "dark" | "light";
  actions: WorkspaceActions;
  query: string;
  // Rendered above the workspace groups (the KödChat project/thread tree).
  lead?: ReactNode;
  supplemental?: ReactNode;
}) {
  return (
    <div
      data-workspace-scroll
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {lead}
      {view.groups.map((group) => {
        const visibleSessions = group.sessions.filter((session) =>
          matchesWorkspaceSearch(session, query),
        );
        if (visibleSessions.length === 0) return null;
        const groupLabel = GROUP_LABELS[group.kind];
        const sessionCount = visibleSessions.length;
        return (
          <section
            key={group.kind}
            data-workspace-group={group.kind}
            aria-label={`${groupLabel}, ${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`}
            className="mb-4"
          >
            <div className="flex items-center justify-between px-1">
              <h2 className="text-[11px] font-semibold tracking-[0.14em] text-text-dim">
                {groupLabel}
                <span className="ml-2 tabular-nums">{sessionCount}</span>
              </h2>
              {group.kind === "settled" && (
                <button
                  type="button"
                  aria-label={`Clear ${group.sessions.length} settled ${
                    group.sessions.length === 1 ? "workspace" : "workspaces"
                  }`}
                  title="Clear settled workspaces"
                  onClick={() =>
                    actions.clearSettledWorkspaces(
                      group.sessions.map((session) => session.sessionId),
                    )
                  }
                  className="rounded px-1.5 py-0.5 text-[10px] tracking-normal text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  clear
                </button>
              )}
            </div>
            <div className="mt-1 space-y-1">
              {visibleSessions.map((session) => (
                <WorkspaceCard
                  key={session.sessionId}
                  session={session}
                  project={projects.find((project) => project.id === session.projectId)}
                  appearance={appearance}
                  actions={actions}
                />
              ))}
            </div>
          </section>
        );
      })}
      {supplemental}
    </div>
  );
}
