import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockSsh } from "../ipc/mock";
import { createRemoteFilesStore } from "../store/remoteFiles";
import { createEntitlements } from "../app/entitlements";
import { RemotePreviewPane } from "./RemotePreviewPane";

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

describe("RemotePreviewPane", () => {
  it("gates rendering behind ssh.pro (defense in depth for a persisted tab)", async () => {
    const ssh = new MockSsh();
    const store = createRemoteFilesStore({ ssh });
    const entitlements = createEntitlements({ "ssh.pro": false });
    await act(async () =>
      root?.render(
        <RemotePreviewPane host="box" path="/repo/a.ts" store={store} entitlements={entitlements} />,
      ),
    );
    expect(container!.textContent).toContain("Pro feature");
    expect(ssh.execCalls).toHaveLength(0);
  });

  it("fetches and renders text content read-only", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("head", {
      status: 0,
      stdout: "console.log('hi')\n",
      stderr: "",
      truncated: false,
    });
    const store = createRemoteFilesStore({ ssh });
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemotePreviewPane host="box" path="/repo/a.ts" store={store} entitlements={entitlements} />,
      ),
    );
    await flush();
    await flush(); // second effect (CodeMirror mount) settles a tick later

    expect(container!.textContent).toContain("console.log");
    expect(container!.textContent).toContain("read-only");
  });

  it("shows a binary placeholder instead of rendering when a NUL byte is sniffed", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("head", { status: 0, stdout: "PNG\0\0\0IHDR", stderr: "", truncated: false });
    const store = createRemoteFilesStore({ ssh });
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemotePreviewPane host="box" path="/repo/image.png" store={store} entitlements={entitlements} />,
      ),
    );
    await flush();

    expect(container!.textContent).toContain("Binary file");
  });

  it("shows a failed state on a nonzero exit", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("head", { status: 1, stdout: "", stderr: "permission denied", truncated: false });
    const store = createRemoteFilesStore({ ssh });
    const entitlements = createEntitlements({ "ssh.pro": true });
    await act(async () =>
      root?.render(
        <RemotePreviewPane host="box" path="/repo/a.ts" store={store} entitlements={entitlements} />,
      ),
    );
    await flush();

    expect(container!.textContent).toContain("permission denied");
  });
});
