// v2 shell frame (issue #62). The panes are mocked: what matters here is that
// the Code tab keeps its content mounted across tab switches, since the real
// panes host terminals that live outside React.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// State shared with the mocks (hoisted alongside them): a ChatPane mount
// counter, and every layout the Code tab's Group was imperatively given.
const mocks = vi.hoisted(() => ({
  chatMounts: 0,
  setLayouts: [] as Record<string, number>[],
  resizes: [] as string[],
  panelRef: { current: null } as { current: unknown },
}));

vi.mock("../../store/appStore", async () => {
  const { createStore } = await import("zustand/vanilla");
  const { defaultShellLayout } = await import("./shell-layout");
  return {
    appStore: createStore((set) => ({
      shellLayout: defaultShellLayout(),
      layout: [14, 40, 16, 30],
      sidebarMode: "full",
      filesCollapsed: false,
      setShellLayout: (shellLayout: unknown) => set({ shellLayout }),
    })),
  };
});

vi.mock("../chat/ChatPane", async () => {
  const React = await import("react");
  return {
    ChatPane: () => {
      React.useEffect(() => {
        mocks.chatMounts += 1;
      }, []);
      return <div data-chat />;
    },
  };
});
vi.mock("../TerminalPane", () => ({
  TerminalPane: () => <div data-terminal />,
}));
vi.mock("../EditorPane", () => ({ EditorPane: () => <div data-editor /> }));
vi.mock("./WorkspacesSidebar", () => ({
  WorkspacesSidebar: () => <div data-sidebar />,
}));
vi.mock("../WorkspaceFilesPane", () => ({
  WorkspaceFilesPane: () => <div data-files />,
}));

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");
  return {
    Group: ({
      children,
      className,
      groupRef,
      defaultLayout,
    }: React.PropsWithChildren<{
      className?: string;
      groupRef?: { current: unknown };
      defaultLayout?: Record<string, number>;
    }>) => {
      if (groupRef) {
        groupRef.current = {
          setLayout: (layout: Record<string, number>) =>
            void mocks.setLayouts.push(layout),
        };
      }
      return (
        <div
          data-group
          data-default-layout={JSON.stringify(defaultLayout)}
          className={className}
        >
          {children}
        </div>
      );
    },
    Panel: ({
      children,
      id,
      panelRef,
    }: React.PropsWithChildren<{
      id: string;
      panelRef?: { current: unknown };
    }>) => {
      if (panelRef) {
        panelRef.current = {
          resize: (size: string) => void mocks.resizes.push(size),
        };
      }
      return <div data-panel={id}>{children}</div>;
    },
    Separator: () => <div data-separator />,
    usePanelRef: () => mocks.panelRef,
  };
});

import { appStore } from "../../store/appStore";
import { defaultShellLayout } from "./shell-layout";
import { ShellV2 } from "./ShellV2";

describe("ShellV2", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mocks.chatMounts = 0;
    mocks.setLayouts = [];
    mocks.resizes = [];
    mocks.panelRef = { current: null };
    appStore.setState({
      shellLayout: defaultShellLayout(),
      filesCollapsed: false,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Let the next-frame reassert run (jsdom's rAF is real here).
  const nextFrame = () =>
    act(
      async () =>
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        ),
    );

  it("hosts the sidebar outside the tabs and the chat/terminal split inside Code", () => {
    act(() => root.render(<ShellV2 />));

    expect(container.querySelector("[data-sidebar]")).not.toBeNull();
    const code = container.querySelector('[data-tab-id="code"]')!;
    expect(code.getAttribute("data-tab-active")).toBe("true");
    for (const id of ["chat", "terminal"]) {
      expect(code.querySelector(`[data-panel="${id}"]`)).not.toBeNull();
    }
    // The sidebar is not one of the Code tab's resizable panels in v2, and the
    // editor moved to its own tab.
    expect(code.querySelector('[data-panel="sidebar"]')).toBeNull();
    expect(code.querySelector('[data-panel="editor"]')).toBeNull();
    // Panels are paired with the title bar's pills for screen readers.
    expect(code.getAttribute("id")).toBe("shell-panel-code");
    expect(code.getAttribute("aria-labelledby")).toBe("shell-tab-code");
  });

  it("gives the Editor tab the editor and the workspace files", () => {
    appStore.setState({
      shellLayout: { ...defaultShellLayout(), activeTab: "editor" },
    });
    act(() => root.render(<ShellV2 />));

    const editor = container.querySelector('[data-tab-id="editor"]')!;
    expect(editor.querySelector("[data-editor]")).not.toBeNull();
    expect(editor.querySelector("[data-files]")).not.toBeNull();
    // Read-only geometry in this slice: the saved files ratio, rendered.
    const group = editor.querySelector("[data-group]")!;
    expect(JSON.parse(group.getAttribute("data-default-layout")!)).toEqual({
      editor: 65.22,
      files: 34.78,
    });
  });

  // Same hazard the v1 shell documents: the rail's fixed 44px constraint is
  // reconciled after this parent effect, so the saved ratio has to be
  // reasserted on the next frame or the files pane stays stranded. jsdom can't
  // reproduce the clamp, so the mechanism itself is what's asserted.
  it("reasserts the editor split on the next frame when the files rail expands", async () => {
    appStore.setState({
      shellLayout: { ...defaultShellLayout(), activeTab: "editor" },
      filesCollapsed: true,
    });
    act(() => root.render(<ShellV2 />));
    // Collapsed: sized once, with no follow-up frame to fight the rail.
    expect(mocks.setLayouts).toEqual([{ editor: 65.22, files: 34.78 }]);
    await nextFrame();
    expect(mocks.setLayouts).toHaveLength(1);
    expect(mocks.resizes).toEqual([]);

    mocks.setLayouts = [];
    act(() => appStore.setState({ filesCollapsed: false }));
    expect(mocks.setLayouts).toEqual([{ editor: 65.22, files: 34.78 }]);

    await nextFrame();
    expect(mocks.setLayouts).toEqual([
      { editor: 65.22, files: 34.78 },
      { editor: 65.22, files: 34.78 },
    ]);
    expect(mocks.resizes).toEqual(["34.78%"]);
  });

  it("keeps the Code tab mounted while another tab is showing", () => {
    act(() => root.render(<ShellV2 />));
    expect(mocks.chatMounts).toBe(1);

    act(() => {
      appStore.getState().setShellLayout({
        ...appStore.getState().shellLayout,
        activeTab: "agents",
      });
    });
    const code = container.querySelector<HTMLElement>('[data-tab-id="code"]')!;
    expect(code.style.display).toBe("none");
    expect(container.querySelector('[data-tab-id="agents"]')).not.toBeNull();

    act(() => {
      appStore.getState().setShellLayout({
        ...appStore.getState().shellLayout,
        activeTab: "code",
      });
    });
    expect(mocks.chatMounts).toBe(1);
    expect(
      container.querySelector<HTMLElement>('[data-tab-id="code"]')!.style
        .display,
    ).toBe("");
  });
});
