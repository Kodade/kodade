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
      setLayout: vi.fn(),
    })),
    initApp: vi.fn(() => Promise.resolve()),
    sshStore: {},
  };
});

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

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");
  return {
    Group: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
      <div data-group className={className}>
        {children}
      </div>
    ),
    Panel: ({
      children,
      id,
      collapsible,
      minSize,
    }: React.PropsWithChildren<{
      id: string;
      collapsible?: boolean;
      minSize?: string | number;
    }>) => (
      <div
        data-panel={id}
        data-collapsible={String(collapsible)}
        data-min-size={String(minSize)}
      >
        {children}
      </div>
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

describe("workspace pane shell", () => {
  it("clips the layout to the window and keeps resizable panes recoverable", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<App />));

    const main = container.querySelector("main")!;
    const group = container.querySelector<HTMLElement>("[data-group]")!;
    expect(main.className).toContain("min-w-0");
    expect(main.className).toContain("max-w-full");
    expect(main.className).toContain("overflow-hidden");
    expect(group.className).toContain("min-w-0");
    expect(group.className).toContain("max-w-full");
    expect(group.className).toContain("overflow-hidden");

    for (const id of ["sidebar", "editor", "files"]) {
      expect(
        container
          .querySelector(`[data-panel="${id}"]`)
          ?.getAttribute("data-collapsible"),
      ).toBe("false");
    }
    expect(
      container
        .querySelector('[data-panel="sidebar"]')
        ?.getAttribute("data-min-size"),
    ).toBe("10%");
    expect(
      container
        .querySelector('[data-panel="files"]')
        ?.getAttribute("data-min-size"),
    ).toBe("10%");
  });
});
