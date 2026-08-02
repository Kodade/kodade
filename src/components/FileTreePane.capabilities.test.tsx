// Platform capability test: "reveal in file manager" disappears when the OS
// integration is unavailable.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilitiesStore } from "../platform/capabilities";
import type { PlatformCapabilities } from "../ipc/contract";
import { REVEAL_IN_FILE_MANAGER_LABEL } from "../platform/guidance";
import { ContextMenu } from "./FileTreePane";

describe("FileTreePane context menu capability gating", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const menu = {
    x: 0,
    y: 0,
    entry: { name: "src", path: "/proj/src", isDir: true },
  };

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

  it("shows reveal by default (desktop: capabilities never fetched)", () => {
    act(() => root.render(createElement(ContextMenu, { menu, onClose: vi.fn() })));
    const items = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toContain(REVEAL_IN_FILE_MANAGER_LABEL);
  });

  it("hides reveal when the platform has no OS file manager", () => {
    capabilitiesStore.getState().setCapabilities({
      browser: false,
      pickFolder: true,
      voice: true,
      revealInOs: false,
    });
    act(() => root.render(createElement(ContextMenu, { menu, onClose: vi.fn() })));
    const items = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).not.toContain(REVEAL_IN_FILE_MANAGER_LABEL);
    // Other entries stay — delete/rename/copy-path don't depend on the OS.
    expect(items.some((text) => text?.includes("copy path"))).toBe(true);
  });
});
