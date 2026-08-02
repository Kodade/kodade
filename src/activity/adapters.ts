// Thin ingress adapters keep transport/store details out of ActivityModule.
// Events forwarded to it contain no terminal output, file bodies, or paths.

import type { ActivityEvent, ActivityModule } from "./activity";

type WithoutTimestamp<Event> = Event extends { at: number }
  ? Omit<Event, "at">
  : never;

export type ActivityFact = WithoutTimestamp<ActivityEvent>;
export type WorkspaceActivityFact = Extract<
  ActivityFact,
  {
    type:
      | "project-added"
      | "project-removed"
      | "session-created"
      | "session-closed"
      | "session-selected"
      | "terminal-foreground";
  }
>;
export type FileActivityFact = {
  type: "file-opened" | "file-saved";
  // Routing-only. App wiring resolves this root to a registered workspace, then
  // removes it before the fact reaches ActivityModule.
  root: string | null;
};

export type ActivityAdapters = {
  workspace(fact: WorkspaceActivityFact): void;
  terminalOutput(projectId: string, sessionId: string): void;
  terminalExited(
    projectId: string,
    sessionId: string,
    code: number | null,
  ): void;
  file(
    fact: FileActivityFact,
    projectId: string,
    sessionId: string | null,
  ): void;
};

export function createActivityAdapters(
  activity: ActivityModule,
  clock: () => number = () => Date.now(),
): ActivityAdapters {
  const observe = (fact: ActivityFact) => {
    activity.observe({ ...fact, at: clock() } as ActivityEvent);
  };

  return {
    workspace: observe,
    terminalOutput(projectId, sessionId) {
      observe({ type: "terminal-output", projectId, sessionId });
    },
    terminalExited(projectId, sessionId, code) {
      observe({ type: "terminal-exited", projectId, sessionId, code });
    },
    file(fact, projectId, sessionId) {
      observe({ type: fact.type, projectId, sessionId });
    },
  };
}
