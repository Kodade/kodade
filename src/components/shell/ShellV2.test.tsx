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
  // Every onLayoutChanged handler a Group registered, in mount order.
  layoutHandlers: [] as ((
    layout: Record<string, number>,
    meta: { isUserInteraction: boolean },
  ) => void)[],
  files: null as unknown,
}));

// The REAL files store (over the MockFiles IPC) stands in for the app's, so
// the shell's auto-switch is validated against the actions the app calls.
vi.mock("../../store/appStore", async () => {
  const { createStore } = await import("zustand/vanilla");
  const { createFilesStore } = await import("../../store/files");
  const { MockFiles, MockStorage } = await import("../../ipc/mock");
  const { defaultShellLayout } = await import("./shell-layout");
  const { createPersonaStore } = await import("../../agents/persona-store");
  const { createAgentsStore } = await import("../../agents/agents-store");
  const { createConnectionStore } = await import("../../agents/connection-store");
  const { createConnectionsStore } = await import("../../agents/connections-store");
  const connectionStore = createConnectionStore({ storage: new MockStorage() });
  const files = new MockFiles();
  files.tree.set("/repo", [
    { name: "a.ts", path: "/repo/a.ts", isDir: false },
  ]);
  mocks.files = files;
  return {
    appStore: createStore((set) => ({
      shellLayout: defaultShellLayout(),
      layout: [14, 40, 16, 30],
      sidebarMode: "full",
      filesCollapsed: false,
      // The Agents tab reads these; an empty workspace list is enough here.
      projects: [],
      activeProjectId: null,
      setShellLayout: (shellLayout: unknown) => set({ shellLayout }),
    })),
    filesStore: createFilesStore({ files }),
    // The Agents tab's real dependencies, wired against in-memory mocks.
    agentsStore: createAgentsStore({
      store: createPersonaStore({ storage: new MockStorage() }),
    }),
    kodworkStore: createStore(() => ({ tasks: {} })),
    harnessStore: createStore(() => ({
      kodSkills: null,
      kodSkillsError: null,
      loadKodSkills: async () => {},
    })),
    connectionStore,
    connectionsStore: createConnectionsStore({ store: connectionStore }),
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
      onLayoutChanged,
    }: React.PropsWithChildren<{
      className?: string;
      groupRef?: { current: unknown };
      defaultLayout?: Record<string, number>;
      onLayoutChanged?: (
        layout: Record<string, number>,
        meta: { isUserInteraction: boolean },
      ) => void;
    }>) => {
      if (onLayoutChanged && !mocks.layoutHandlers.includes(onLayoutChanged)) {
        mocks.layoutHandlers.push(onLayoutChanged);
      }
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

import { appStore, filesStore } from "../../store/appStore";
import { defaultShellLayout } from "./shell-layout";
import { ShellV2 } from "./ShellV2";

const files = () => filesStore.getState();

// A user-initiated return to the Code tab.
const backToCode = () =>
  appStore.getState().setShellLayout({
    ...appStore.getState().shellLayout,
    activeTab: "code",
  });

describe("ShellV2", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mocks.chatMounts = 0;
    mocks.setLayouts = [];
    mocks.resizes = [];
    mocks.panelRef = { current: null };
    mocks.layoutHandlers = [];
    // The files store is module-level: drop the test root's tab closure so
    // each case starts from an empty workspace.
    filesStore.getState().dropTabsForRoot("/repo");
    filesStore.setState({ openTabs: [], activeTab: null, selectedPath: null });
    appStore.setState({
      shellLayout: defaultShellLayout(),
      filesCollapsed: false,
      sidebarMode: "full",
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Geometry written by the editor group alone (the sidebar group shares the
  // same mock recorder).
  const editorSetLayouts = () =>
    mocks.setLayouts.filter((layout) => "editor" in layout);

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
    // Two groups write geometry now (the sidebar's and the editor's), and the
    // mocks share one recorder: this case is about the editor split alone.
    expect(editorSetLayouts()).toEqual([{ editor: 65.22, files: 34.78 }]);
    await nextFrame();
    expect(editorSetLayouts()).toHaveLength(1);
    expect(mocks.resizes).not.toContain("34.78%");

    mocks.setLayouts = [];
    mocks.resizes = [];
    act(() => appStore.setState({ filesCollapsed: false }));
    expect(editorSetLayouts()).toEqual([{ editor: 65.22, files: 34.78 }]);

    await nextFrame();
    expect(editorSetLayouts()).toEqual([
      { editor: 65.22, files: 34.78 },
      { editor: 65.22, files: 34.78 },
    ]);
    expect(mocks.resizes).toContain("34.78%");
  });

  // The sidebar is a resizable panel in the v2 shell, not a fixed width: its
  // drag persists through the same clamped path as the editor split, so a
  // fresh install isn't pinned at the default 14% forever (#65).
  it("writes the sidebar width back on a user drag, clamped", () => {
    act(() => root.render(<ShellV2 />));
    // The shell group mounts with the saved sidebar width.
    const group = container.querySelector("[data-group]")!;
    expect(JSON.parse(group.getAttribute("data-default-layout")!)).toEqual({
      sidebar: 14,
      tabs: 86,
    });

    const drag = (sidebar: number) =>
      act(() =>
        mocks.layoutHandlers[0]!({ sidebar, tabs: 100 - sidebar }, {
          isUserInteraction: true,
        }),
      );

    drag(21.436);
    expect(appStore.getState().shellLayout.sidebarPct).toBe(21.44);

    // Beyond the persisted contract's bounds: clamped, never rejected.
    drag(64);
    expect(appStore.getState().shellLayout.sidebarPct).toBe(40);
    drag(1);
    expect(appStore.getState().shellLayout.sidebarPct).toBe(8);
  });

  it("never writes a sidebar width measured while it is a rail", () => {
    appStore.setState({ sidebarMode: "rail" });
    act(() => root.render(<ShellV2 />));

    act(() =>
      mocks.layoutHandlers[0]!({ sidebar: 4, tabs: 96 }, {
        isUserInteraction: true,
      }),
    );
    expect(appStore.getState().shellLayout.sidebarPct).toBe(14);

    // Programmatic setLayout reports isUserInteraction=false.
    act(() => appStore.setState({ sidebarMode: "full" }));
    act(() =>
      mocks.layoutHandlers[0]!({ sidebar: 30, tabs: 70 }, {
        isUserInteraction: false,
      }),
    );
    expect(appStore.getState().shellLayout.sidebarPct).toBe(14);
  });

  it("writes the editor split back on a user drag, clamped", () => {
    appStore.setState({
      shellLayout: { ...defaultShellLayout(), activeTab: "editor" },
    });
    act(() => root.render(<ShellV2 />));
    const drag = (files: number) =>
      act(() =>
        mocks.layoutHandlers.at(-1)!({ editor: 100 - files, files }, {
          isUserInteraction: true,
        }),
      );

    drag(52.126);
    expect(appStore.getState().shellLayout.editor.filesPct).toBe(52.13);

    // Beyond the persisted contract's bounds: clamped, never rejected.
    drag(97);
    expect(appStore.getState().shellLayout.editor.filesPct).toBe(90);
    drag(2);
    expect(appStore.getState().shellLayout.editor.filesPct).toBe(10);
  });

  it("never writes geometry from a reassert or a collapsed files rail", () => {
    appStore.setState({
      shellLayout: { ...defaultShellLayout(), activeTab: "editor" },
      filesCollapsed: true,
    });
    act(() => root.render(<ShellV2 />));

    // The rail's fixed 44px is not a width the user chose.
    act(() =>
      mocks.layoutHandlers.at(-1)!({ editor: 95, files: 5 }, {
        isUserInteraction: true,
      }),
    );
    expect(appStore.getState().shellLayout.editor.filesPct).toBe(34.78);

    // Programmatic setLayout reports isUserInteraction=false.
    act(() => appStore.setState({ filesCollapsed: false }));
    act(() =>
      mocks.layoutHandlers.at(-1)!({ editor: 20, files: 80 }, {
        isUserInteraction: false,
      }),
    );
    expect(appStore.getState().shellLayout.editor.filesPct).toBe(34.78);
  });

  it("switches to the Editor tab when a surface opens a files-store tab", async () => {
    await act(async () => void (await files().setRoot("/repo")));
    act(() => root.render(<ShellV2 />));
    expect(appStore.getState().shellLayout.activeTab).toBe("code");

    // The title bar's github action.
    act(() => files().openGithubTab());
    expect(appStore.getState().shellLayout.activeTab).toBe("editor");

    // Back to Code by hand, then KödChat's review handoff.
    act(() => backToCode());
    act(() => files().openReviewTab());
    expect(appStore.getState().shellLayout.activeTab).toBe("editor");

    // A file opened from the tree counts too.
    act(() => backToCode());
    await act(async () => void (await files().selectFile("/repo/a.ts")));
    expect(appStore.getState().shellLayout.activeTab).toBe("editor");
  });

  it("does not fight a user who goes back to Code", async () => {
    await act(async () => void (await files().setRoot("/repo")));
    act(() => root.render(<ShellV2 />));
    act(() => files().openBrowserTab());
    act(() => backToCode());

    // In-page navigation, a close picking a neighbor, and the cycle shortcut
    // are not requests to look at the editor.
    act(() => files().setBrowserUrl("https://kodade.com"));
    act(() => files().openGithubTab());
    act(() => backToCode());
    act(() => files().closeTab({ kind: "github" }));
    act(() => files().cycleTab(1));
    expect(appStore.getState().shellLayout.activeTab).toBe("code");
  });

  it("leaves chat and terminal activity on the Code tab", async () => {
    await act(async () => void (await files().setRoot("/repo")));
    act(() => root.render(<ShellV2 />));

    // Nothing about a chat message or a PTY touches the files store's tabs.
    act(() => files().setFilter("a"));
    act(() => appStore.setState({ sidebarMode: "full" }));
    expect(appStore.getState().shellLayout.activeTab).toBe("code");
  });

  // The subscription lives and dies with this component, and this component
  // only ever mounts under the v2 shell — v1 and public builds never install it.
  it("stops switching once the v2 shell is gone", async () => {
    await act(async () => void (await files().setRoot("/repo")));
    act(() => root.render(<ShellV2 />));
    act(() => root.unmount());

    act(() => files().openGithubTab());
    expect(appStore.getState().shellLayout.activeTab).toBe("code");

    // afterEach unmounts again; make that a no-op safely.
    root = createRoot(document.createElement("div"));
  });

  it("mirrors the open github/review tabs into editor.panels", async () => {
    await act(async () => void (await files().setRoot("/repo")));
    act(() => root.render(<ShellV2 />));
    expect(appStore.getState().shellLayout.editor.panels).toEqual({
      github: false,
      review: false,
    });

    act(() => files().openGithubTab());
    act(() => files().openReviewTab());
    expect(appStore.getState().shellLayout.editor.panels).toEqual({
      github: true,
      review: true,
    });

    // Closing from the tab strip clears the flag; nothing reopens it.
    act(() => files().closeTab({ kind: "github" }));
    expect(appStore.getState().shellLayout.editor.panels).toEqual({
      github: false,
      review: true,
    });
    expect(files().openTabs).toEqual([{ kind: "review" }]);
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
