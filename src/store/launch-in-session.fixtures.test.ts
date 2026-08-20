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

describe("canOpenLoginTerminal — chat-first truth table (before slice 3)", () => {
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

  it("local project with a non-chat terminal selected → false (before)", () => {
    expect(
      canOpenLoginTerminal(
        predicateState({
          activeProjectId: "p1",
          activeSessionByProject: { p1: "term-1" },
          sessions: [{ id: "term-1", projectId: "p1", name: "zsh 1" }],
        }),
      ),
    ).toBe(false);
  });

  it("local project with nothing selected → false (before)", () => {
    expect(
      canOpenLoginTerminal(
        predicateState({
          activeProjectId: "p1",
          activeSessionByProject: {},
          sessions: [],
        }),
      ),
    ).toBe(false);
  });
});

describe("launchInSession — chat-first hosting (before slice 3)", () => {
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

  it("no session selected → throws 'could not create a terminal session' (before)", async () => {
    const { store, opens } = makeStore();
    await store.getState().addProject("/repos/alpha");
    // v2 shell opens no session on project add, so nothing is selected. With no
    // selected session at all, the launcher can't tell the caller to pick a
    // chat, so it reports the generic creation failure.
    expect(store.getState().activeSessionByProject).toEqual({});

    await expect(
      store.getState().launchInSession("claude", "claude"),
    ).rejects.toThrow("could not create a terminal session");
    expect(opens).toHaveLength(0);
  });

  it("a non-chat session selected → throws the same chat-first error (before)", async () => {
    const { store, opens } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    // Force a non-chat session to be the selected one. Normal selection would
    // normalize back to a chat, so record the raw predicate the launcher sees.
    store.setState({
      sessions: [{ id: "term-1", projectId, name: "zsh 1" }],
      activeSessionByProject: { [projectId]: "term-1" },
    });

    await expect(
      store.getState().launchInSession("claude", "claude"),
    ).rejects.toThrow("select a chat before starting an agent");
    expect(opens).toHaveLength(0);
  });

  it("no active project → throws 'open a project first'", async () => {
    const { store } = makeStore();
    await expect(
      store.getState().launchInSession("claude", "claude"),
    ).rejects.toThrow("open a project first");
  });
});

describe("openLoginTerminal — chat-first availability (before slice 3)", () => {
  it("no chat open → openLoginTerminal rejects because it has no host (before)", async () => {
    const { store, opens } = makeStore();
    await store.getState().addProject("/repos/alpha");

    await expect(openLoginTerminal(store, "claude")).rejects.toThrow(
      "could not create a terminal session",
    );
    expect(opens).toHaveLength(0);
  });
});
