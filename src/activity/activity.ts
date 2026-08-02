// Headless activity model for the adaptive workspace. It accepts only
// low-sensitivity metadata: never terminal text, file contents, or keystrokes.

export const RECENT_ACTIVITY_MS = 5 * 60 * 1_000;
export const STABILITY_WINDOW_MS = 5 * 1_000;

export type SessionStatus = "working" | "idle" | "exited" | "failed";
export type Attention = "none" | "unread" | "needs-user";
export type Density = "expanded" | "standard" | "compact";
export type AttentionProvenance = "mcp" | "provider";

type Timestamped = { at: number };

export type ActivityEvent =
  | (Timestamped & {
      type: "project-added";
      projectId: string;
      projectName: string;
    })
  | (Timestamped & { type: "project-removed"; projectId: string })
  | (Timestamped & {
      type: "session-created";
      projectId: string;
      sessionId: string;
      name: string;
    })
  | (Timestamped & {
      type: "session-closed";
      projectId: string;
      sessionId: string;
    })
  | (Timestamped & {
      type: "session-selected";
      projectId: string;
      sessionId: string;
    })
  | (Timestamped & {
      type: "terminal-output";
      projectId: string;
      sessionId: string;
    })
  | (Timestamped & {
      type: "terminal-foreground";
      projectId: string;
      sessionId: string;
      process: string | null;
    })
  | (Timestamped & {
      type: "terminal-exited";
      projectId: string;
      sessionId: string;
      code: number | null;
    })
  | (Timestamped & {
      type: "file-opened" | "file-saved";
      projectId: string;
      sessionId: string | null;
    })
  | (Timestamped & {
      type: "attention-reported";
      projectId: string;
      sessionId: string;
      attention: "needs-user";
      provenance: AttentionProvenance;
      reason: string;
    })
  | (Timestamped & {
      type: "attention-reported";
      projectId: string;
      sessionId: string;
      attention: "none";
      provenance: AttentionProvenance;
      reason?: never;
    });

export type WorkspaceSession = {
  projectId: string;
  projectName: string;
  sessionId: string;
  name: string;
  status: SessionStatus;
  foregroundProcess: string | null;
  exitCode: number | null;
  attention: Attention;
  attentionProvenance: AttentionProvenance | null;
  attentionReason: string | null;
  density: Density;
  selected: boolean;
  pinned: boolean;
  createdAt: number;
  lastActivityAt: number;
  reducedMotion: boolean;
};

export type WorkspaceGroupKind = "needs-user" | "working" | "settled";

export type WorkspaceGroup = {
  kind: WorkspaceGroupKind;
  sessions: WorkspaceSession[];
};

export type WorkspaceView = {
  groups: WorkspaceGroup[];
  reducedMotion: boolean;
};

export type ActivityModule = {
  observe(event: ActivityEvent): void;
  acknowledge(sessionId: string): void;
  pin(sessionId: string, pinned: boolean): void;
  workspaceView(now: number): WorkspaceView;
};

export type ActivityModuleOptions = {
  reducedMotion?: boolean | (() => boolean);
  now?: () => number;
};

type ProjectActivity = {
  id: string;
  name: string;
};

type SessionActivity = {
  id: string;
  projectId: string;
  name: string;
  status: SessionStatus;
  statusAt: number;
  foregroundProcess: string | null;
  exitCode: number | null;
  attention: Attention;
  attentionProvenance: AttentionProvenance | null;
  attentionReason: string | null;
  // Last accepted explicit attention report. This is independent from terminal
  // activity so delayed provider/MCP reports cannot overwrite newer attention.
  attentionAt: number;
  pinned: boolean;
  selected: boolean;
  createdAt: number;
  lastActivityAt: number;
  // This is transient projection bookkeeping, never persistence. It prevents
  // a one-poll status blip from immediately shrinking a card.
  densityHold: Density;
  densityHoldUntil: number;
};

const densityRank: Record<Density, number> = {
  compact: 0,
  standard: 1,
  expanded: 2,
};

function normalizeTime(at: number): number {
  return Number.isFinite(at) ? at : 0;
}

function later(a: number, b: number): number {
  return a > b ? a : b;
}

function baseDensity(session: SessionActivity, now: number): Density {
  if (
    session.selected ||
    session.attention === "needs-user" ||
    session.status === "failed"
  ) {
    return "expanded";
  }
  if (
    session.pinned ||
    session.status === "working" ||
    now < session.lastActivityAt + RECENT_ACTIVITY_MS
  ) {
    return "standard";
  }
  return "compact";
}

function densityFor(session: SessionActivity, now: number): Density {
  let density = baseDensity(session, now);

  // A recently active session gets a short settling grace after its recency
  // boundary, without a timer or any state mutation during projection.
  if (
    density === "compact" &&
    now < session.lastActivityAt + RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS
  ) {
    density = "standard";
  }
  if (
    now < session.densityHoldUntil &&
    densityRank[session.densityHold] > densityRank[density]
  ) {
    density = session.densityHold;
  }
  return density;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function groupFor(session: SessionActivity): WorkspaceGroupKind {
  if (session.attention === "needs-user") return "needs-user";
  if (session.status === "working") return "working";
  return "settled";
}

export function createActivityModule(
  options: ActivityModuleOptions = {},
): ActivityModule {
  const projects = new Map<string, ProjectActivity>();
  const sessions = new Map<string, SessionActivity>();
  const now = options.now ?? (() => Date.now());
  const configuredReducedMotion = options.reducedMotion;
  const prefersReducedMotion: () => boolean =
    typeof configuredReducedMotion === "function"
      ? configuredReducedMotion
      : () => configuredReducedMotion === true;
  let selectedSessionId: string | null = null;

  const findSession = (projectId: string, sessionId: string) => {
    const session = sessions.get(sessionId);
    return session?.projectId === projectId ? session : null;
  };

  const noteActivity = (session: SessionActivity, at: number) => {
    session.lastActivityAt = later(session.lastActivityAt, at);
  };

  const clearAttention = (session: SessionActivity) => {
    session.attention = "none";
    session.attentionProvenance = null;
    session.attentionReason = null;
  };

  const applyDensityTransition = (
    session: SessionActivity,
    at: number,
    apply: () => void,
  ) => {
    const before = densityFor(session, at);
    apply();
    const after = densityFor(session, at);
    if (densityRank[before] > densityRank[after]) {
      if (
        at < session.densityHoldUntil &&
        densityRank[session.densityHold] >= densityRank[before]
      ) {
        return;
      }
      session.densityHold = before;
      session.densityHoldUntil = at + STABILITY_WINDOW_MS;
    }
  };

  const select = (projectId: string, sessionId: string, at: number) => {
    const target = findSession(projectId, sessionId);
    if (!target) return;

    if (selectedSessionId && selectedSessionId !== sessionId) {
      const previous = sessions.get(selectedSessionId);
      if (previous) {
        applyDensityTransition(previous, at, () => (previous.selected = false));
      }
    }
    selectedSessionId = sessionId;
    applyDensityTransition(target, at, () => {
      target.selected = true;
      if (target.attention === "unread") {
        clearAttention(target);
      }
    });
  };

  return {
    observe(event) {
      const at = normalizeTime(event.at);
      switch (event.type) {
        case "project-added": {
          projects.set(event.projectId, {
            id: event.projectId,
            name: event.projectName,
          });
          return;
        }
        case "project-removed": {
          projects.delete(event.projectId);
          for (const [id, session] of sessions) {
            if (session.projectId !== event.projectId) continue;
            sessions.delete(id);
            if (selectedSessionId === id) selectedSessionId = null;
          }
          return;
        }
        case "session-created": {
          if (!projects.has(event.projectId)) return;
          const existing = findSession(event.projectId, event.sessionId);
          if (existing) {
            existing.name = event.name;
            return;
          }
          sessions.set(event.sessionId, {
            id: event.sessionId,
            projectId: event.projectId,
            name: event.name,
            status: "idle",
            statusAt: at,
            foregroundProcess: null,
            exitCode: null,
            attention: "none",
            attentionProvenance: null,
            attentionReason: null,
            attentionAt: at,
            pinned: false,
            selected: false,
            createdAt: at,
            lastActivityAt: at,
            densityHold: "compact",
            densityHoldUntil: 0,
          });
          return;
        }
        case "session-closed": {
          const session = findSession(event.projectId, event.sessionId);
          if (!session) return;
          sessions.delete(session.id);
          if (selectedSessionId === session.id) selectedSessionId = null;
          return;
        }
        case "session-selected": {
          select(event.projectId, event.sessionId, at);
          return;
        }
        case "terminal-output": {
          const session = findSession(event.projectId, event.sessionId);
          if (!session) return;
          applyDensityTransition(session, at, () => {
            noteActivity(session, at);
            // Only terminal output from a non-selected session becomes unread.
            // It is intentionally never enough to infer needs-user.
            if (!session.selected && session.attention === "none") {
              session.attention = "unread";
              session.attentionProvenance = null;
              session.attentionReason = null;
            }
          });
          return;
        }
        case "terminal-foreground": {
          const session = findSession(event.projectId, event.sessionId);
          if (
            !session ||
            at < session.statusAt ||
            session.status === "exited" ||
            session.status === "failed"
          ) {
            return;
          }
          applyDensityTransition(session, at, () => {
            session.status = event.process ? "working" : "idle";
            session.statusAt = at;
            session.foregroundProcess = event.process;
            session.exitCode = null;
            noteActivity(session, at);
          });
          return;
        }
        case "terminal-exited": {
          const session = findSession(event.projectId, event.sessionId);
          if (!session || at < session.statusAt) return;
          applyDensityTransition(session, at, () => {
            session.status = event.code === 0 ? "exited" : "failed";
            session.statusAt = at;
            session.foregroundProcess = null;
            session.exitCode = event.code;
            noteActivity(session, at);
          });
          return;
        }
        case "file-opened":
        case "file-saved": {
          if (!event.sessionId) return;
          const session = findSession(event.projectId, event.sessionId);
          if (!session) return;
          applyDensityTransition(session, at, () => noteActivity(session, at));
          return;
        }
        case "attention-reported": {
          const session = findSession(event.projectId, event.sessionId);
          if (!session || at < session.attentionAt) return;
          applyDensityTransition(session, at, () => {
            session.attentionAt = at;
            noteActivity(session, at);
            if (event.attention === "needs-user") {
              session.attention = "needs-user";
              session.attentionProvenance = event.provenance;
              session.attentionReason = event.reason;
            } else if (session.attention === "needs-user") {
              clearAttention(session);
            }
          });
          return;
        }
      }
    },

    acknowledge(sessionId) {
      const session = sessions.get(sessionId);
      if (session?.attention === "unread") {
        clearAttention(session);
      }
    },

    pin(sessionId, pinned) {
      const session = sessions.get(sessionId);
      if (!session || session.pinned === pinned) return;
      applyDensityTransition(session, normalizeTime(now()), () => {
        session.pinned = pinned;
      });
    },

    workspaceView(viewNow) {
      const nowAt = normalizeTime(viewNow);
      const reducedMotion = prefersReducedMotion();
      const grouped = new Map<WorkspaceGroupKind, WorkspaceSession[]>([
        ["needs-user", []],
        ["working", []],
        ["settled", []],
      ]);

      for (const session of sessions.values()) {
        const project = projects.get(session.projectId);
        if (!project) continue;
        grouped.get(groupFor(session))!.push({
          projectId: project.id,
          projectName: project.name,
          sessionId: session.id,
          name: session.name,
          status: session.status,
          foregroundProcess: session.foregroundProcess,
          exitCode: session.exitCode,
          attention: session.attention,
          attentionProvenance: session.attentionProvenance,
          attentionReason: session.attentionReason,
          density: densityFor(session, nowAt),
          selected: session.selected,
          pinned: session.pinned,
          createdAt: session.createdAt,
          lastActivityAt: session.lastActivityAt,
          reducedMotion,
        });
      }

      const groups: WorkspaceGroup[] = [];
      for (const kind of ["needs-user", "working", "settled"] as const) {
        const groupSessions = grouped.get(kind)!;
        if (groupSessions.length === 0) continue;
        groupSessions.sort((left, right) => {
          if (left.selected !== right.selected) return left.selected ? -1 : 1;
          if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
          if (left.lastActivityAt !== right.lastActivityAt) {
            return right.lastActivityAt - left.lastActivityAt;
          }
          return (
            compareText(left.projectId, right.projectId) ||
            compareText(left.sessionId, right.sessionId) ||
            compareText(left.name, right.name)
          );
        });
        groups.push({ kind, sessions: groupSessions });
      }

      return { groups, reducedMotion };
    },
  };
}
