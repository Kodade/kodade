import { describe, expect, it } from "vitest";
import { createActivityAdapters } from "./adapters";
import { createActivityModule } from "./activity";

describe("activity adapters", () => {
  it("timestamps low-sensitivity store and terminal facts before replay", () => {
    let now = 10;
    const activity = createActivityModule();
    const adapters = createActivityAdapters(activity, () => now);

    adapters.workspace({
      type: "project-added",
      projectId: "p",
      projectName: "Kodade",
    });
    adapters.workspace({
      type: "session-created",
      projectId: "p",
      sessionId: "s",
      name: "codex 1",
    });
    adapters.workspace({
      type: "session-selected",
      projectId: "p",
      sessionId: "s",
    });

    now = 20;
    adapters.terminalOutput("p", "s");
    now = 30;
    adapters.workspace({
      type: "terminal-foreground",
      projectId: "p",
      sessionId: "s",
      process: "codex",
    });
    now = 40;
    adapters.file({ type: "file-saved", root: "/repo" }, "p", "s");

    const session = activity.workspaceView(40).groups[0].sessions[0];
    expect(session).toMatchObject({
      sessionId: "s",
      status: "working",
      attention: "none",
      lastActivityAt: 40,
    });
  });
});
