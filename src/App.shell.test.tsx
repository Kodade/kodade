// App-level gate for the v2 tabbed shell (#62). Separate file from App.test
// because the release manifest is mocked per file: here the shell feature IS
// compiled in, so only the runtime toggle decides which shell renders.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./store/appStore", async () => {
  const { createStore } = await import("zustand/vanilla");
  return {
    appStore: createStore(() => ({
      layout: [14, 40, 16, 30],
      sidebarMode: "full",
      filesCollapsed: false,
      shellV2Enabled: false,
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
    Group: ({ children }: React.PropsWithChildren) => <div data-group>{children}</div>,
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
  appStore.setState({ shellV2Enabled: false });
});

describe("v2 shell toggle", () => {
  it("renders the shipping shell while the toggle is off", () => {
    const dom = render();

    expect(dom.querySelector("[data-shell-v2]")).toBeNull();
    expect(dom.querySelector('[data-panel="sidebar"]')).not.toBeNull();
  });

  it("renders the v2 shell once the toggle is on", () => {
    appStore.setState({ shellV2Enabled: true });
    const dom = render();

    expect(dom.querySelector("[data-shell-v2]")).not.toBeNull();
    expect(dom.querySelector('[data-panel="sidebar"]')).toBeNull();
  });
});
