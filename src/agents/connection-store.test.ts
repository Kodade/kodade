// Connection store (#64, slice 4): CRUD, whole-document persistence, per-scope
// isolation, the unreadable-document write refusal, cap enforcement, and
// installedState derivation. Driven against the shared MockStorage, same
// discipline as the persona store tests.

import { describe, expect, it } from "vitest";
import { MockStorage } from "../ipc/mock";
import {
  connectionDocName,
  KODCONNECTION_DOC_VERSION,
  MAX_CONNECTIONS,
  parsePersistedConnectionDoc,
  type ConnectionInput,
} from "./connection";
import { createConnectionStore, type ConnectionScope } from "./connection-store";
import type { InstalledProbe } from "./connection-install";

const APP: ConnectionScope = { kind: "app" };
const PROJ_A: ConnectionScope = { kind: "project", projectId: "proj-a" };
const PROJ_B: ConnectionScope = { kind: "project", projectId: "proj-b" };

const GITHUB: ConnectionInput = {
  source: "catalog",
  catalogId: "github",
  name: "GitHub",
  transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
  authNote: "OAuth or PAT",
};

function setup() {
  const storage = new MockStorage();
  let seq = 0;
  const store = createConnectionStore({
    storage,
    newId: () => `id-${++seq}`,
    now: () => 1000,
  });
  return { storage, store };
}

function persisted(storage: MockStorage) {
  return parsePersistedConnectionDoc(JSON.parse(storage.docs.get(connectionDocName)!));
}

describe("createConnectionStore", () => {
  it("bootstraps from a missing document", async () => {
    const { store } = setup();
    await store.load();
    expect(store.list(APP)).toStrictEqual([]);
  });

  it("creates and persists the whole document", async () => {
    const { storage, store } = setup();
    await store.load();
    const made = await store.create(APP, GITHUB);
    expect(made.id).toBe("id-1");
    expect(store.list(APP)).toStrictEqual([made]);
    expect(persisted(storage)?.app).toStrictEqual([made]);
    expect(storage.docWrites).toBe(1);
  });

  it("updates and removes, dropping an emptied project key", async () => {
    const { storage, store } = setup();
    await store.load();
    const made = await store.create(PROJ_A, GITHUB);
    const updated = await store.update(PROJ_A, made.id, { name: "GH" });
    expect(updated?.name).toBe("GH");
    await store.remove(PROJ_A, made.id);
    expect(store.list(PROJ_A)).toStrictEqual([]);
    expect(persisted(storage)?.projects).toStrictEqual({});
  });

  it("keeps app and per-project scopes isolated", async () => {
    const { store } = setup();
    await store.load();
    const appC = await store.create(APP, GITHUB);
    const aC = await store.create(PROJ_A, { ...GITHUB, name: "A" });
    const bC = await store.create(PROJ_B, { ...GITHUB, name: "B" });
    expect(store.list(APP)).toStrictEqual([appC]);
    expect(store.list(PROJ_A)).toStrictEqual([aC]);
    expect(store.list(PROJ_B)).toStrictEqual([bC]);
  });

  it("clones list/get results so callers cannot mutate store state", async () => {
    const { store } = setup();
    await store.load();
    const made = await store.create(APP, {
      source: "custom",
      name: "Fetch",
      transport: { kind: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    });
    const got = store.get(APP, made.id)!;
    if (got.transport.kind === "stdio") got.transport.args.push("mutated");
    const again = store.get(APP, made.id)!;
    if (again.transport.kind === "stdio") {
      expect(again.transport.args).toStrictEqual(["mcp-server-fetch"]);
    }
  });

  it("refuses to overwrite a corrupt document", async () => {
    const { storage, store } = setup();
    storage.docs.set(connectionDocName, "{ not json");
    await store.load();
    expect(store.isReadable()).toBe(false);
    await expect(store.create(APP, GITHUB)).rejects.toThrow();
    expect(storage.docs.get(connectionDocName)).toBe("{ not json");
    expect(storage.docWrites).toBe(0);
  });

  it("refuses to overwrite a forward-versioned document", async () => {
    const { storage, store } = setup();
    const future = JSON.stringify({
      version: KODCONNECTION_DOC_VERSION + 1,
      app: [{ id: "keep", source: "custom", transport: { kind: "http", url: "https://x" } }],
      projects: {},
    });
    storage.docs.set(connectionDocName, future);
    await store.load();
    await expect(store.create(APP, GITHUB)).rejects.toThrow();
    expect(await store.update(APP, "keep", { name: "x" })).toBeNull();
    expect(storage.docs.get(connectionDocName)).toBe(future);
    expect(storage.docWrites).toBe(0);
  });

  it("rejects a create over MAX_CONNECTIONS", async () => {
    const seeded = JSON.stringify({
      version: KODCONNECTION_DOC_VERSION,
      app: Array.from({ length: MAX_CONNECTIONS }, (_, i) => ({
        id: `seed-${i}`,
        source: "custom",
        transport: { kind: "http", url: "https://x" },
      })),
      projects: {},
    });
    const { storage, store } = setup();
    storage.docs.set(connectionDocName, seeded);
    await store.load();
    await expect(store.create(APP, GITHUB)).rejects.toThrow(/200/);
    expect(storage.docWrites).toBe(0);
  });

  it("rejects a create with an invalid transport", async () => {
    const { storage, store } = setup();
    await store.load();
    await expect(
      store.create(APP, { source: "custom", transport: { kind: "http", url: "  " } } as ConnectionInput),
    ).rejects.toThrow();
    expect(storage.docWrites).toBe(0);
  });

  it("reloads a previously persisted document", async () => {
    const { storage, store } = setup();
    await store.load();
    await store.create(APP, GITHUB);
    const reopened = createConnectionStore({ storage });
    await reopened.load();
    expect(reopened.list(APP).map((c) => c.name)).toStrictEqual(["GitHub"]);
  });

  describe("installedState", () => {
    it("matches probes by the connection's resolved server key", async () => {
      const { store } = setup();
      await store.load();
      const github = await store.create(APP, GITHUB);
      const probes: InstalledProbe[] = [
        { cli: "claude", server: "github", path: "/repo/.mcp.json" },
        { cli: "codex", server: "other", path: "/home/.codex/config.toml" },
        { cli: "opencode", server: "github", path: "/repo/opencode.json" },
        // A duplicate probe for the same cli+path collapses.
        { cli: "claude", server: "github", path: "/repo/.mcp.json" },
      ];
      expect(store.installedState(github, probes)).toStrictEqual([
        { cli: "claude", path: "/repo/.mcp.json" },
        { cli: "opencode", path: "/repo/opencode.json" },
      ]);
    });

    it("returns nothing when no probe matches", async () => {
      const { store } = setup();
      await store.load();
      const github = await store.create(APP, GITHUB);
      expect(store.installedState(github, [{ cli: "claude", server: "notion", path: "/x" }])).toStrictEqual([]);
    });
  });
});
