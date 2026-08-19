// Archived embedded browser (#62): the title bar's "open browser" action is
// compiled out with the feature, independently of platform capabilities.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../release/manifest", () => {
  const features = {
    local: false,
    voice: false,
    ssh: false,
    work: true,
    shell: false,
    browser: false,
  };
  return {
    RELEASE_MANIFEST: { profile: "public", features },
    developmentFeatureEnabled: (feature: keyof typeof features) =>
      features[feature],
  };
});

vi.mock("../store/appStore", () => ({
  filesStore: createStore(() => ({
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
  })),
  memoryStore: createStore(() => ({
    loading: false,
    error: null,
    clearError: () => undefined,
  })),
  appStore: createStore(() => ({
    shellV2Enabled: false,
    shellLayout: { activeTab: "code" },
  })),
}));

const { TitleBar } = await import("./TitleBar");

describe("title-bar browser gating", () => {
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
  });

  it("hides the browser button in a build without the feature", () => {
    act(() => root.render(createElement(TitleBar)));
    expect(container.querySelector('[aria-label="open browser"]')).toBeNull();
    // The rest of the title bar is untouched.
    expect(container.querySelector('[aria-label="open github"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="open review"]')).not.toBeNull();
  });
});
