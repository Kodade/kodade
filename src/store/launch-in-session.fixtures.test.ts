// Standing-guard fixtures for the terminal-hosting spawn path (v2.0 P4 slice 3).
//
// These record the CURRENT (chat-first) behavior of `launchInSession` and the
// `canOpenLoginTerminal` predicate BEFORE the project-scope fix, so the change
// is reviewable against pinned behavior. Cases that the fix intentionally
// changes are updated in the fix commit itself, each with a comment noting the
// deliberate behavior change; every other case must keep passing unmodified.

import { describe, expect, it } from "vitest";
import { MockStorage } from "../ipc/mock";
import {
  createProjectsStore,
  isChatSession,
  type ProjectsState,
} from "./projects";
import { canOpenLoginTerminal, openLoginTerminal } from "../providers/login";
import { projectTerminalGroups } from "../components/sidebar/terminals";
import { remoteProjectId, type RemoteTarget } from "../ssh/model";

// Fake registry that records opens/closes/writes (the store never sees xterm).
function fakeRegistry() {
  const opens: { id: string; cwd: string }[] = [];
  const closes: string[] = [];
  const writes: { id: string; data: string }[] = [];
  return {
    opens,
    closes,
    writes,
    registry: {
      open: (id: string, cwd: string) => void opens.push({ id, cwd }),
      close: async (id: string) => void closes.push(id),
      write: (id: string, data: string) => void writes.push({ id, data }),
    },
  };
}

function idGen() {
  let n = 0;
  return () => `id-${++n}`;
}

// The v2 chat-first runtime is the interesting case: autoStartTerminal === false
// means a local PTY is never a free-standing root — the whole point of the
// slice-3 fix. Default the fixtures to that mode.
function makeStore(autoStartTerminal = false) {
  const { opens, closes, writes, registry } = fakeRegistry();
  const store = createProjectsStore({
    storage: new MockStorage(),
    registry,
    newId: idGen(),
    autoStartTerminal,
  });
  void store.getState().hydrate();
  return { store, opens, closes, writes };
}

// A minimal ProjectsState for the pure predicate. Only the fields
// canOpenLoginTerminal reads matter; the rest are never touched.
function predicateState(
  overrides: Partial<
    Pick<
      ProjectsState,
      "activeProjectId" | "remoteTargets" | "activeSessionByProject" | "sessions"
    >
  >,
): ProjectsState {
  return {
    activeProjectId: null,
    remoteTargets: [],
    activeSessionByProject: {},
    sessions: [],
    ...overrides,
  } as ProjectsState;
}

describe("canOpenLoginTerminal — login availability truth table", () => {
  it("no active project → false", () => {
    expect(canOpenLoginTerminal(predicateState({ activeProjectId: null }))).toBe(
      false,
    );
  });

  it("remote target for the active project → true", () => {
    const target: RemoteTarget = { host: "box", path: "/srv/app" };
    const projectId = remoteProjectId(target);
    expect(
      canOpenLoginTerminal(
        predicateState({ activeProjectId: projectId, remoteTargets: [target] }),
      ),
    ).toBe(true);
  });

  it("local project with the selected session a chat → true", () => {
    expect(
      canOpenLoginTerminal(
        predicateState({
          activeProjectId: "p1",
          activeSessionByProject: { p1: "chat-1" },
          sessions: [
            { id: "chat-1", projectId: "p1", name: "claude 1", kind: "chat" },
          ],
        }),
      ),
    ).toBe(true);
  });

  // Slice 3 intentionally changes these two: a login shell hosts at project
  // scope, so an active project can open one with a non-chat terminal selected
  // or with nothing selected. Recorded here as the new (after) behavior.
  it("local project with a non-chat terminal selected → true (after slice 3)", () => {
    expect(
      canOpenLoginTerminal(
        predicateState({
          activeProjectId: "p1",
          activeSessionByProject: { p1: "term-1" },
          sessions: [{ id: "term-1", projectId: "p1", name: "zsh 1" }],
        }),
      ),
    ).toBe(true);
  });

  it("local project with nothing selected → true (after slice 3)", () => {
    expect(
      canOpenLoginTerminal(
        predicateState({
          activeProjectId: "p1",
          activeSessionByProject: {},
          sessions: [],
        }),
      ),
    ).toBe(true);
  });
});

describe("launchInSession — chat-owned and project-scoped hosting", () => {
  it("chat selected → hosts a terminal owned by that chat and types the command", async () => {
    const { store, opens, writes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const chatId = store.getState().addChatThread(projectId, "claude")!;

    await store.getState().launchInSession("claude", "claude");

    const terminal = store
      .getState()
      .sessions.find((session) => !isChatSession(session))!;
    // The PTY hangs off the selected chat, and the chat keeps the selection.
    expect(terminal.workspaceId).toBe(chatId);
    expect(store.getState().activeSessionByProject[projectId]).toBe(chatId);
    expect(opens).toEqual([{ id: terminal.id, cwd: "/repos/alpha" }]);
    expect(writes).toEqual([{ id: terminal.id, data: "claude\r" }]);
  });

  it("chat selected twice → reuses the same chat-owned terminal", async () => {
    const { store, opens, writes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    store.getState().addChatThread(projectId, "claude");

    await store.getState().launchInSession("claude", "claude");
    await store.getState().launchInSession("claude --resume", "claude");

    const terminals = store
      .getState()
      .sessions.filter((session) => !isChatSession(session));
    expect(terminals).toHaveLength(1);
    expect(opens).toHaveLength(1);
    expect(writes).toEqual([
      { id: terminals[0].id, data: "claude\r" },
      { id: terminals[0].id, data: "claude --resume\r" },
    ]);
  });

  // Slice 3 intentionally changes this: with no chat selected the launcher now
  // hosts a project-scoped standalone terminal instead of throwing. Recorded
  // here as the new (after) behavior.
  it("no session selected → hosts a project-scoped terminal (after slice 3)", async () => {
    const { store, opens, writes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    // v2 shell opens no session on project add, so nothing is selected.
    expect(store.getState().activeSessionByProject).toEqual({});

    await store.getState().launchInSession("claude", "claude");

    const terminal = store
      .getState()
      .sessions.find((session) => !isChatSession(session))!;
    // A standalone terminal (no chat/work owner), selected so the login shows.
    expect(terminal.workspaceId).toBeUndefined();
    expect(store.getState().activeSessionByProject[projectId]).toBe(terminal.id);
    expect(opens).toEqual([{ id: terminal.id, cwd: "/repos/alpha" }]);
    expect(writes).toEqual([{ id: terminal.id, data: "claude\r" }]);
  });

  // Slice 3 intentionally changes this: a non-chat selection now reuses that
  // standalone terminal instead of throwing. Recorded as the new behavior.
  it("a non-chat terminal selected → reuses it at project scope (after slice 3)", async () => {
    const { store, opens, writes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    store.setState({
      sessions: [{ id: "term-1", projectId, name: "zsh 1" }],
      activeSessionByProject: { [projectId]: "term-1" },
    });

    await store.getState().launchInSession("claude", "claude");

    // No new session created — the selected standalone terminal is the host.
    expect(store.getState().sessions).toHaveLength(1);
    expect(opens).toHaveLength(0); // reused host was never (re)opened here
    expect(writes).toEqual([{ id: "term-1", data: "claude\r" }]);
  });

  it("no active project → throws 'open a project first'", async () => {
    const { store } = makeStore();
    await expect(
      store.getState().launchInSession("claude", "claude"),
    ).rejects.toThrow("open a project first");
  });
});

describe("openLoginTerminal — project-scope availability (after slice 3)", () => {
  // Slice 3 intentionally changes this: with no chat open the login terminal
  // now hosts at project scope and types the provider's login command.
  it("no chat open → openLoginTerminal opens a project-scoped login shell", async () => {
    const { store, opens, writes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;

    await openLoginTerminal(store, "claude");

    const terminal = store
      .getState()
      .sessions.find((session) => !isChatSession(session))!;
    expect(terminal.workspaceId).toBeUndefined();
    expect(store.getState().activeSessionByProject[projectId]).toBe(terminal.id);
    expect(opens).toEqual([{ id: terminal.id, cwd: "/repos/alpha" }]);
    // "claude" provider's login command (see providers/catalog).
    expect(writes).toEqual([{ id: terminal.id, data: "claude auth login\r" }]);
  });

  // An agent run (a KödWork task) is a plain child process, but its login
  // terminal used to require a chat. It now hosts at project scope: a
  // persona-prepared task whose provider needs login can sign in with zero
  // chat threads in the project.
  it("agent run with no chats → openLoginTerminal hosts a login shell", async () => {
    const { store, opens, writes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    // The run itself: a background work session, no PTY, no chat.
    const taskId = store.getState().addWorkSession(projectId)!;
    expect(store.getState().sessions.find((s) => s.id === taskId)?.kind).toBe(
      "work",
    );
    expect(store.getState().sessions.some(isChatSession)).toBe(false);

    await openLoginTerminal(store, "claude");

    const terminal = store
      .getState()
      .sessions.find(
        (session) => session.id !== taskId && !isChatSession(session),
      )!;
    expect(terminal.kind).toBeUndefined(); // a real PTY terminal
    expect(terminal.workspaceId).toBeUndefined(); // project-scoped, not embedded
    expect(opens).toEqual([{ id: terminal.id, cwd: "/repos/alpha" }]);
    expect(writes).toEqual([{ id: terminal.id, data: "claude auth login\r" }]);
  });
});

describe("project-scoped login terminal — sidebar visibility and cleanup", () => {
  it("appears as a standalone terminal group and cleans up on close", async () => {
    const { store, closes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;

    await openLoginTerminal(store, "claude");
    const terminal = store
      .getState()
      .sessions.find((session) => !isChatSession(session))!;

    // Both shells render this projection; the login terminal shows as its own
    // standalone group (root), not embedded under a chat or task.
    const groups = projectTerminalGroups(store.getState().sessions, projectId);
    expect(groups).toHaveLength(1);
    expect(groups[0].root.id).toBe(terminal.id);
    expect(groups[0].children).toHaveLength(0);

    // Killable and cleaned up like any terminal: registry.close + removed.
    await store.getState().closeSession(terminal.id);
    expect(closes).toContain(terminal.id);
    expect(
      store.getState().sessions.some((session) => session.id === terminal.id),
    ).toBe(false);
    expect(
      projectTerminalGroups(store.getState().sessions, projectId),
    ).toHaveLength(0);
  });

  it("is first-class selectable in the chat-first runtime", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;

    await openLoginTerminal(store, "claude");
    const terminal = store
      .getState()
      .sessions.find((session) => !isChatSession(session))!;

    // Navigate away, then click the terminal's sidebar row: it selects itself
    // (a chat-owned terminal would normalize back to its chat instead).
    const chatId = store.getState().addChatThread(projectId, "codex")!;
    expect(store.getState().activeSessionByProject[projectId]).toBe(chatId);
    await store.getState().activateSession(projectId, terminal.id);
    expect(store.getState().activeSessionByProject[projectId]).toBe(terminal.id);
  });
});
