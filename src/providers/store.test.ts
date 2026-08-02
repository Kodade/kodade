// Provider store tests against a mock detection IPC and a fake launcher — no
// Rust, no terminal. Pins detection (installed/missing/refresh) and the
// launch-guard behavior.

import { describe, expect, it } from "vitest";
import { MockLocalIpc, MockProvider } from "../ipc/mock";
import type { Provider } from "./catalog";
import { createProvidersStore } from "./store";

// A small fixed catalog so tests don't depend on the shipping provider list.
const TEST_PROVIDERS: Provider[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    launch: "claude",
    install: "x",
  },
  { id: "codex", name: "Codex", bin: "codex", launch: "codex", install: "y" },
  {
    id: "ollama",
    name: "Ollama",
    bin: "ollama",
    launch: "ollama",
    install: "z",
  },
];

function makeStore() {
  const ipc = new MockProvider();
  const launches: { command: string; base: string }[] = [];
  const store = createProvidersStore({
    ipc,
    launch: async (command, base) => void launches.push({ command, base }),
    providers: TEST_PROVIDERS,
  });
  return { store, ipc, launches };
}

describe("providers store", () => {
  it("starts every provider as unknown before detection", () => {
    const { store } = makeStore();
    for (const p of TEST_PROVIDERS) {
      expect(store.getState().statuses[p.id]).toEqual({
        status: "unknown",
        version: null,
      });
    }
  });

  it("detectAll marks installed (with trimmed version) vs missing", async () => {
    const { store, ipc } = makeStore();
    ipc.versions.set("claude", "claude 1.2.3");
    ipc.versions.set("ollama", "ollama version is 0.4.1"); // odd shape, still trims
    // codex left unset → not installed.

    await store.getState().detectAll();
    const s = store.getState();
    expect(s.statuses.claude).toEqual({
      status: "installed",
      version: "1.2.3",
    });
    expect(s.statuses.ollama).toEqual({
      status: "installed",
      version: "0.4.1",
    });
    expect(s.statuses.codex).toEqual({ status: "missing", version: null });
    expect(s.detecting).toBe(false);
    // Every provider was probed by its bin.
    expect(ipc.detected.sort()).toEqual(["claude", "codex", "ollama"]);
  });

  it("re-detecting picks up a newly installed provider", async () => {
    const { store, ipc } = makeStore();
    await store.getState().detectAll();
    expect(store.getState().statuses.codex.status).toBe("missing");

    // User installs codex, then hits refresh.
    ipc.versions.set("codex", "codex-cli 0.9.0");
    await store.getState().detectAll();
    expect(store.getState().statuses.codex).toEqual({
      status: "installed",
      version: "0.9.0",
    });
  });

  it("a detection that throws is treated as missing, not fatal", async () => {
    const ipc = new MockProvider();
    const store = createProvidersStore({
      ipc: {
        detect: (bin: string) => {
          if (bin === "codex")
            return Promise.reject(new Error("shell blew up"));
          return ipc.detect(bin);
        },
      },
      launch: async () => {},
      providers: TEST_PROVIDERS,
    });
    ipc.versions.set("claude", "claude 1.0.0");

    await store.getState().detectAll(); // must resolve, not reject
    expect(store.getState().statuses.claude.status).toBe("installed");
    expect(store.getState().statuses.codex).toEqual({
      status: "missing",
      version: null,
    });
  });

  it("launch fires the launcher only for an installed provider", async () => {
    const { store, ipc, launches } = makeStore();
    ipc.versions.set("claude", "claude 1.2.3");
    await store.getState().detectAll();

    await store.getState().launch("claude"); // installed → launches
    await store.getState().launch("codex"); // missing → guarded, no-op
    await store.getState().launch("nope"); // unknown id → no-op

    expect(launches).toEqual([{ command: "claude", base: "claude" }]);
  });

  it("publishes an inline-friendly error when an installed provider fails to launch", async () => {
    const ipc = new MockProvider();
    ipc.versions.set("claude", "claude 1.2.3");
    let shouldFail = true;
    const store = createProvidersStore({
      ipc,
      launch: async () => {
        if (shouldFail) throw new Error("pty write failed");
      },
      providers: TEST_PROVIDERS,
    });
    await store.getState().detectAll();

    await store.getState().launch("claude");

    expect(store.getState().launchError).toBe(
      "Could not start Claude Code. Try again or open a terminal and run claude.",
    );

    shouldFail = false;
    await store.getState().launch("claude");
    expect(store.getState().launchError).toBeNull();
  });

  it("requires Node plus a reachable or resolvable daemon for KödLocal and launches its absolute bundle", async () => {
    const ipc = new MockProvider();
    const local = new MockLocalIpc();
    const launches: { command: string; base: string }[] = [];
    const provider: Provider = {
      id: "kodade-local",
      name: "KödLocal",
      bin: "node",
      launch: "node",
      install: "x",
    };
    ipc.versions.set("node", "v22.14.0");
    local.statusValue.binaryPath = null;
    const unavailable = createProvidersStore({
      ipc,
      local,
      launch: async () => {},
      providers: [provider],
    });
    await unavailable.getState().detectAll();
    expect(unavailable.getState().statuses[provider.id].status).toBe("missing");

    local.statusValue.binaryPath = "/app/kodade-modeld";
    const store = createProvidersStore({
      ipc,
      local,
      launch: async (command, base) => void launches.push({ command, base }),
      providers: [provider],
    });
    await store.getState().detectAll();
    expect(store.getState().statuses[provider.id]).toEqual({
      status: "installed",
      version: "node 22.14.0",
    });

    await store.getState().launch(provider.id);
    expect(local.starts).toBe(1);
    expect(launches).toEqual([
      {
        command:
          'node "/tmp/kodade-local.mjs" --base-url "http://127.0.0.1:4470"',
        base: "kodade-local",
      },
    ]);
  });

  it("shows the KödLocal startup cause instead of telling the user to run bare node", async () => {
    const ipc = new MockProvider();
    const local = new MockLocalIpc();
    const provider: Provider = {
      id: "kodade-local",
      name: "KödLocal",
      bin: "node",
      launch: "node",
      install: "x",
    };
    ipc.versions.set("node", "v22.14.0");
    local.start = async () => {
      throw new Error("kodade-modeld did not become healthy on port 4470");
    };
    const store = createProvidersStore({
      ipc,
      local,
      launch: async () => {},
      providers: [provider],
    });
    await store.getState().detectAll();

    await store.getState().launch(provider.id);

    expect(store.getState().launchError).toBe(
      "Could not start KödLocal. kodade-modeld did not become healthy on port 4470",
    );
  });

  it("refuses a selected saved KödLocal endpoint for a free desktop user", async () => {
    const ipc = new MockProvider();
    const local = new MockLocalIpc();
    const launches: { command: string; base: string }[] = [];
    const provider: Provider = {
      id: "kodade-local",
      name: "KödLocal",
      bin: "node",
      launch: "node",
      install: "x",
    };
    ipc.versions.set("node", "v22.14.0");
    const store = createProvidersStore({
      ipc,
      local,
      launch: async (command, base) => void launches.push({ command, base }),
      providers: [provider],
      hasFeature: () => false,
    });
    await store.getState().detectAll();

    await store.getState().launch(provider.id, {
      localBackend: {
        id: "studio",
        label: "Studio Mac",
        baseURL: "https://studio.example.test/openai/v1",
        local: false,
      },
    });

    expect(local.starts).toBe(0);
    expect(launches).toEqual([]);
    expect(store.getState().launchError).toBe(
      "Remote KödLocal backends require Ködade Pro (local.multibox).",
    );
  });

  it("allows a selected saved KödLocal endpoint for a Pro desktop user", async () => {
    const ipc = new MockProvider();
    const local = new MockLocalIpc();
    const launches: { command: string; base: string }[] = [];
    const provider: Provider = {
      id: "kodade-local",
      name: "KödLocal",
      bin: "node",
      launch: "node",
      install: "x",
    };
    ipc.versions.set("node", "v22.14.0");
    const store = createProvidersStore({
      ipc,
      local,
      launch: async (command, base) => void launches.push({ command, base }),
      providers: [provider],
      hasFeature: (feature) => feature === "local.multibox",
    });
    await store.getState().detectAll();

    await store.getState().launch(provider.id, {
      localBackend: {
        id: "studio",
        label: "Studio Mac",
        baseURL: "https://studio.example.test/openai/v1",
        local: false,
      },
    });

    expect(local.starts).toBe(0);
    expect(launches).toEqual([
      {
        command:
          'node "/tmp/kodade-local.mjs" --base-url "https://studio.example.test/openai/v1"',
        base: "kodade-local",
      },
    ]);
    expect(store.getState().launchError).toBeNull();
  });

  it("uses the remote KödLocal CLI when the desktop has a remote project active", async () => {
    const ipc = new MockProvider();
    const local = new MockLocalIpc();
    const launches: { command: string; base: string }[] = [];
    const provider: Provider = {
      id: "kodade-local",
      name: "KödLocal",
      bin: "node",
      launch: "node",
      remote: { bin: "kodade-local", launch: "kodade-local" },
      install: "x",
    };
    ipc.versions.set("node", "v22.14.0");
    const store = createProvidersStore({
      ipc,
      local,
      launch: async (command, base) => void launches.push({ command, base }),
      providers: [provider],
      isRemoteProject: () => true,
    });
    await store.getState().detectAll();

    await store.getState().launch(provider.id);

    expect(local.starts).toBe(0);
    expect(launches).toEqual([
      {
        command:
          'kodade-local --base-url "http://127.0.0.1:4470"',
        base: "kodade-local",
      },
    ]);
  });

  it("refuses a remote KödLocal endpoint without the required entitlement", async () => {
    const ipc = new MockProvider();
    const launches: { command: string; base: string }[] = [];
    const provider: Provider = {
      id: "kodade-local",
      name: "KödLocal",
      bin: "node",
      launch: "node",
      remote: { bin: "kodade-local", launch: "kodade-local" },
      install: "x",
    };
    ipc.versions.set("kodade-local", "kodade-local 1.3.0");
    const store = createProvidersStore({
      ipc,
      launch: async (command, base) => void launches.push({ command, base }),
      providers: [provider],
      isDesktop: false,
      hasFeature: () => false,
    });
    await store.getState().detectAll();

    await store.getState().launch(provider.id, {
      localBackend: {
        id: "lan",
        label: "LAN box",
        baseURL: "http://10.0.0.8:4470",
        local: false,
      },
    });

    expect(launches).toEqual([]);
    expect(store.getState().launchError).toBe(
      "Remote KödLocal backends require Ködade Pro (local.multibox).",
    );
  });

  it("uses a remote KödLocal CLI for an entitled remote session", async () => {
    const ipc = new MockProvider();
    const launches: { command: string; base: string }[] = [];
    const provider: Provider = {
      id: "kodade-local",
      name: "KödLocal",
      bin: "node",
      launch: "node",
      remote: { bin: "kodade-local", launch: "kodade-local" },
      install: "x",
    };
    ipc.versions.set("kodade-local", "kodade-local 1.3.0");
    const store = createProvidersStore({
      ipc,
      launch: async (command, base) => void launches.push({ command, base }),
      providers: [provider],
      isDesktop: false,
      hasFeature: (feature) => feature === "local.multibox",
    });
    await store.getState().detectAll();

    await store.getState().launch(provider.id, {
      localBackend: {
        id: "lan",
        label: "LAN box",
        baseURL: "http://10.0.0.8:4470",
        local: false,
      },
    });

    expect(ipc.detected).toEqual(["kodade-local"]);
    expect(launches).toEqual([
      {
        command: 'kodade-local --base-url "http://10.0.0.8:4470"',
        base: "kodade-local",
      },
    ]);
  });

  it("does not mark KödLocal installed when its bundled chat CLI cannot resolve", async () => {
    const ipc = new MockProvider();
    const local = new MockLocalIpc();
    const provider: Provider = {
      id: "kodade-local",
      name: "KödLocal",
      bin: "node",
      launch: "node",
      install: "x",
    };
    ipc.versions.set("node", "v22.14.0");
    local.statusValue.cliPath = null;

    const store = createProvidersStore({
      ipc,
      local,
      launch: async () => {},
      providers: [provider],
    });
    await store.getState().detectAll();

    expect(store.getState().statuses[provider.id]).toEqual({
      status: "missing",
      version: null,
    });
  });
});
