import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockSsh } from "../ipc/mock";
import { createRemoteFilesStore } from "../store/remoteFiles";
import { createEntitlements } from "../app/entitlements";
import { RemoteFilesPane } from "./RemoteFilesPane";

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

describe("RemoteFilesPane", () => {
  it("gates rendering behind ssh.pro (defense in depth for a persisted tab)", async () => {
    const ssh = new MockSsh();
    const store = createRemoteFilesStore({ ssh });
    const entitlements = createEntitlements({ "ssh.pro": false });
    await act(async () =>
      root?.render(<RemoteFilesPane host="box" path="/repo" store={store} entitlements={entitlements} />),
    );
    expect(container!.textContent).toContain("Pro feature");
    // Gating must be render-side, not just "don't show the button": no list
    // call should even fire for a locked pane.
    expect(ssh.execCalls).toHaveLength(0);
  });

  it("lists a target's tree and opens a preview on file click", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", {
      status: 0,
      stdout: ["D:/repo/src", "F:/repo/src/app.ts", "F:/repo/README.md"].join("\n"),
      stderr: "",
      truncated: false,
    });
    const store = createRemoteFilesStore({ ssh });
    const entitlements = createEntitlements({ "ssh.pro": true });
    const opened: { host: string; path: string }[] = [];
    await act(async () =>
      root?.render(
        <RemoteFilesPane
          host="box"
          path="/repo"
          store={store}
          entitlements={entitlements}
          openPreview={(host, path) => opened.push({ host, path })}
        />,
      ),
    );
    await flush();

    expect(container!.textContent).toContain("README.md");
    const readme = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "README.md",
    )!;
    await act(async () => readme.click());
    expect(opened).toEqual([{ host: "box", path: "/repo/README.md" }]);
  });

  it("shows the unsupported-remote state distinctly from a generic failure", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", { status: 127, stdout: "", stderr: "not found", truncated: false });
    const store = createRemoteFilesStore({ ssh });
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(<RemoteFilesPane host="box" path="/repo" store={store} entitlements={entitlements} />),
    );
    await flush();

    expect(container!.textContent).toContain("doesn't look like a POSIX host");
  });

  it("shows a truncation banner when the probe hit the entry cap", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", { status: 0, stdout: "F:/repo/a.txt", stderr: "", truncated: true });
    const store = createRemoteFilesStore({ ssh });
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(<RemoteFilesPane host="box" path="/repo" store={store} entitlements={entitlements} />),
    );
    await flush();

    expect(container!.textContent).toContain("truncated");
  });
});
