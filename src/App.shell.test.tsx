// App-level gate for the tabbed shell (#62/#65). Separate file from App.test
// because the release manifest is mocked per file: here the shell feature IS
// compiled in, so only the user's layout choice decides which shell renders.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Every imperative setLayout the v1 Group receives, and the defaultLayout it
  // mounted with.
  setLayouts: [] as Record<string, number>[],
  mountLayouts: [] as (Record<string, number> | undefined)[],
}));

vi.mock("./store/appStore", async () => {
  const { createStore } = await import("zustand/vanilla");
  return {
    appStore: createStore(() => ({
      layout: [22, 30, 18, 30],
      sidebarMode: "full",
      filesCollapsed: false,
      // The v2.0 default; the escape hatch is what flips it.
      shellV2Enabled: true,
      setLayout: vi.fn(),
    })),
    initApp: vi.fn(() => Promise.resolve()),
    sshStore: {},
  };
});

vi.mock("./release/manifest", () => ({
  RELEASE_MANIFEST: {
    profile: "development",
    features: { local: true, voice: true, ssh: false, work: true, shell: true },
  },
}));

vi.mock("./components/EditorPane", () => ({ EditorPane: () => <div>editor</div> }));
vi.mock("./components/ProjectsSidebar", () => ({
  ProjectsSidebar: () => <div>projects</div>,
}));
vi.mock("./components/chat/ChatPane", () => ({ ChatPane: () => <div>chat</div> }));
vi.mock("./components/TitleBar", () => ({ TitleBar: () => <div>title</div> }));
vi.mock("./components/WorkspaceFilesPane", () => ({
  WorkspaceFilesPane: () => <div>files</div>,
}));
vi.mock("./components/settings/SettingsPage", () => ({
  SettingsPage: () => <div>settings</div>,
}));
vi.mock("./ssh/refresh", () => ({ listenForSshFocusRefresh: vi.fn() }));
vi.mock("./components/shell/ShellV2", () => ({
  ShellV2: () => <div data-shell-v2 />,
}));

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");
  return {
    Group: ({
      children,
      groupRef,
      defaultLayout,
    }: React.PropsWithChildren<{
      groupRef?: { current: unknown };
      defaultLayout?: Record<string, number>;
    }>) => {
      // Child effects run before the parent's, so App's restore effect sees a
      // populated ref — exactly the real mounting order.
      React.useEffect(() => {
        mocks.mountLayouts.push(defaultLayout);
        if (groupRef) {
          groupRef.current = {
            setLayout: (layout: Record<string, number>) =>
              void mocks.setLayouts.push(layout),
          };
        }
        return () => {
          if (groupRef) groupRef.current = null;
        };
        // Mount-only: defaultLayout is read once by the real library too.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-group>{children}</div>;
    },
    Panel: ({ children, id }: React.PropsWithChildren<{ id: string }>) => (
      <div data-panel={id}>{children}</div>
    ),
    Separator: () => <div data-separator />,
    usePanelRef: () => ({ current: null }),
  };
});

import { appStore } from "./store/appStore";
import App from "./App";

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<App />));
  return container;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  mocks.setLayouts = [];
  mocks.mountLayouts = [];
  appStore.setState({ shellV2Enabled: true });
});

// Let the next-frame reassert run.
const nextFrame = () =>
  act(
    async () =>
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      ),
  );

describe("shell layout choice", () => {
  it("renders the classic shell once the user takes the escape hatch", () => {
    appStore.setState({ shellV2Enabled: false });
    const dom = render();

    expect(dom.querySelector("[data-shell-v2]")).toBeNull();
    expect(dom.querySelector('[data-panel="sidebar"]')).not.toBeNull();
  });

  it("renders the tabbed shell by default", () => {
    const dom = render();

    expect(dom.querySelector("[data-shell-v2]")).not.toBeNull();
    expect(dom.querySelector('[data-panel="sidebar"]')).toBeNull();
  });

  // The classic Group is UNMOUNTED while the tabbed shell renders, so coming
  // back through the escape hatch must not land the user on factory widths —
  // their first drag would then overwrite the saved layout for good.
  it("gives the classic shell the saved pane widths when the escape hatch is used", async () => {
    render(); // boots on the tabbed shell
    await nextFrame();
    expect(mocks.mountLayouts).toEqual([]);

    act(() => appStore.setState({ shellV2Enabled: false }));

    // Correct at mount...
    const saved = { sidebar: 22, terminal: 30, editor: 30, files: 18 };
    expect(mocks.mountLayouts).toEqual([saved]);
    // ...and reasserted by the restore effect, which now re-runs on the flip.
    expect(mocks.setLayouts).toEqual([saved]);
    await nextFrame();
    expect(mocks.setLayouts).toEqual([saved, saved]);
  });
});
