// Composition smoke test for the v2 shell (#62): the REAL App, TitleBar and
// ShellV2 together, with only the leaf panes and the panel library mocked.
// Proves the pills and the shell body agree about which tab is showing.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./store/appStore", async () => {
  const { createStore } = await import("zustand/vanilla");
  const { defaultShellLayout } = await import(
    "./components/shell/shell-layout"
  );
  const { MockStorage } = await import("./ipc/mock");
  const { createPersonaStore } = await import("./agents/persona-store");
  const { createAgentsStore } = await import("./agents/agents-store");
  const appStore = createStore((set) => ({
    layout: [14, 40, 16, 30],
    sidebarMode: "full",
    filesCollapsed: false,
    shellLayout: defaultShellLayout(),
    shellV2Enabled: true,
    // The Agents tab reads these when its pill is selected.
    projects: [],
    activeProjectId: null,
    setLayout: vi.fn(),
    setShellLayout: (shellLayout: unknown) => set({ shellLayout }),
    setShellV2Enabled: (shellV2Enabled: boolean) => set({ shellV2Enabled }),
  }));
  const noop = () => undefined;
  return {
    appStore,
    initApp: vi.fn(() => Promise.resolve()),
    sshStore: {},
    filesStore: createStore(() => ({
      openTabs: [],
      activeTab: null,
      openBrowserTab: noop,
      openGithubTab: noop,
      openReviewTab: noop,
    })),
    memoryStore: createStore(() => ({
      loading: false,
      error: null,
      clearError: noop,
    })),
    // The Agents tab's real dependencies, over in-memory mocks.
    agentsStore: createAgentsStore({
      store: createPersonaStore({ storage: new MockStorage() }),
    }),
    kodworkStore: createStore(() => ({ tasks: {} })),
    harnessStore: createStore(() => ({
      kodSkills: null,
      kodSkillsError: null,
      loadKodSkills: async () => {},
    })),
  };
});

// The manifest is NOT mocked here: this suite compiles on the development
// profile, where the shell feature is genuinely on.

vi.mock("./components/EditorPane", () => ({ EditorPane: () => <div>editor</div> }));
vi.mock("./components/ProjectsSidebar", () => ({
  ProjectsSidebar: () => <div data-sidebar />,
}));
// The v2 shell mounts the Workspaces sidebar instead of the v1 one (#62).
vi.mock("./components/shell/WorkspacesSidebar", () => ({
  WorkspacesSidebar: () => <div data-sidebar />,
}));
vi.mock("./components/chat/ChatPane", () => ({
  ChatPane: () => <div data-chat />,
}));
// The v2 Code tab renders the terminal beside the chat (#62); the real pane
// wants the session registry, which this suite deliberately does not build.
vi.mock("./components/TerminalPane", () => ({
  TerminalPane: () => <div data-terminal />,
}));
vi.mock("./components/WorkspaceFilesPane", () => ({
  WorkspaceFilesPane: () => <div>files</div>,
}));
vi.mock("./components/settings/SettingsPage", () => ({
  SettingsPage: () => <div>settings</div>,
}));
vi.mock("./ssh/refresh", () => ({ listenForSshFocusRefresh: vi.fn() }));

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

import App from "./App";

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("App with the v2 shell switched on", () => {
  it("renders the pill switcher and the Code tab's workspace together", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<App />));

    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('header [role="tab"]'),
    ];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Agents",
      "Code",
      "Editor",
    ]);

    // The Code tab is showing, with the sidebar hoisted out of it.
    const code = container.querySelector('[data-tab-id="code"]')!;
    expect(code.getAttribute("data-tab-active")).toBe("true");
    expect(code.querySelector("[data-chat]")).not.toBeNull();
    expect(container.querySelector("[data-sidebar]")).not.toBeNull();

    // Selecting another pill moves the shell body with it.
    act(() => tabs[0].click());
    expect(
      container.querySelector<HTMLElement>('[data-tab-id="code"]')!.style
        .display,
    ).toBe("none");
    expect(
      container
        .querySelector('[data-tab-id="agents"]')
        ?.getAttribute("data-tab-active"),
    ).toBe("true");
  });
});
