import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../store/appStore";
import { defaultShellLayout } from "./shell/shell-layout";
import { TitleBar } from "./TitleBar";

describe("TitleBar", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    appStore.setState({
      shellV2Enabled: false,
      shellLayout: defaultShellLayout(),
    });
  });

  it("renders the Ködade wordmark in a draggable title bar", () => {
    act(() => root.render(<TitleBar />));

    const titleBar = container.querySelector("header");
    expect(titleBar?.getAttribute("data-tauri-drag-region")).not.toBeNull();
    expect(titleBar?.textContent).toContain("ködade");
  });

  it("keeps workspace utilities in the top-right and leaves configuration in settings", () => {
    act(() => root.render(<TitleBar />));

    for (const label of [
      "open browser",
      "open github",
      "open review",
    ]) {
      expect(
        container.querySelector(`header button[aria-label="${label}"]`),
      ).not.toBeNull();
    }
    expect(
      container.querySelector('header button[aria-label="open harness"]'),
    ).toBeNull();
    expect(
      container.querySelector('header button[aria-label="open ködmem"]'),
    ).toBeNull();
    expect(
      container.querySelector('header button[aria-label="Settings"]'),
    ).toBeNull();
  });

  // The v2 shell (#62) is a development feature; these tests run on the
  // development profile, where the toggle is compiled in.
  it("keeps the shell tabs out of the title bar until the v2 shell is switched on", () => {
    act(() => root.render(<TitleBar />));

    expect(container.querySelector('header [role="tablist"]')).toBeNull();
    expect(
      container.querySelector('header button[aria-label="Ködade v2 shell"]'),
    ).not.toBeNull();
  });

  it("switches shell tabs from a pill group that the drag region does not swallow", () => {
    act(() => appStore.setState({ shellV2Enabled: true }));
    act(() => root.render(<TitleBar />));

    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('header [role="tab"]'),
    ];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Agents",
      "Code",
      "Editor",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    // Only elements carrying the attribute start a window drag, so the pills
    // stay clickable.
    for (const tab of tabs) {
      expect(tab.hasAttribute("data-tauri-drag-region")).toBe(false);
    }

    act(() => tabs[0].click());
    expect(appStore.getState().shellLayout.activeTab).toBe("agents");
  });

  it("pairs each pill with its panel and roves focus with the arrow keys", () => {
    act(() => appStore.setState({ shellV2Enabled: true }));
    act(() => root.render(<TitleBar />));

    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('header [role="tab"]'),
    ];
    expect(tabs.map((tab) => tab.id)).toEqual([
      "shell-tab-agents",
      "shell-tab-code",
      "shell-tab-editor",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-controls"))).toEqual([
      "shell-panel-agents",
      "shell-panel-code",
      "shell-panel-editor",
    ]);
    // Only the selected pill is in the tab order (roving focus).
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);

    const tablist = container.querySelector<HTMLElement>(
      'header [role="tablist"]',
    )!;
    act(() =>
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(appStore.getState().shellLayout.activeTab).toBe("editor");

    // Wraps around, and focus follows selection.
    act(() =>
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(appStore.getState().shellLayout.activeTab).toBe("agents");
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("always offers the development toggle back to the v1 shell", () => {
    act(() => appStore.setState({ shellV2Enabled: true }));
    act(() => root.render(<TitleBar />));

    const toggle = container.querySelector<HTMLButtonElement>(
      'header button[aria-label="Ködade v2 shell"]',
    )!;
    act(() => toggle.click());
    expect(appStore.getState().shellV2Enabled).toBe(false);
  });
});
