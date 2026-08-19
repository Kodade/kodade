// The v2 Code tab (#62): chat and terminal side by side, either one hideable
// or expandable — and NEITHER ever unmounted, because the terminal window hosts
// registry-owned xterm canvases.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatMounts: 0,
  terminalMounts: 0,
  chatProps: [] as Record<string, unknown>[],
  terminalProps: [] as Record<string, unknown>[],
  setLayouts: [] as Record<string, number>[],
  onLayoutChanged: null as
    | ((layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void)
    | null,
}));

vi.mock("../../store/appStore", async () => {
  const { createStore } = await import("zustand/vanilla");
  const { defaultShellLayout } = await import("./shell-layout");
  return {
    appStore: createStore((set) => ({
      shellLayout: defaultShellLayout(),
      setShellLayout: (shellLayout: unknown) => set({ shellLayout }),
    })),
  };
});

vi.mock("../chat/ChatPane", async () => {
  const React = await import("react");
  return {
    ChatPane: (props: Record<string, unknown>) => {
      mocks.chatProps.push(props);
      React.useEffect(() => {
        mocks.chatMounts += 1;
      }, []);
      // Stands in for the provider-login escape hatch, the one place the chat
      // genuinely needs the host's terminal.
      return (
        <div data-chat>
          <button
            type="button"
            data-testid="chat-login-terminal"
            onClick={() => (props.onTerminalRequest as (() => void) | undefined)?.()}
          />
        </div>
      );
    },
  };
});

vi.mock("../TerminalPane", async () => {
  const React = await import("react");
  return {
    TerminalPane: (props: Record<string, unknown>) => {
      mocks.terminalProps.push(props);
      React.useEffect(() => {
        mocks.terminalMounts += 1;
      }, []);
      return <div data-terminal />;
    },
  };
});

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");
  return {
    Group: ({
      children,
      groupRef,
      defaultLayout,
      onLayoutChanged,
    }: React.PropsWithChildren<{
      groupRef?: { current: unknown };
      defaultLayout?: Record<string, number>;
      onLayoutChanged?: (
        layout: Record<string, number>,
        meta: { isUserInteraction: boolean },
      ) => void;
    }>) => {
      if (groupRef) {
        groupRef.current = {
          setLayout: (layout: Record<string, number>) =>
            void mocks.setLayouts.push(layout),
        };
      }
      mocks.onLayoutChanged = onLayoutChanged ?? null;
      return (
        <div data-group data-default-layout={JSON.stringify(defaultLayout)}>
          {children}
        </div>
      );
    },
    Panel: ({
      children,
      id,
      minSize,
      maxSize,
    }: React.PropsWithChildren<{
      id: string;
      minSize?: number | string;
      maxSize?: number | string;
    }>) => (
      <div
        data-panel={id}
        data-min-size={String(minSize)}
        data-max-size={String(maxSize)}
      >
        {children}
      </div>
    ),
    Separator: ({ className }: { className?: string }) => (
      <div data-separator className={className} />
    ),
  };
});

import { appStore } from "../../store/appStore";
import { defaultShellLayout } from "./shell-layout";
import { CodeTab } from "./CodeTab";

describe("CodeTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mocks.chatMounts = 0;
    mocks.terminalMounts = 0;
    mocks.chatProps = [];
    mocks.terminalProps = [];
    mocks.setLayouts = [];
    mocks.onLayoutChanged = null;
    appStore.setState({ shellLayout: defaultShellLayout() });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (active = true) => act(() => root.render(<CodeTab active={active} />));
  const windowEl = (name: string) =>
    container.querySelector<HTMLElement>(`[data-code-window="${name}"]`)!;
  const click = (testId: string) =>
    act(() =>
      container
        .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
        .click(),
    );
  // Let the next-frame reassert run (jsdom's rAF is real here).
  const nextFrame = () =>
    act(
      async () =>
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        ),
    );
  // Where each window sits among its siblings, not just whether it still
  // exists: a moved wrapper would detach and re-insert the xterm subtree.
  const windowPositions = () =>
    [...container.querySelectorAll<HTMLElement>("[data-code-window]")].map(
      (el) => [
        el.dataset.codeWindow,
        [...el.parentElement!.parentElement!.children].indexOf(
          el.parentElement!,
        ),
      ],
    );

  it("opens with both windows at the saved split", () => {
    render();

    expect(windowEl("chat").style.display).toBe("");
    expect(windowEl("terminal").style.display).toBe("");
    const group = container.querySelector("[data-group]")!;
    expect(JSON.parse(group.getAttribute("data-default-layout")!)).toEqual({
      chat: 50,
      terminal: 50,
    });
    // KödChat's own terminal split is suppressed: one terminal surface only.
    expect(mocks.chatProps.at(-1)?.showTerminalToggle).toBe(false);
    // Both windows offer hide + expand while both are open.
    for (const id of [
      "code-hide-chat",
      "code-expand-chat",
      "code-hide-terminal",
      "code-expand-terminal",
    ]) {
      expect(
        container.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-label"),
      ).toBeTruthy();
    }
  });

  it("hides the chat window and offers to bring it back", () => {
    render();
    const terminal = windowEl("terminal");
    const chat = windowEl("chat");

    click("code-hide-chat");

    expect(appStore.getState().shellLayout.code.mode).toBe("terminal");
    expect(windowEl("chat").style.display).toBe("none");
    expect(windowEl("terminal").style.display).toBe("");
    // Hidden, never unmounted.
    expect(windowEl("chat")).toBe(chat);
    expect(windowEl("terminal")).toBe(terminal);
    expect(mocks.chatMounts).toBe(1);
    expect(container.querySelector('[data-testid="code-show-chat"]')).not.toBeNull();
    // The panel is sized to zero rather than removed.
    expect(mocks.setLayouts.at(-1)).toEqual({ chat: 0, terminal: 100 });

    click("code-show-chat");
    expect(appStore.getState().shellLayout.code.mode).toBe("both");
    expect(windowEl("chat").style.display).toBe("");
    expect(windowEl("chat")).toBe(chat);
    expect(mocks.chatMounts).toBe(1);
    expect(mocks.terminalMounts).toBe(1);
  });

  it("hides the terminal window without unmounting it", () => {
    render();
    const terminal = windowEl("terminal");

    click("code-hide-terminal");

    expect(appStore.getState().shellLayout.code.mode).toBe("chat");
    expect(windowEl("terminal").style.display).toBe("none");
    expect(windowEl("terminal")).toBe(terminal);
    expect(windowEl("terminal").querySelector("[data-terminal]")).not.toBeNull();
    expect(mocks.terminalMounts).toBe(1);
    expect(
      container.querySelector('[data-testid="code-show-terminal"]'),
    ).not.toBeNull();
  });

  it("expands one window over the tab and restores the split", () => {
    render();
    const terminal = windowEl("terminal");
    const terminalBody = terminal.querySelector("[data-terminal]")!;

    click("code-expand-chat");

    expect(appStore.getState().shellLayout.code.expanded).toBe("chat");
    expect(windowEl("terminal").style.display).toBe("none");
    // The hard requirement: the terminal element itself survives.
    expect(windowEl("terminal")).toBe(terminal);
    expect(terminal.querySelector("[data-terminal]")).toBe(terminalBody);
    expect(mocks.terminalMounts).toBe(1);

    click("code-restore-chat");

    expect(appStore.getState().shellLayout.code.expanded).toBeNull();
    expect(windowEl("terminal").style.display).toBe("");
    expect(terminal.querySelector("[data-terminal]")).toBe(terminalBody);
    expect(mocks.terminalMounts).toBe(1);
    // Restored to the saved split, not to a full-width window.
    expect(mocks.setLayouts.at(-1)).toEqual({ chat: 50, terminal: 50 });
  });

  it("opens straight into a persisted single-window mode", () => {
    const saved = defaultShellLayout();
    appStore.setState({
      shellLayout: { ...saved, code: { ...saved.code, mode: "chat" } },
    });

    render();

    const group = container.querySelector("[data-group]")!;
    expect(JSON.parse(group.getAttribute("data-default-layout")!)).toEqual({
      chat: 100,
      terminal: 0,
    });
    expect(windowEl("terminal").style.display).toBe("none");
    // Mounted anyway — the terminal window is never conditional.
    expect(mocks.terminalMounts).toBe(1);
  });

  // react-resizable-panels re-registers the un-hidden panel's constraints in a
  // layout effect that runs AFTER the parent effect, so the immediate call is
  // still clamped by the stale maxSize:0. jsdom can't reproduce the clamp
  // (every element measures 0), so the MECHANISM is what's asserted here.
  it("reasserts the saved split on the next frame after un-hiding", async () => {
    render();
    click("code-hide-terminal");
    mocks.setLayouts = [];

    click("code-show-terminal");
    expect(mocks.setLayouts).toEqual([{ chat: 50, terminal: 50 }]);

    await nextFrame();
    expect(mocks.setLayouts).toEqual([
      { chat: 50, terminal: 50 },
      { chat: 50, terminal: 50 },
    ]);
  });

  it("reasserts the saved split on the next frame after un-expanding", async () => {
    render();
    click("code-expand-terminal");
    mocks.setLayouts = [];

    click("code-restore-terminal");
    expect(mocks.setLayouts).toEqual([{ chat: 50, terminal: 50 }]);

    await nextFrame();
    expect(mocks.setLayouts.length).toBe(2);
    expect(mocks.setLayouts.at(-1)).toEqual({ chat: 50, terminal: 50 });
  });

  it("keeps both windows in the same DOM position across every transition", async () => {
    render();
    const start = windowPositions();
    expect(start).toEqual([
      ["chat", 0],
      ["terminal", 2],
    ]);
    const chat = windowEl("chat");
    const terminal = windowEl("terminal");

    for (const [hide, show] of [
      ["code-hide-terminal", "code-show-terminal"],
      ["code-hide-chat", "code-show-chat"],
      ["code-expand-chat", "code-restore-chat"],
      ["code-expand-terminal", "code-restore-terminal"],
    ]) {
      click(hide);
      expect(windowPositions()).toEqual(start);
      click(show);
      await nextFrame();
      expect(windowPositions()).toEqual(start);
    }

    expect(windowEl("chat")).toBe(chat);
    expect(windowEl("terminal")).toBe(terminal);
    expect(mocks.chatMounts).toBe(1);
    expect(mocks.terminalMounts).toBe(1);
  });

  it("brings the terminal window back when the chat needs a shell", () => {
    const saved = defaultShellLayout();
    appStore.setState({
      shellLayout: { ...saved, code: { ...saved.code, mode: "chat" } },
    });
    render();
    expect(windowEl("terminal").style.display).toBe("none");

    click("chat-login-terminal");

    expect(appStore.getState().shellLayout.code.mode).toBe("both");
    expect(windowEl("terminal").style.display).toBe("");
  });

  it("persists a dragged split and ignores programmatic layouts", () => {
    render();

    act(() =>
      mocks.onLayoutChanged?.(
        { chat: 63.333, terminal: 36.667 },
        { isUserInteraction: true },
      ),
    );
    expect(appStore.getState().shellLayout.code.chatPct).toBe(63.33);

    act(() =>
      mocks.onLayoutChanged?.(
        { chat: 20, terminal: 80 },
        { isUserInteraction: false },
      ),
    );
    expect(appStore.getState().shellLayout.code.chatPct).toBe(63.33);

    // A drag past the model's bounds is clamped to what a reload would give
    // back, never written raw.
    act(() =>
      mocks.onLayoutChanged?.(
        { chat: 4, terminal: 96 },
        { isUserInteraction: true },
      ),
    );
    expect(appStore.getState().shellLayout.code.chatPct).toBe(10);

    // A hidden window's zero width is not a split the user chose.
    click("code-hide-terminal");
    act(() =>
      mocks.onLayoutChanged?.(
        { chat: 100, terminal: 0 },
        { isUserInteraction: true },
      ),
    );
    expect(appStore.getState().shellLayout.code.chatPct).toBe(10);
  });

  it("re-asserts terminal focus when the tab becomes active again", () => {
    render(true);
    // Booting the tab must not pull the caret out of KödChat.
    const initial = mocks.terminalProps.at(-1)?.focusNonce as number;
    expect(initial).toBe(0);

    act(() => root.render(<CodeTab active={false} />));
    expect(mocks.terminalProps.at(-1)?.focusNonce).toBe(0);

    act(() => root.render(<CodeTab active={true} />));
    expect(mocks.terminalProps.at(-1)?.focusNonce).toBe(1);
    // Still the same terminal, focused rather than rebuilt.
    expect(mocks.terminalMounts).toBe(1);
  });

  it("never focuses a terminal window the user can't see", () => {
    render(true);
    click("code-hide-terminal");
    expect(mocks.terminalProps.at(-1)?.focusNonce).toBe(0);

    act(() => root.render(<CodeTab active={false} />));
    act(() => root.render(<CodeTab active={true} />));
    expect(mocks.terminalProps.at(-1)?.focusNonce).toBe(0);

    // Showing it again is the moment focus belongs there.
    click("code-show-terminal");
    expect(mocks.terminalProps.at(-1)?.focusNonce).toBe(1);
  });
});
