import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
