import { describe, expect, it } from "vitest";
import { createRemoteFilesStore } from "./remoteFiles";
import { MockSsh } from "../ipc/mock";
import type { SshExecResult } from "../ipc/contract";

const TARGET = { host: "box", path: "/repo" };

function ok(stdout: string, opts: Partial<SshExecResult> = {}): SshExecResult {
  return { status: 0, stdout, stderr: "", truncated: false, ...opts };
}

describe("createRemoteFilesStore.listTarget", () => {
  it("happy path: lists a target's tree", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", ok(["D:/repo/src", "F:/repo/src/app.ts"].join("\n")));
    const store = createRemoteFilesStore({ ssh });

    await store.getState().listTarget(TARGET);

    const listing = store.getState().listings["box\0/repo"];
    expect(listing.status).toBe("ready");
    if (listing.status === "ready") {
      expect(listing.listing.nodes.map((n) => n.name)).toEqual(["src"]);
      expect(listing.listing.truncated).toBe(false);
    }
  });

  it("surfaces an unsupported remote when find exits 127 (not found)", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", { status: 127, stdout: "", stderr: "sh: find: not found", truncated: false });
    const store = createRemoteFilesStore({ ssh });

    await store.getState().listTarget(TARGET);

    expect(store.getState().listings["box\0/repo"]).toEqual({ status: "unsupported" });
  });

  it("surfaces a failed state on a nonzero, non-127 exit", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", { status: 1, stdout: "", stderr: "permission denied", truncated: false });
    const store = createRemoteFilesStore({ ssh });

    await store.getState().listTarget(TARGET);

    const listing = store.getState().listings["box\0/repo"];
    expect(listing).toEqual({ status: "failed", reason: "permission denied" });
  });

  it("surfaces a failed state on a rejected exec (timeout)", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", "reject");
    ssh.execRejectReason = "ssh_exec timed out after 15000ms";
    const store = createRemoteFilesStore({ ssh });

    await store.getState().listTarget(TARGET);

    expect(store.getState().listings["box\0/repo"]).toEqual({
      status: "failed",
      reason: "ssh_exec timed out after 15000ms",
    });
  });

  it("rejects an invalid host before ever calling exec", async () => {
    const ssh = new MockSsh();
    const store = createRemoteFilesStore({ ssh });

    await store.getState().listTarget({ host: "-oProxyCommand=evil", path: "/repo" });

    expect(ssh.execCalls).toHaveLength(0);
    const listing = store.getState().listings["-oProxyCommand=evil\0/repo"];
    expect(listing.status).toBe("failed");
  });

  it("propagates the ssh_exec truncated flag onto the listing", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", ok("F:/repo/a.txt", { truncated: true }));
    const store = createRemoteFilesStore({ ssh });

    await store.getState().listTarget(TARGET);

    const listing = store.getState().listings["box\0/repo"];
    expect(listing.status).toBe("ready");
    if (listing.status === "ready") expect(listing.listing.truncated).toBe(true);
  });

  it("a stale in-flight list can't clobber a newer refresh (generation guard)", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", ok("F:/repo/a.txt"));
    ssh.execLatencyMs = 20;
    const store = createRemoteFilesStore({ ssh });

    const first = store.getState().listTarget(TARGET);
    // Second call starts before the first resolves and should "win".
    ssh.execLatencyMs = 0;
    ssh.execScript.set("find", ok("F:/repo/b.txt"));
    await store.getState().listTarget(TARGET);
    await first;

    const listing = store.getState().listings["box\0/repo"];
    expect(listing.status).toBe("ready");
    if (listing.status === "ready") expect(listing.listing.nodes.map((n) => n.name)).toEqual(["b.txt"]);
  });

  it("clearListing drops the cached entry and invalidates an in-flight probe", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("find", ok("F:/repo/a.txt"));
    ssh.execLatencyMs = 20;
    const store = createRemoteFilesStore({ ssh });

    const inFlight = store.getState().listTarget(TARGET);
    store.getState().clearListing(TARGET);
    await inFlight;

    // The stale in-flight result must not resurrect the cleared entry.
    expect(store.getState().listings["box\0/repo"]).toBeUndefined();
  });
});

describe("createRemoteFilesStore.fetchPreview", () => {
  it("happy path: fetches and caps preview content", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("head", ok("console.log('hi')\n"));
    const store = createRemoteFilesStore({ ssh });

    await store.getState().fetchPreview("box", "/repo/a.ts");

    const preview = store.getState().previews["box\0/repo/a.ts"];
    expect(preview).toEqual({ status: "ready", content: "console.log('hi')\n", truncated: false });
  });

  it("sniffs a NUL byte in the first chunk as binary", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("head", ok("PNG\0\0\0IHDR"));
    const store = createRemoteFilesStore({ ssh });

    await store.getState().fetchPreview("box", "/repo/image.png");

    expect(store.getState().previews["box\0/repo/image.png"]).toEqual({ status: "binary" });
  });

  it("flags truncation when the response exceeds the byte cap", async () => {
    const ssh = new MockSsh();
    const store = createRemoteFilesStore({ ssh, previewTimeoutMs: 1000 });
    // Force a small cap indirectly isn't exposed, so simulate via the
    // ssh_exec-level `truncated` flag instead (the Rust output cap path).
    ssh.execScript.set("head", ok("hello", { truncated: true }));

    await store.getState().fetchPreview("box", "/repo/a.txt");

    const preview = store.getState().previews["box\0/repo/a.txt"];
    expect(preview.status).toBe("ready");
    if (preview.status === "ready") expect(preview.truncated).toBe(true);
  });

  it("surfaces a failed state on a nonzero exit", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("head", { status: 1, stdout: "", stderr: "no such file", truncated: false });
    const store = createRemoteFilesStore({ ssh });

    await store.getState().fetchPreview("box", "/repo/missing.txt");

    expect(store.getState().previews["box\0/repo/missing.txt"]).toEqual({
      status: "failed",
      reason: "no such file",
    });
  });

  it("clearPreview drops the cached entry and invalidates an in-flight fetch", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("head", ok("hi"));
    ssh.execLatencyMs = 20;
    const store = createRemoteFilesStore({ ssh });

    const fetch = store.getState().fetchPreview("box", "/repo/a.txt");
    store.getState().clearPreview("box", "/repo/a.txt");
    await fetch;

    expect(store.getState().previews["box\0/repo/a.txt"]).toBeUndefined();
  });
});
