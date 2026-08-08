import { afterEach, describe, expect, it } from "vitest";
import { appStore, filesStore, resolveVoiceTarget, voiceCommandActions } from "./appStore";

const originalTargetState = {
  projects: appStore.getState().projects,
  sessions: appStore.getState().sessions,
  activeProjectId: appStore.getState().activeProjectId,
  activeSessionByProject: appStore.getState().activeSessionByProject,
  remoteTargets: appStore.getState().remoteTargets,
};
const originalSetRoot = filesStore.getState().setRoot;

// Regression (M9f): the "send" voice command writes directly through the
// terminal registry (not the dictation insertion path, which strips trailing
// newlines and would swallow the carriage return). registry.write() rejects
// for a session that was never opened or has since closed — that rejection
// must never escape as an unhandled promise rejection; "send" has to no-op
// as gracefully as every other out-of-range voice command.
describe("voiceCommandActions.submit (M9f)", () => {
  afterEach(() => {
    appStore.setState(originalTargetState);
  });

  it("no-ops without throwing when there is no active project", async () => {
    appStore.setState({ activeProjectId: null, activeSessionByProject: {} });
    await expect(voiceCommandActions.submit()).resolves.toBeUndefined();
  });

  it("no-ops without throwing when the project has no active session", async () => {
    appStore.setState({
      activeProjectId: "project-x",
      activeSessionByProject: {},
    });
    await expect(voiceCommandActions.submit()).resolves.toBeUndefined();
  });

  it("no-ops gracefully (no unhandled rejection) against a dead/closed session", async () => {
    appStore.setState({
      activeProjectId: "project-x",
      // Never opened in the terminal registry — this is what a closed/dead
      // session looks like from submit()'s point of view.
      activeSessionByProject: { "project-x": "session-never-opened" },
    });
    await expect(voiceCommandActions.submit()).resolves.toBeUndefined();
  });
});

describe("voiceCommandActions.newSession", () => {
  afterEach(() => {
    appStore.setState(originalTargetState);
  });

  it("does not create a hidden terminal outside KödChat's explicit Show terminal control", () => {
    appStore.setState({
      projects: [{ id: "project-x", name: "Project", path: "/project" }],
      sessions: [{ id: "chat-x", projectId: "project-x", kind: "chat", name: "claude 1" }],
      activeProjectId: "project-x",
      activeSessionByProject: { "project-x": "chat-x" },
    });

    voiceCommandActions.newSession();

    expect(appStore.getState().sessions).toEqual([
      { id: "chat-x", projectId: "project-x", kind: "chat", name: "claude 1" },
    ]);
  });
});

describe("voiceCommandActions session navigation", () => {
  afterEach(() => {
    appStore.setState(originalTargetState);
  });

  it("keeps local navigation on chats when an owned terminal is in the session list", () => {
    appStore.setState({
      sessions: [
        { id: "chat-1", projectId: "project-x", kind: "chat", name: "claude 1" },
        {
          id: "terminal-1",
          projectId: "project-x",
          workspaceId: "chat-1",
          name: "zsh 1",
        },
        { id: "chat-2", projectId: "project-x", kind: "chat", name: "codex 1" },
      ],
      activeProjectId: "project-x",
      activeSessionByProject: { "project-x": "chat-2" },
      remoteTargets: [],
    });

    voiceCommandActions.prevTerminal();
    expect(appStore.getState().activeSessionByProject["project-x"]).toBe("chat-1");
    expect(voiceCommandActions.switchTerminal(2)).toBe(true);
    expect(appStore.getState().activeSessionByProject["project-x"]).toBe("chat-2");
  });
});

describe("resolveVoiceTarget — KödWhisper terminal fallback", () => {
  afterEach(() => {
    appStore.setState(originalTargetState);
    filesStore.setState({ setRoot: originalSetRoot });
  });

  it("uses the live active terminal when the document body has focus", () => {
    filesStore.setState({ setRoot: async () => undefined });
    appStore.setState({
      projects: [{ id: "project-1", name: "Project", path: "/project" }],
      sessions: [{ id: "session-live", projectId: "project-1", name: "zsh 1" }],
      activeProjectId: "project-1",
      activeSessionByProject: { "project-1": "session-live" },
    });
    document.body.focus();

    expect(resolveVoiceTarget()).toEqual({ kind: "terminal", sessionId: "session-live" });
  });

  it("does not use an exited active terminal as the fallback", () => {
    filesStore.setState({ setRoot: async () => undefined });
    appStore.setState({
      projects: [{ id: "project-1", name: "Project", path: "/project" }],
      sessions: [{ id: "session-exited", projectId: "project-1", name: "zsh 1", exited: true }],
      activeProjectId: "project-1",
      activeSessionByProject: { "project-1": "session-exited" },
    });
    document.body.focus();

    expect(resolveVoiceTarget()).toBeNull();
  });

  it("does not use an active-session id belonging to another project", () => {
    filesStore.setState({ setRoot: async () => undefined });
    appStore.setState({
      projects: [{ id: "project-1", name: "Project", path: "/project" }],
      sessions: [{ id: "session-other-project", projectId: "project-2", name: "zsh 1" }],
      activeProjectId: "project-1",
      activeSessionByProject: { "project-1": "session-other-project" },
    });
    document.body.focus();

    expect(resolveVoiceTarget()).toBeNull();
  });
});
