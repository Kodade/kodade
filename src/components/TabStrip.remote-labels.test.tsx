import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesStore } from "../store/appStore";
import { TabStrip } from "./TabStrip";

describe("TabStrip remote target labels", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    filesStore.setState({
      openTabs: [],
      activeTab: null,
      dirtyPaths: {},
      editorStatus: "clean",
      tabModes: {},
    });
  });

  it("shows disambiguated path labels with the host in remote file-browser tabs", () => {
    const first = {
      kind: "remote-files" as const,
      host: "studio",
      path: "/work/projects/kodade",
    };
    filesStore.setState({
      openTabs: [
        first,
        {
          kind: "remote-files",
          host: "studio",
          path: "/work/clients/kodade",
        },
        { kind: "remote-files", host: "buildbox", path: "~" },
      ],
      activeTab: first,
    });

    act(() => root.render(<TabStrip />));

    expect(container.textContent).toContain("projects/kodade (studio)");
    expect(container.textContent).toContain("clients/kodade (studio)");
    expect(container.textContent).toContain("~ (buildbox)");
    expect(container.textContent).not.toContain("studio files");
  });
});
