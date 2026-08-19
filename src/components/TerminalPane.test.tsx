import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockStorage } from "../ipc/mock";
import { createProjectsStore } from "../store/projects";
import { TerminalPane, type TerminalDisplayRegistry } from "./TerminalPane";

function fakeTerminalRegistry(): TerminalDisplayRegistry & {
  sync: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const hosts = new Map<string, HTMLElement>();
  return {
    open(id) {
      const host = document.createElement("div");
      host.dataset.terminalSessionId = id;
      hosts.set(id, host);
    },
    ready: async () => undefined,
    close: vi.fn(async (id: string) => {
      hosts.get(id)?.remove();
      hosts.delete(id);
    }),
    write: async () => undefined,
    sync: vi.fn((container: HTMLElement, visible: string | string[] | null) => {
      for (const host of hosts.values()) {
        if (host.parentElement !== container) container.appendChild(host);
      }
      const visibleIds = new Set(
        Array.isArray(visible) ? visible : visible ? [visible] : [],
      );
      for (const [id, host] of hosts) {
        host.style.display = visibleIds.has(id) ? "" : "none";
      }
    }),
  };
}

describe("TerminalPane splits", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function renderPane({
    selectChat = false,
    workspaceTerminal = false,
  } = {}) {
    const terminalRegistry = fakeTerminalRegistry();
    const projectsStore = createProjectsStore({
      storage: new MockStorage(),
      registry: terminalRegistry,
      newId: (() => {
        let id = 0;
        return () => `session-${++id}`;
      })(),
    });
    await projectsStore.getState().hydrate();
    await projectsStore.getState().addProject("/repo");
    let initialTerminalId = projectsStore.getState().sessions[0].id;
    let workspaceId: string | undefined;
    if (workspaceTerminal) {
      await projectsStore.getState().closeSession(initialTerminalId);
      const projectId = projectsStore.getState().projects[0].id;
      workspaceId = projectsStore
        .getState()
        .addChatThread(projectId, "claude")!;
      initialTerminalId = projectsStore
        .getState()
        .addTerminal(projectId, workspaceId)!;
      projectsStore.getState().setActiveSession(projectId, workspaceId);
    } else if (selectChat) {
      projectsStore
        .getState()
        .addChatThread(projectsStore.getState().projects[0].id, "claude");
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <TerminalPane
          projectsStore={projectsStore}
          terminalRegistry={terminalRegistry}
          voiceControls={null}
          workspaceId={workspaceId}
        />,
      ),
    );
    return {
      projectsStore,
      terminalRegistry,
      initialTerminalId,
      // Re-render the same pane with a new focus nonce (the v2 shell's
      // tab-reactivation path); the pane is never remounted.
      async bumpFocusNonce(focusNonce: number) {
        await act(async () =>
          root?.render(
            <TerminalPane
              projectsStore={projectsStore}
              terminalRegistry={terminalRegistry}
              voiceControls={null}
              workspaceId={workspaceId}
              focusNonce={focusNonce}
            />,
          ),
        );
      },
    };
  }

  it("re-asserts the active terminal's focus when the focus nonce changes", async () => {
    const { terminalRegistry, initialTerminalId, bumpFocusNonce } =
      await renderPane();
    const before = terminalRegistry.sync.mock.calls.length;

    await bumpFocusNonce(1);

    const calls = terminalRegistry.sync.mock.calls;
    expect(calls.length).toBeGreaterThan(before);
    // sync(container, visible, activeId) — the third argument is what the
    // registry focuses.
    expect(calls.at(-1)?.[2]).toBe(initialTerminalId);
  });

  it("splits the active terminal side by side and keeps both sessions alive", async () => {
    const { projectsStore, terminalRegistry } = await renderPane();
    const first = projectsStore.getState().sessions[0];
    const split = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Split terminal ${first.name} vertically"]`,
    );

    await act(async () => split?.click());

    expect(projectsStore.getState().sessions).toHaveLength(2);
    const visibleIds = projectsStore.getState().sessions.map((session) => session.id);
    expect(projectsStore.getState().sessions[1].workspaceId).toBe(visibleIds[0]);
    const terminalHost = container!.querySelector<HTMLElement>(
      "[data-terminal-layout]",
    );
    expect(terminalHost?.dataset.terminalLayout).toBe("vertical");
    const lastSync = terminalRegistry.sync.mock.calls.at(-1);
    expect(lastSync?.[1]).toEqual(visibleIds);
  });

  it("can stack split terminals horizontally", async () => {
    const { projectsStore, terminalRegistry } = await renderPane();
    const first = projectsStore.getState().sessions[0];
    const split = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Split terminal ${first.name} horizontally"]`,
    );

    await act(async () => split?.click());

    expect(
      container!.querySelector<HTMLElement>("[data-terminal-layout]")?.dataset
        .terminalLayout,
    ).toBe("horizontal");
    expect(terminalRegistry.sync.mock.calls.at(-1)?.[1]).toHaveLength(2);
  });

  it("puts split controls on each terminal window", async () => {
    const { projectsStore } = await renderPane();
    const first = projectsStore.getState().sessions[0];
    const firstSplit = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Split terminal ${first.name} horizontally"]`,
    );
    expect(firstSplit).not.toBeNull();

    await act(async () => firstSplit?.click());

    for (const session of projectsStore.getState().sessions) {
      expect(
        container!.querySelector(
          `button[aria-label="Split terminal ${session.name} vertically"]`,
        ),
      ).not.toBeNull();
      expect(
        container!.querySelector(
          `button[aria-label="Split terminal ${session.name} horizontally"]`,
        ),
      ).not.toBeNull();
    }
    expect(
      container!.querySelector('button[aria-label="Split terminal vertically"]'),
    ).toBeNull();
  });

  it("offers a direct new-terminal action when the active project has no shell", async () => {
    const { projectsStore } = await renderPane();
    const existing = projectsStore.getState().sessions[0];
    await act(async () => {
      await projectsStore.getState().closeSession(existing.id);
    });

    const start = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="New terminal"]',
    );
    expect(start?.textContent).toContain("New terminal");

    await act(async () => start?.click());

    expect(projectsStore.getState().sessions).toHaveLength(1);
  });

  it("shows the latest project terminal beside a selected chat", async () => {
    const { terminalRegistry, initialTerminalId } = await renderPane({
      selectChat: true,
    });

    expect(terminalRegistry.sync.mock.calls.at(-1)?.[1]).toEqual([
      initialTerminalId,
    ]);
    expect(
      container!.querySelector(
        `[data-terminal-leaf-id="${initialTerminalId}"]`,
      ),
    ).not.toBeNull();
  });

  it("keeps a chat-owned terminal scoped and the thread selected when split", async () => {
    const { projectsStore, terminalRegistry, initialTerminalId } =
      await renderPane({ workspaceTerminal: true });
    const state = projectsStore.getState();
    const projectId = state.projects[0].id;
    const threadId = state.sessions.find((session) => session.kind === "chat")!.id;
    const first = state.sessions.find((session) => session.id === initialTerminalId)!;
    const split = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Split terminal ${first.name} vertically"]`,
    );

    await act(async () => split?.click());

    const next = projectsStore.getState();
    const terminals = next.sessions.filter((session) => session.kind !== "chat");
    expect(terminals).toHaveLength(2);
    expect(terminals.every((session) => session.workspaceId === threadId)).toBe(true);
    expect(next.activeSessionByProject[projectId]).toBe(threadId);
    expect(terminalRegistry.sync.mock.calls.at(-1)?.[1]).toEqual(
      terminals.map((session) => session.id),
    );
  });

  it("splits only the active leaf inside an existing split", async () => {
    const { projectsStore, terminalRegistry } = await renderPane();
    const first = projectsStore.getState().sessions[0];
    const horizontalSplit = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Split terminal ${first.name} horizontally"]`,
    );
    await act(async () => horizontalSplit?.click());

    const [topId, bottomId] = projectsStore
      .getState()
      .sessions.map((session) => session.id);
    const topTerminal = container!.querySelector<HTMLElement>(
      `[data-terminal-session-id="${topId}"]`,
    );
    await act(async () => {
      topTerminal?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    const verticalSplit = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Split terminal ${projectsStore.getState().sessions[0].name} vertically"]`,
    );
    await act(async () => verticalSplit?.click());

    const thirdId = projectsStore.getState().sessions.at(-1)!.id;
    expect(terminalRegistry.sync.mock.calls.at(-1)?.[1]).toEqual([
      topId,
      thirdId,
      bottomId,
    ]);
    expect(
      container!.querySelector(`[data-terminal-leaf-id="${topId}"]`),
    ).toMatchObject({
      dataset: {
        terminalLeft: "0",
        terminalTop: "0",
        terminalWidth: "50",
        terminalHeight: "50",
      },
    });
    expect(
      container!.querySelector(`[data-terminal-leaf-id="${thirdId}"]`),
    ).toMatchObject({
      dataset: {
        terminalLeft: "50",
        terminalTop: "0",
        terminalWidth: "50",
        terminalHeight: "50",
      },
    });
    expect(
      container!.querySelector(`[data-terminal-leaf-id="${bottomId}"]`),
    ).toMatchObject({
      dataset: {
        terminalLeft: "0",
        terminalTop: "50",
        terminalWidth: "100",
        terminalHeight: "50",
      },
    });
  });

  it("closes one split terminal without closing its workspace siblings", async () => {
    const { projectsStore, terminalRegistry } = await renderPane();
    const first = projectsStore.getState().sessions[0];
    const split = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Split terminal ${first.name} horizontally"]`,
    );
    await act(async () => split?.click());

    const [close, keep] = projectsStore.getState().sessions;
    const closeButton = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Close terminal ${close.name}"]`,
    );
    await act(async () => {
      closeButton?.click();
      await Promise.resolve();
    });

    expect(projectsStore.getState().sessions.map((session) => session.id)).toEqual([
      keep.id,
    ]);
    expect(projectsStore.getState().sessions[0].workspaceId).toBeUndefined();
    expect(terminalRegistry.close).toHaveBeenCalledWith(close.id);
    expect(terminalRegistry.sync.mock.calls.at(-1)?.[1]).toEqual([keep.id]);
  });

  it("maximizes one terminal over the split layout and restores it", async () => {
    const { projectsStore, terminalRegistry } = await renderPane();
    const initial = projectsStore.getState().sessions[0];
    const split = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Split terminal ${initial.name} horizontally"]`,
    );
    await act(async () => split?.click());
    const [first, second] = projectsStore.getState().sessions;

    const maximize = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Maximize terminal ${first.name}"]`,
    );
    await act(async () => maximize?.click());

    const terminalLayout = container!.querySelector<HTMLElement>(
      "[data-terminal-layout]",
    );
    expect(terminalLayout?.dataset.terminalMaximized).toBe(first.id);
    expect(terminalRegistry.sync.mock.calls.at(-1)?.[1]).toEqual([first.id]);
    expect(projectsStore.getState().sessions).toHaveLength(2);

    const restore = container!.querySelector<HTMLButtonElement>(
      `button[aria-label="Restore terminal ${first.name}"]`,
    );
    await act(async () => restore?.click());

    expect(terminalLayout?.dataset.terminalMaximized).toBe("");
    expect(terminalRegistry.sync.mock.calls.at(-1)?.[1]).toEqual([
      first.id,
      second.id,
    ]);
  });
});
