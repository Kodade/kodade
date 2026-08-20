// Agent persona store (#64): CRUD, whole-document persistence, per-scope
// isolation, and empty/corrupt-document bootstrap. Driven against the shared
// MockStorage, same discipline as the KödWork store tests.

import { describe, expect, it } from "vitest";
import { MockStorage } from "../ipc/mock";
import { personaDocName, parsePersistedPersonaDoc } from "./persona";
import { createPersonaStore, type PersonaScope } from "./persona-store";

const APP: PersonaScope = { kind: "app" };
const PROJ_A: PersonaScope = { kind: "project", projectId: "proj-a" };
const PROJ_B: PersonaScope = { kind: "project", projectId: "proj-b" };

function setup() {
  const storage = new MockStorage();
  let seq = 0;
  const store = createPersonaStore({
    storage,
    newId: () => `id-${++seq}`,
    now: () => 1000,
  });
  return { storage, store };
}

// The persona document as it currently sits on the mock "disk".
function persisted(storage: MockStorage) {
  return parsePersistedPersonaDoc(JSON.parse(storage.docs.get(personaDocName)!));
}

describe("createPersonaStore", () => {
  it("bootstraps from a missing document", async () => {
    const { store } = setup();
    await store.load();
    expect(store.list(APP)).toEqual([]);
    expect(store.list(PROJ_A)).toEqual([]);
  });

  it("recovers from a corrupt document", async () => {
    const { storage, store } = setup();
    storage.docs.set(personaDocName, "{ not json");
    await store.load();
    expect(store.list(APP)).toEqual([]);
  });

  it("creates and persists the whole document", async () => {
    const { storage, store } = setup();
    await store.load();
    const made = await store.create(APP, { providerId: "claude", name: "Reviewer" });
    expect(made.id).toBe("id-1");
    expect(store.list(APP)).toEqual([made]);
    // The full doc was written, and it parses back to the same persona.
    expect(persisted(storage).app).toEqual([made]);
    expect(storage.docWrites).toBe(1);
  });

  it("updates an existing persona and returns null for a miss", async () => {
    const { storage, store } = setup();
    await store.load();
    const made = await store.create(APP, { providerId: "claude", name: "Reviewer" });
    const updated = await store.update(APP, made.id, { name: "Senior reviewer" });
    expect(updated?.name).toBe("Senior reviewer");
    expect(store.list(APP)[0].name).toBe("Senior reviewer");
    expect(persisted(storage).app[0].name).toBe("Senior reviewer");
    expect(await store.update(APP, "missing", { name: "x" })).toBeNull();
  });

  it("removes a persona and drops the emptied project key", async () => {
    const { storage, store } = setup();
    await store.load();
    const made = await store.create(PROJ_A, { providerId: "claude" });
    await store.remove(PROJ_A, made.id);
    expect(store.list(PROJ_A)).toEqual([]);
    expect(persisted(storage).projects).toEqual({});
  });

  it("no-ops (no write) when removing a missing id", async () => {
    const { storage, store } = setup();
    await store.load();
    await store.create(APP, { providerId: "claude" });
    const writesBefore = storage.docWrites;
    await store.remove(APP, "missing");
    expect(storage.docWrites).toBe(writesBefore);
  });

  it("keeps app and per-project scopes isolated", async () => {
    const { store } = setup();
    await store.load();
    const appP = await store.create(APP, { providerId: "claude", name: "App" });
    const aP = await store.create(PROJ_A, { providerId: "claude", name: "A" });
    const bP = await store.create(PROJ_B, { providerId: "codex", name: "B" });
    expect(store.list(APP)).toEqual([appP]);
    expect(store.list(PROJ_A)).toEqual([aP]);
    expect(store.list(PROJ_B)).toEqual([bP]);
    // Removing one project's persona leaves the others untouched.
    await store.remove(PROJ_A, aP.id);
    expect(store.list(PROJ_A)).toEqual([]);
    expect(store.list(APP)).toEqual([appP]);
    expect(store.list(PROJ_B)).toEqual([bP]);
  });

  it("reloads a previously persisted document", async () => {
    const { storage, store } = setup();
    await store.load();
    await store.create(APP, { providerId: "claude", name: "Persisted" });

    // A fresh store over the same storage sees the saved persona.
    const reopened = createPersonaStore({ storage, now: () => 2000 });
    await reopened.load();
    expect(reopened.list(APP).map((p) => p.name)).toEqual(["Persisted"]);
  });

  it("returns copies so callers cannot mutate store state", async () => {
    const { store } = setup();
    await store.load();
    await store.create(APP, { providerId: "claude" });
    const list = store.list(APP);
    list.pop();
    expect(store.list(APP).length).toBe(1);
  });
});
