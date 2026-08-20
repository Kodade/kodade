import { describe, expect, it } from "vitest";
import {
  RECENT_ACTIVITY_MS,
  STABILITY_WINDOW_MS,
  createActivityModule,
  type ActivityEvent,
} from "./activity";

function replay(events: ActivityEvent[], reducedMotion = false) {
  const activity = createActivityModule({ reducedMotion, now: () => 0 });
  for (const event of events) activity.observe(event);
  return activity;
}

describe("ActivityModule", () => {
  it("projects separate status, attention, and density into deterministic groups", () => {
    const activity = replay([
      { type: "project-added", at: 0, projectId: "p1", projectName: "Kodade" },
      { type: "project-added", at: 0, projectId: "p2", projectName: "Website" },
      {
        type: "session-created",
        at: 1,
        projectId: "p1",
        sessionId: "idle",
        name: "zsh 1",
      },
      {
        type: "session-created",
        at: 2,
        projectId: "p1",
        sessionId: "working",
        name: "codex 1",
      },
      {
        type: "session-created",
        at: 3,
        projectId: "p2",
        sessionId: "needs",
        name: "claude 1",
      },
      {
        type: "session-created",
        at: 4,
        projectId: "p2",
        sessionId: "failed",
        name: "zsh 1",
      },
      { type: "session-selected", at: 5, projectId: "p1", sessionId: "idle" },
      {
        type: "terminal-foreground",
        at: 6,
        projectId: "p1",
        sessionId: "working",
        process: "codex",
      },
      { type: "terminal-output", at: 7, projectId: "p2", sessionId: "needs" },
      {
        type: "attention-reported",
        at: 8,
        projectId: "p2",
        sessionId: "needs",
        attention: "needs-user",
        provenance: "mcp",
        reason: "Needs a decision",
      },
      {
        type: "terminal-exited",
        at: 9,
        projectId: "p2",
        sessionId: "failed",
        code: 1,
      },
    ]);

    const view = activity.workspaceView(10);

    expect(view.groups.map((group) => group.kind)).toEqual([
      "needs-user",
      "working",
      "settled",
    ]);
    expect(view.groups[0].sessions).toMatchObject([
      {
        sessionId: "needs",
        projectId: "p2",
        status: "idle",
        attention: "needs-user",
        attentionProvenance: "mcp",
        attentionReason: "Needs a decision",
        density: "expanded",
      },
    ]);
    expect(view.groups[1].sessions).toMatchObject([
      {
        sessionId: "working",
        status: "working",
        attention: "none",
        density: "standard",
      },
    ]);
    expect(view.groups[2].sessions).toMatchObject([
      {
        sessionId: "idle",
        selected: true,
        status: "idle",
        attention: "none",
        density: "expanded",
      },
      {
        sessionId: "failed",
        status: "failed",
        attention: "none",
        density: "expanded",
      },
    ]);
  });

  it("never infers needs-user from terminal output and acknowledges unread independently", () => {
    const activity = replay([
      { type: "project-added", at: 0, projectId: "p", projectName: "Kodade" },
      {
        type: "session-created",
        at: 0,
        projectId: "p",
        sessionId: "selected",
        name: "zsh 1",
      },
      {
        type: "session-created",
        at: 0,
        projectId: "p",
        sessionId: "output",
        name: "codex 1",
      },
      {
        type: "session-selected",
        at: 1,
        projectId: "p",
        sessionId: "selected",
      },
      { type: "terminal-output", at: 2, projectId: "p", sessionId: "output" },
    ]);

    expect(
      activity
        .workspaceView(2)
        .groups[0].sessions.find((session) => session.sessionId === "output"),
    ).toMatchObject({
      sessionId: "output",
      attention: "unread",
      attentionProvenance: null,
      status: "idle",
    });

    activity.acknowledge("output");
    expect(
      activity
        .workspaceView(2)
        .groups[0].sessions.find((session) => session.sessionId === "output"),
    ).toMatchObject({ sessionId: "output", attention: "none" });

    activity.observe({
      type: "attention-reported",
      at: 3,
      projectId: "p",
      sessionId: "output",
      attention: "needs-user",
      provenance: "provider",
      reason: "Confirm the migration",
    });
    activity.acknowledge("output");
    expect(activity.workspaceView(3).groups[0].sessions).toMatchObject([
      { sessionId: "output", attention: "needs-user" },
    ]);
  });

  it("does not resurrect attention from a delayed needs-user report after a newer clear", () => {
    const activity = replay([
      { type: "project-added", at: 0, projectId: "p", projectName: "Kodade" },
      {
        type: "session-created",
        at: 0,
        projectId: "p",
        sessionId: "s",
        name: "codex 1",
      },
      {
        type: "attention-reported",
        at: 20,
        projectId: "p",
        sessionId: "s",
        attention: "needs-user",
        provenance: "provider",
        reason: "Approve the migration",
      },
      {
        type: "attention-reported",
        at: 30,
        projectId: "p",
        sessionId: "s",
        attention: "none",
        provenance: "provider",
      },
      {
        type: "attention-reported",
        at: 25,
        projectId: "p",
        sessionId: "s",
        attention: "needs-user",
        provenance: "mcp",
        reason: "Delayed request",
      },
    ]);

    expect(activity.workspaceView(30).groups[0].sessions).toMatchObject([
      {
        sessionId: "s",
        attention: "none",
        attentionProvenance: null,
        attentionReason: null,
      },
    ]);
  });

  it("does not clear newer explicit attention with a delayed clear report", () => {
    const activity = replay([
      { type: "project-added", at: 0, projectId: "p", projectName: "Kodade" },
      {
        type: "session-created",
        at: 0,
        projectId: "p",
        sessionId: "s",
        name: "codex 1",
      },
      {
        type: "attention-reported",
        at: 30,
        projectId: "p",
        sessionId: "s",
        attention: "needs-user",
        provenance: "provider",
        reason: "Review the plan",
      },
      {
        type: "attention-reported",
        at: 20,
        projectId: "p",
        sessionId: "s",
        attention: "none",
        provenance: "mcp",
      },
    ]);

    expect(activity.workspaceView(30).groups[0].sessions).toMatchObject([
      {
        sessionId: "s",
        attention: "needs-user",
        attentionProvenance: "provider",
        attentionReason: "Review the plan",
      },
    ]);
  });

  it("refreshes recency for each accepted explicit attention transition", () => {
    const activity = replay([
      { type: "project-added", at: 0, projectId: "p", projectName: "Kodade" },
      {
        type: "session-created",
        at: 0,
        projectId: "p",
        sessionId: "s",
        name: "codex 1",
      },
      {
        type: "attention-reported",
        at: 20,
        projectId: "p",
        sessionId: "s",
        attention: "needs-user",
        provenance: "mcp",
        reason: "Choose a deployment target",
      },
      {
        type: "attention-reported",
        at: 30,
        projectId: "p",
        sessionId: "s",
        attention: "none",
        provenance: "mcp",
      },
    ]);
    const session = (now: number) =>
      activity.workspaceView(now).groups[0].sessions[0];

    expect(session(30)).toMatchObject({
      attention: "none",
      lastActivityAt: 30,
    });
    expect(session(30 + RECENT_ACTIVITY_MS - 1).density).toBe("standard");
  });

  it("uses activity timestamps and a stability window at exact clock boundaries", () => {
    const activity = replay([
      { type: "project-added", at: 0, projectId: "p", projectName: "Kodade" },
      {
        type: "session-created",
        at: 0,
        projectId: "p",
        sessionId: "s",
        name: "zsh 1",
      },
      { type: "terminal-output", at: 0, projectId: "p", sessionId: "s" },
    ]);

    const densityAt = (now: number) =>
      activity.workspaceView(now).groups[0].sessions[0].density;

    expect(densityAt(RECENT_ACTIVITY_MS - 1)).toBe("standard");
    expect(densityAt(RECENT_ACTIVITY_MS)).toBe("standard");
    expect(densityAt(RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS - 1)).toBe(
      "standard",
    );
    expect(densityAt(RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS)).toBe("compact");

    activity.observe({
      type: "attention-reported",
      at: 1_000_000,
      projectId: "p",
      sessionId: "s",
      attention: "needs-user",
      provenance: "mcp",
      reason: "A human decision is required",
    });
    expect(densityAt(1_000_000)).toBe("expanded");

    activity.observe({
      type: "attention-reported",
      at: 1_000_001,
      projectId: "p",
      sessionId: "s",
      attention: "none",
      provenance: "mcp",
    });
    expect(densityAt(1_000_001 + STABILITY_WINDOW_MS - 1)).toBe("expanded");
    expect(densityAt(1_000_001 + STABILITY_WINDOW_MS)).toBe("standard");
    expect(
      densityAt(
        1_000_001 + RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS,
      ),
    ).toBe("compact");
  });

  it("preserves foreground and exit metadata through activity lifecycle transitions", () => {
    const activity = replay([
      { type: "project-added", at: 0, projectId: "p", projectName: "Kodade" },
      {
        type: "session-created",
        at: 0,
        projectId: "p",
        sessionId: "s",
        name: "zsh 1",
      },
    ]);
    const session = (now: number) =>
      activity.workspaceView(now).groups[0].sessions[0];

    expect(session(0)).toMatchObject({
      status: "idle",
      foregroundProcess: null,
      exitCode: null,
    });

    activity.observe({
      type: "terminal-foreground",
      at: 1,
      projectId: "p",
      sessionId: "s",
      process: "codex",
    });
    expect(session(1)).toMatchObject({
      status: "working",
      foregroundProcess: "codex",
      exitCode: null,
    });

    activity.observe({
      type: "terminal-foreground",
      at: 2,
      projectId: "p",
      sessionId: "s",
      process: null,
    });
    expect(session(2)).toMatchObject({
      status: "idle",
      foregroundProcess: null,
      exitCode: null,
    });

    activity.observe({
      type: "terminal-exited",
      at: 3,
      projectId: "p",
      sessionId: "s",
      code: 1,
    });
    expect(session(3)).toMatchObject({
      status: "failed",
      foregroundProcess: null,
      exitCode: 1,
    });

    activity.observe({
      type: "session-closed",
      at: 4,
      projectId: "p",
      sessionId: "s",
    });
    activity.observe({
      type: "session-created",
      at: 5,
      projectId: "p",
      sessionId: "s",
      name: "zsh 2",
    });
    expect(session(5)).toMatchObject({
      name: "zsh 2",
      status: "idle",
      foregroundProcess: null,
      exitCode: null,
    });
  });

  it("keeps selected and pinned sessions visible without persisting density", () => {
    const activity = replay([
      { type: "project-added", at: 0, projectId: "p", projectName: "Kodade" },
      {
        type: "session-created",
        at: 0,
        projectId: "p",
        sessionId: "a",
        name: "zsh 1",
      },
      {
        type: "session-created",
        at: 0,
        projectId: "p",
        sessionId: "b",
        name: "zsh 2",
      },
      {
        type: "session-selected",
        at: RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS + 1,
        projectId: "p",
        sessionId: "a",
      },
    ]);

    const byId = (now: number, sessionId: string) =>
      activity
        .workspaceView(now)
        .groups.flatMap((group) => group.sessions)
        .find((session) => session.sessionId === sessionId)!;

    const firstSelectionAt = RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS + 1;
    expect(byId(firstSelectionAt, "a").density).toBe("expanded");
    activity.pin("b", true);
    expect(byId(1, "b").density).toBe("standard");
    activity.pin("b", false);
    expect(byId(STABILITY_WINDOW_MS - 1, "b").density).toBe("standard");
    expect(byId(RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS, "b").density).toBe(
      "compact",
    );

    const secondSelectionAt = firstSelectionAt + STABILITY_WINDOW_MS + 1;
    activity.observe({
      type: "session-selected",
      at: secondSelectionAt,
      projectId: "p",
      sessionId: "b",
    });
    expect(byId(secondSelectionAt, "a").density).toBe("expanded");
    expect(byId(secondSelectionAt + STABILITY_WINDOW_MS, "a").density).toBe(
      "compact",
    );
  });

  it("orders ties by project and session identity and returns reduced-motion data", () => {
    const activity = replay(
      [
        { type: "project-added", at: 0, projectId: "b", projectName: "Beta" },
        { type: "project-added", at: 0, projectId: "a", projectName: "Alpha" },
        {
          type: "session-created",
          at: 0,
          projectId: "b",
          sessionId: "b2",
          name: "zsh 2",
        },
        {
          type: "session-created",
          at: 0,
          projectId: "a",
          sessionId: "a2",
          name: "zsh 2",
        },
        {
          type: "session-created",
          at: 0,
          projectId: "a",
          sessionId: "a1",
          name: "zsh 1",
        },
      ],
      true,
    );

    const view = activity.workspaceView(
      RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS,
    );
    expect(view.reducedMotion).toBe(true);
    expect(view.groups[0].sessions.map((session) => session.sessionId)).toEqual(
      ["a1", "a2", "b2"],
    );
    expect(
      view.groups[0].sessions.every((session) => session.reducedMotion),
    ).toBe(true);
  });

  it("projects 500 sessions within the regression budget", () => {
    const activity = createActivityModule();
    activity.observe({
      type: "project-added",
      at: 0,
      projectId: "p",
      projectName: "Kodade",
    });
    for (let index = 0; index < 500; index++) {
      activity.observe({
        type: "session-created",
        at: index,
        projectId: "p",
        sessionId: `s-${String(index).padStart(3, "0")}`,
        name: `zsh ${index}`,
      });
    }

    // Warm up once (cold JIT/GC would otherwise dominate the first run), then
    // take the minimum elapsed across several runs. Min-of-N is robust to
    // scheduler noise and CI contention — a stray slow run never fails the
    // guard — while a genuine algorithmic regression raises the minimum too.
    // The stable minimum is ~0.25ms on a dev laptop, so a 5ms budget keeps
    // ~20x machine headroom while still catching a real complexity blow-up.
    const runOnce = () => {
      const started = performance.now();
      const view = activity.workspaceView(
        RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS + 1_000,
      );
      const elapsed = performance.now() - started;
      return { view, elapsed };
    };

    runOnce(); // warm-up, result discarded
    let best = runOnce();
    for (let run = 0; run < 4; run++) {
      const next = runOnce();
      if (next.elapsed < best.elapsed) best = next;
    }

    expect(best.view.groups[0].sessions).toHaveLength(500);
    expect(best.elapsed).toBeLessThan(5);
  });
});
