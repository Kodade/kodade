import { describe, expect, it } from "vitest";
import { createSshStore } from "./ssh";
import { MockSsh } from "../ipc/mock";

describe("createSshStore", () => {
  it("happy path: detects ssh and populates hosts from the main config", async () => {
    const ssh = new MockSsh();
    ssh.configs.set(undefined, "Host box\n  HostName 1.2.3.4\n  User keith\n");
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.sshPath).toBe("/usr/bin/ssh");
    expect(state.sshVersion).toBe("OpenSSH_9.6");
    expect(state.hosts).toEqual([{ alias: "box", hostName: "1.2.3.4", user: "keith" }]);
    expect(state.error).toBeUndefined();
  });

  it("surfaces an error and clears hosts when ssh is missing", async () => {
    const ssh = new MockSsh();
    ssh.detectResult = null;
    ssh.detectFailure = "ssh: command not found";
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.status).toBe("error");
    expect(state.error).toBe("ssh: command not found");
    expect(state.hosts).toEqual([]);
    expect(state.sshPath).toBeUndefined();
  });

  it("treats a missing config file as an empty (not error) host list", async () => {
    const ssh = new MockSsh();
    // No entry in ssh.configs for the main path -> readConfig resolves null.
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.hosts).toEqual([]);
    expect(state.error).toBeUndefined();
  });

  it("resolves Include directives and merges their hosts", async () => {
    const ssh = new MockSsh();
    ssh.configs.set(undefined, "Include conf.d/extra\n\nHost main\n  HostName 9.9.9.9\n");
    ssh.configs.set("conf.d/extra", "Host included\n  HostName 5.5.5.5\n  Port 2200\n");
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.hosts).toEqual([
      { alias: "main", hostName: "9.9.9.9" },
      { alias: "included", hostName: "5.5.5.5", port: 2200 },
    ]);
    expect(ssh.readQueries).toEqual([undefined, "conf.d/extra"]);
  });

  it("skips an Include target that rejects (guard rejection) without failing the store", async () => {
    const ssh = new MockSsh();
    ssh.configs.set(undefined, "Include ../outside\n\nHost main\n  HostName 9.9.9.9\n");
    ssh.readFailPaths.add("../outside");
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.hosts).toEqual([{ alias: "main", hostName: "9.9.9.9" }]);
  });

  it("dedups repeated Include targets and never revisits the main file", async () => {
    const ssh = new MockSsh();
    ssh.configs.set(undefined, "Include shared\nInclude shared\n\nHost main\n  HostName 1.1.1.1\n");
    ssh.configs.set("shared", "Host shared-host\n  HostName 2.2.2.2\n");
    const store = createSshStore({ ssh });

    await store.getState().init();

    expect(ssh.readQueries).toEqual([undefined, "shared"]);
    expect(store.getState().hosts).toEqual([
      { alias: "main", hostName: "1.1.1.1" },
      { alias: "shared-host", hostName: "2.2.2.2" },
    ]);
  });

  it("expands a globbed Include, merging hosts from every matching fragment", async () => {
    const ssh = new MockSsh();
    ssh.configs.set(undefined, "Include ~/.ssh/config.d/*\n\nHost main\n  HostName 9.9.9.9\n");
    ssh.dirs.set("~/.ssh/config.d", ["aa", "bb"]);
    ssh.configs.set("~/.ssh/config.d/aa", "Host frag-a\n  HostName 1.1.1.1\n");
    ssh.configs.set("~/.ssh/config.d/bb", "Host frag-b\n  HostName 2.2.2.2\n");
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.hosts).toEqual([
      { alias: "main", hostName: "9.9.9.9" },
      { alias: "frag-a", hostName: "1.1.1.1" },
      { alias: "frag-b", hostName: "2.2.2.2" },
    ]);
    expect(ssh.listQueries).toEqual(["~/.ssh/config.d"]);
  });

  it("filters glob fragments by the pattern's suffix", async () => {
    const ssh = new MockSsh();
    ssh.configs.set(undefined, "Include conf.d/*.conf\n\nHost main\n  HostName 9.9.9.9\n");
    ssh.dirs.set("conf.d", ["good.conf", "notes.txt"]);
    ssh.configs.set("conf.d/good.conf", "Host good\n  HostName 3.3.3.3\n");
    ssh.configs.set("conf.d/notes.txt", "Host skipped\n  HostName 4.4.4.4\n");
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.hosts).toEqual([
      { alias: "main", hostName: "9.9.9.9" },
      { alias: "good", hostName: "3.3.3.3" },
    ]);
    // The non-matching fragment was never even read.
    expect(ssh.readQueries).toEqual([undefined, "conf.d/good.conf"]);
  });

  it("treats a globbed Include over a missing directory as no hosts, not an error", async () => {
    const ssh = new MockSsh();
    ssh.configs.set(undefined, "Include config.d/*\n\nHost main\n  HostName 9.9.9.9\n");
    // No "config.d" entry in ssh.dirs -> listDir resolves null.
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.hosts).toEqual([{ alias: "main", hostName: "9.9.9.9" }]);
  });

  it("skips a glob whose directory listing rejects, without failing the store", async () => {
    const ssh = new MockSsh();
    ssh.configs.set(undefined, "Include ../outside/*\n\nHost main\n  HostName 9.9.9.9\n");
    ssh.listFailPaths.add("../outside");
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.hosts).toEqual([{ alias: "main", hostName: "9.9.9.9" }]);
  });

  it("propagates a rejected main-config read as a store error", async () => {
    const ssh = new MockSsh();
    ssh.readFailPaths.add(undefined);
    const store = createSshStore({ ssh });

    await store.getState().init();

    const state = store.getState();
    expect(state.status).toBe("error");
    expect(state.hosts).toEqual([]);
    expect(state.error).toBeTruthy();
  });

  it("re-running init() starts from a clean slate", async () => {
    const ssh = new MockSsh();
    ssh.configs.set(undefined, "Host first\n  HostName 1.1.1.1\n");
    const store = createSshStore({ ssh });
    await store.getState().init();
    expect(store.getState().hosts).toEqual([{ alias: "first", hostName: "1.1.1.1" }]);

    ssh.configs.set(undefined, "Host second\n  HostName 2.2.2.2\n");
    await store.getState().init();
    expect(store.getState().hosts).toEqual([{ alias: "second", hostName: "2.2.2.2" }]);
  });
});

describe("createSshStore detectTarget", () => {
  const target = { host: "box", path: "/home/keith/app" };
  const key = "box\0/home/keith/app";
  const ready = { status: 0, stdout: "/usr/bin/x", stderr: "", truncated: false } as const;

  it("moves each provider to ready/failed based on the remote probe", async () => {
    const ssh = new MockSsh();
    // claude is installed; codex times out (rejected call); the rest default to
    // exit 127 -> not found.
    ssh.execScript.set("claude", ready);
    ssh.execScript.set("codex", "reject");
    const store = createSshStore({ ssh });

    await store.getState().detectTarget(target);

    const d = store.getState().detections[key];
    expect(d.claude).toEqual({ status: "ready" });
    expect(d.codex.status).toBe("failed");
    expect(d.grok).toEqual({ status: "failed", reason: "not found" });
    expect(d.opencode).toEqual({ status: "failed", reason: "not found" });
    // The probe went out as `command -v <bin>`, host passed separately.
    expect(ssh.execCalls.every((c) => c.host === "box")).toBe(true);
    expect(ssh.execCalls.some((c) => c.argv.join(" ").includes("claude"))).toBe(true);
  });

  it("treats an exit-0 probe with empty stdout as not found (not ready)", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("claude", { status: 0, stdout: "", stderr: "", truncated: false });
    const store = createSshStore({ ssh });

    await store.getState().detectTarget(target);

    expect(store.getState().detections[key].claude).toEqual({
      status: "failed",
      reason: "not found",
    });
  });

  it("fails every provider (without probing) when the host is invalid", async () => {
    const ssh = new MockSsh();
    const store = createSshStore({ ssh });

    await store.getState().detectTarget({ host: "box; rm -rf /", path: "/x" });

    const d = store.getState().detections["box; rm -rf /\0/x"];
    expect(d.claude.status).toBe("failed");
    expect(d.claude.status === "failed" && d.claude.reason).toMatch(/invalid host/);
    // No ssh_exec ever went out for a rejected host.
    expect(ssh.execCalls).toHaveLength(0);
  });

  it("surfaces a timeout/unsupported-remote rejection as the provider's reason", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("claude", "reject");
    ssh.execRejectReason = "ssh_exec timed out after 8000ms";
    const store = createSshStore({ ssh });

    await store.getState().detectTarget(target);

    const claude = store.getState().detections[key].claude;
    expect(claude.status).toBe("failed");
    expect(claude.status === "failed" && claude.reason).toBe("ssh_exec timed out after 8000ms");
  });

  it("re-detect reflects the remote changing (claude appears, then goes away)", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("claude", ready);
    const store = createSshStore({ ssh });

    await store.getState().detectTarget(target);
    expect(store.getState().detections[key].claude).toEqual({ status: "ready" });

    ssh.execScript.set("claude", { status: 127, stdout: "", stderr: "", truncated: false });
    await store.getState().detectTarget(target);
    expect(store.getState().detections[key].claude.status).toBe("failed");
  });

  it("a stale in-flight probe can't clobber a newer run's result", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("claude", ready);
    ssh.execLatencyMs = 20; // both runs are in flight together
    const store = createSshStore({ ssh });

    const first = store.getState().detectTarget(target);
    const second = store.getState().detectTarget(target);
    await Promise.all([first, second]);

    // Whichever settled, the second run is the current generation; claude ready
    // stands and nothing is left pending.
    expect(store.getState().detections[key].claude).toEqual({ status: "ready" });
  });

  it("clearDetections drops the target's state (unpin -> repin re-probes clean)", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("claude", ready);
    const store = createSshStore({ ssh });

    await store.getState().detectTarget(target);
    expect(store.getState().detections[key]).toBeDefined();

    store.getState().clearDetections(target);
    expect(store.getState().detections[key]).toBeUndefined();

    // A fresh detect after the clear probes and populates again.
    await store.getState().detectTarget(target);
    expect(store.getState().detections[key].claude).toEqual({ status: "ready" });
  });

  it("clearDetections invalidates an in-flight probe so it can't resurrect the entry", async () => {
    const ssh = new MockSsh();
    ssh.execScript.set("claude", ready);
    ssh.execLatencyMs = 20; // keep the probe in flight while we clear
    const store = createSshStore({ ssh });

    const inFlight = store.getState().detectTarget(target);
    store.getState().clearDetections(target);
    await inFlight;

    // The stale run's results were discarded — the entry stays cleared.
    expect(store.getState().detections[key]).toBeUndefined();
  });
});
