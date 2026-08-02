// Platform capability test: the top-right "open browser" affordance disappears
// when the native browser pane is unavailable.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilitiesStore } from "../platform/capabilities";
import type { PlatformCapabilities } from "../ipc/contract";

const filesState = createStore(() => ({
  openTabs: [],
  activeTab: null,
  dirtyPaths: {},
  editorStatus: "clean",
  tabModes: {},
  toggleActiveTabMode: () => undefined,
  openBrowserTab: () => undefined,
  openGithubTab: () => undefined,
  activateTab: () => undefined,
  closeTab: () => undefined,
}));
const memoryState = createStore(() => ({ loading: false, error: null, clearError: () => undefined }));

vi.mock("../store/appStore", () => ({
  filesStore: filesState,
  memoryStore: memoryState,
  appStore: createStore(() => ({})),
}));

const { TitleBar } = await import("./TitleBar");

describe("title-bar capability gating", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    capabilitiesStore.getState().setCapabilities(null as unknown as PlatformCapabilities);
  });

  it("shows the browser button by default (desktop: capabilities never fetched)", () => {
    act(() => root.render(createElement(TitleBar)));
    expect(container.querySelector('[aria-label="open browser"]')).not.toBeNull();
  });

  it("hides the browser button when platform capabilities report it off", () => {
    capabilitiesStore.getState().setCapabilities({
      browser: false,
      pickFolder: true,
      voice: true,
      revealInOs: true,
    });
    act(() => root.render(createElement(TitleBar)));
    expect(container.querySelector('[aria-label="open browser"]')).toBeNull();
    // Everything else stays — capability gating is per-surface, not blanket.
    expect(container.querySelector('[aria-label="open github"]')).not.toBeNull();
  });
});
