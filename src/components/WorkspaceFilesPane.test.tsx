import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntitlements } from "../app/entitlements";
import { MockSsh, MockStorage } from "../ipc/mock";
import { remoteProjectId } from "../ssh/model";
import { createProjectsStore } from "../store/projects";
import { createRemoteFilesStore } from "../store/remoteFiles";
import { WorkspaceFilesPane } from "./WorkspaceFilesPane";

let container: HTMLDivElement | null;
let root: Root | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
}

describe("WorkspaceFilesPane", () => {
  it("shows the active remote project's files in the right files pane", async () => {
    const projectsStore = createProjectsStore({
      storage: new MockStorage(),
      registry: {
        open: () => undefined,
        close: async () => undefined,
        write: () => undefined,
      },
      newId: () => "id-1",
    });
    await projectsStore.getState().hydrate();
    const target = { host: "box", path: "/srv/app" };
    projectsStore.getState().pinRemoteTarget(target);
    await projectsStore.getState().setActiveProject(remoteProjectId(target));

    const ssh = new MockSsh();
    ssh.execScript.set("find", {
      status: 0,
      stdout: "F:/srv/app/README.md",
      stderr: "",
      truncated: false,
    });
    const remoteFilesStore = createRemoteFilesStore({ ssh });
    const opened: Array<{ host: string; path: string }> = [];

    await act(async () =>
      root?.render(
        <WorkspaceFilesPane
          projectsStore={projectsStore}
          remoteFilesStore={remoteFilesStore}
          entitlements={createEntitlements({ "ssh.pro": true })}
          openRemotePreview={(host, path) => opened.push({ host, path })}
        />,
      ),
    );
    await flush();

    expect(container!.textContent).toContain("files");
    expect(container!.textContent).toContain("box:/srv/app");
    const readme = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "README.md",
    );
    expect(readme).toBeTruthy();
    await act(async () => readme?.click());
    expect(opened).toEqual([{ host: "box", path: "/srv/app/README.md" }]);
    expect(container!.textContent).not.toContain("No project selected");
  });
});
