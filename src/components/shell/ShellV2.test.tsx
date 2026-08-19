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
    Panel: ({ children, id }: React.PropsWithChildren<{ id: string }>) => (
      <div data-panel={id}>{children}</div>
    ),
    Separator: () => <div data-separator />,
    usePanelRef: () => ({ current: null }),
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
    appStore.setState({ shellLayout: defaultShellLayout() });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("hosts the sidebar outside the tabs and the workspace inside the Code tab", () => {
    act(() => root.render(<ShellV2 />));

    expect(container.querySelector("[data-sidebar]")).not.toBeNull();
    const code = container.querySelector('[data-tab-id="code"]')!;
    expect(code.getAttribute("data-tab-active")).toBe("true");
    for (const id of ["terminal", "editor", "files"]) {
      expect(code.querySelector(`[data-panel="${id}"]`)).not.toBeNull();
    }
    // The sidebar is not one of the Code tab's resizable panels in v2.
    expect(code.querySelector('[data-panel="sidebar"]')).toBeNull();
    // Panels are paired with the title bar's pills for screen readers.
    expect(code.getAttribute("id")).toBe("shell-panel-code");
    expect(code.getAttribute("aria-labelledby")).toBe("shell-tab-code");
  });

  it("sizes a lazily mounted Code tab from the saved layout", () => {
    appStore.setState({
      shellLayout: { ...defaultShellLayout(), activeTab: "editor" },
    });
    act(() => root.render(<ShellV2 />));
    // The Code tab has never been shown, so it has not mounted yet.
    expect(container.querySelector('[data-tab-id="code"]')).toBeNull();

    act(() => {
      appStore.getState().setShellLayout({
        ...appStore.getState().shellLayout,
        activeTab: "code",
      });
    });

    // Saved v1 sizes [14, 40, 16, 30] minus the sidebar, renormalized.
    const expected = { terminal: 46.51, editor: 34.88, files: 18.6 };
    const group = container.querySelector('[data-tab-id="code"] [data-group]')!;
    expect(JSON.parse(group.getAttribute("data-default-layout")!)).toEqual(
      expected,
    );
    // And reasserted imperatively, since the first mount happened late.
    expect(mocks.setLayouts.at(-1)).toEqual(expected);
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
