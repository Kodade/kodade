import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { FileTreePane } from "./FileTreePane";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("FileTreePane toolbar", () => {
  it("keeps file actions without the loaded-files filter", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<FileTreePane />));

    expect(container.querySelector('input[placeholder="filter loaded files"]')).toBeNull();
    expect(container.querySelector('button[title="new file"]')).not.toBeNull();
    expect(container.querySelector('button[title="new folder"]')).not.toBeNull();
  });
});
