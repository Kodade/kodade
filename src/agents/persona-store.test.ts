// Agent persona store (#64): CRUD, whole-document persistence, per-scope
// isolation, the unreadable-document write refusal, cap enforcement, provider
// validation, and shared-load memoization. Driven against the shared
// MockStorage, same discipline as the KödWork store tests.

import { describe, expect, it } from "vitest";
import { MockStorage } from "../ipc/mock";
import {
  KODAGENT_DOC_VERSION,
  MAX_PERSONAS,
  personaDocName,
  parsePersistedPersonaDoc,
} from "./persona";
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
    expect(store.list(APP)).toStrictEqual([]);
    expect(store.list(PROJ_A)).toStrictEqual([]);
  });

  it("creates and persists the whole document", async () => {
    const { storage, store } = setup();
    await store.load();
    const made = await store.create(APP, { providerId: "claude", name: "Reviewer" });
    expect(made.id).toBe("id-1");
    expect(store.list(APP)).toStrictEqual([made]);
    // The full doc was written, and it parses back to the same persona.
    expect(persisted(storage)?.app).toStrictEqual([made]);
    expect(storage.docWrites).toBe(1);
  });

  it("updates an existing persona and returns null for a miss", async () => {
    const { storage, store } = setup();
    await store.load();
    const made = await store.create(APP, { providerId: "claude", name: "Reviewer" });
    const updated = await store.update(APP, made.id, { name: "Senior reviewer" });
    expect(updated?.name).toBe("Senior reviewer");
    expect(store.list(APP)[0].name).toBe("Senior reviewer");
    expect(persisted(storage)?.app[0].name).toBe("Senior reviewer");
    expect(await store.update(APP, "missing", { name: "x" })).toBeNull();
  });

  it("removes a persona and drops the emptied project key", async () => {
    const { storage, store } = setup();
    await store.load();
    const made = await store.create(PROJ_A, { providerId: "claude" });
    await store.remove(PROJ_A, made.id);
    expect(store.list(PROJ_A)).toStrictEqual([]);
    expect(persisted(storage)?.projects).toStrictEqual({});
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
    expect(store.list(APP)).toStrictEqual([appP]);
    expect(store.list(PROJ_A)).toStrictEqual([aP]);
    expect(store.list(PROJ_B)).toStrictEqual([bP]);
    // Removing one project's persona leaves the others untouched.
    await store.remove(PROJ_A, aP.id);
    expect(store.list(PROJ_A)).toStrictEqual([]);
    expect(store.list(APP)).toStrictEqual([appP]);
    expect(store.list(PROJ_B)).toStrictEqual([bP]);
  });

  it("reloads a previously persisted document", async () => {
    const { storage, store } = setup();
    await store.load();
    await store.create(APP, { providerId: "claude", name: "Persisted" });

    // A fresh store over the same storage sees the saved persona.
    const reopened = createPersonaStore({ storage, now: () => 2000 });
    await reopened.load();
    expect(reopened.list(APP).map((p) => p.name)).toStrictEqual(["Persisted"]);
  });

  it("round-trips a created persona through storage unchanged", async () => {
    const { storage, store } = setup();
    await store.load();
    const made = await store.create(APP, {
      providerId: "  claude  ",
      name: "Reviewer",
      prompt: "Review carefully.",
      skills: ["s1", "s2"],
      connections: ["c1"],
    });
    // providerId was trimmed, so the persona survives a reload identically.
    expect(made.providerId).toBe("claude");
    const reopened = createPersonaStore({ storage });
    await reopened.load();
    expect(reopened.list(APP)).toStrictEqual([made]);
  });

  it("deep-copies list results so callers cannot mutate store state", async () => {
    const { store } = setup();
    await store.load();
    await store.create(APP, { providerId: "claude", skills: ["s1"] });
    const list = store.list(APP);
    list.pop(); // array copy
    const again = store.list(APP);
    again[0]?.skills.push("mutated"); // element copy
    expect(store.list(APP).length).toBe(1);
    expect(store.list(APP)[0].skills).toStrictEqual(["s1"]);
  });

  // --- Write-refusal safety (finding 1 + 5) ---

  it("refuses to overwrite a corrupt document", async () => {
    const { storage, store } = setup();
    storage.docs.set(personaDocName, "{ not json");
    await store.load();
    // The empty in-memory view is fine, but a mutation must NOT clobber the file.
    expect(store.list(APP)).toStrictEqual([]);
    await expect(store.create(APP, { providerId: "claude" })).rejects.toThrow();
    expect(storage.docs.get(personaDocName)).toBe("{ not json");
    expect(storage.docWrites).toBe(0);
  });

  it("refuses to overwrite a forward-versioned document", async () => {
    const { storage, store } = setup();
    const future = JSON.stringify({
      version: KODAGENT_DOC_VERSION + 1,
      app: [{ id: "keep", providerId: "claude", name: "Newer", futureField: true }],
      projects: {},
    });
    storage.docs.set(personaDocName, future);
    await store.load();
    // The newer doc is not loaded into memory, so a create rejects at the write
    // refusal and an update over the (unseen) newer persona finds nothing.
    await expect(store.create(APP, { providerId: "claude" })).rejects.toThrow();
    expect(await store.update(APP, "keep", { name: "x" })).toBeNull();
    // The newer document is preserved byte-for-byte — a downgrade cannot wipe it.
    expect(storage.docs.get(personaDocName)).toBe(future);
    expect(storage.docWrites).toBe(0);
  });

  // --- Cap + provider validation (finding 3 + 4) ---

  it("rejects a create over MAX_PERSONAS instead of silently truncating", async () => {
    const seeded = JSON.stringify({
      version: KODAGENT_DOC_VERSION,
      app: Array.from({ length: MAX_PERSONAS }, (_, i) => ({
        id: `seed-${i}`,
        providerId: "claude",
        name: `Seed ${i}`,
        prompt: "",
        skills: [],
        connections: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      projects: {},
    });
    const { storage, store } = setup();
    storage.docs.set(personaDocName, seeded);
    await store.load();
    expect(store.list(APP).length).toBe(MAX_PERSONAS);
    await expect(store.create(APP, { providerId: "claude" })).rejects.toThrow(/200/);
    expect(storage.docWrites).toBe(0);
  });

  it("rejects a create with a blank providerId", async () => {
    const { storage, store } = setup();
    await store.load();
    await expect(store.create(APP, { providerId: "   " })).rejects.toThrow();
    expect(storage.docWrites).toBe(0);
  });

  it("rejects an update that blanks the providerId", async () => {
    const { store } = setup();
    await store.load();
    const made = await store.create(APP, { providerId: "claude" });
    await expect(store.update(APP, made.id, { providerId: "" })).rejects.toThrow();
    expect(store.list(APP)[0].providerId).toBe("claude");
  });

  // --- Load memoization (finding 6) ---

  it("shares one read across concurrent load() calls", async () => {
    const storage = new MockStorage();
    let reads = 0;
    const readDoc = storage.readDoc.bind(storage);
    storage.readDoc = (name: string) => {
      reads += 1;
      return readDoc(name);
    };
    const store = createPersonaStore({ storage });
    const a = store.load();
    const b = store.load();
    expect(a).toBe(b); // same memoized promise
    expect(reads).toBe(1);
    await Promise.all([a, b]);
  });
});
