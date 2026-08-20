// Agents app-state store (#64, slice 2): the reactive mirror over the persona
// store, per-scope isolation of the mirror, mutation error capture, and run
// selection. Driven against the real persona store over MockStorage.

import { describe, expect, it } from "vitest";
import { MockStorage } from "../ipc/mock";
import { createPersonaStore, type PersonaScope } from "./persona-store";
import { createAgentsStore, personaScopeKey } from "./agents-store";

const APP: PersonaScope = { kind: "app" };
const PROJ: PersonaScope = { kind: "project", projectId: "p1" };

function setup() {
  const storage = new MockStorage();
  let seq = 0;
  const personaStore = createPersonaStore({
    storage,
    newId: () => `id-${++seq}`,
    now: () => 1000,
  });
  const store = createAgentsStore({ store: personaStore });
  return { storage, personaStore, store };
}

describe("createAgentsStore", () => {
  it("mirrors the app scope on load", async () => {
    const { store } = setup();
    await store.getState().load();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().personasFor(APP)).toStrictEqual([]);
  });

  it("reflects a create into the mirrored scope and stays isolated", async () => {
    const { store } = setup();
    await store.getState().load();
    store.getState().syncScope(PROJ);

    const appP = await store.getState().createPersona(APP, {
      providerId: "claude",
      name: "App",
    });
    const projP = await store.getState().createPersona(PROJ, {
      providerId: "codex",
      name: "Proj",
    });

    expect(appP).not.toBeNull();
    expect(projP).not.toBeNull();
    expect(store.getState().personasFor(APP)).toStrictEqual([appP]);
    expect(store.getState().personasFor(PROJ)).toStrictEqual([projP]);
    // The mirror is keyed per scope.
    expect(store.getState().personas[personaScopeKey(APP)]).toStrictEqual([appP]);
    expect(store.getState().personas[personaScopeKey(PROJ)]).toStrictEqual([projP]);
  });

  it("updates and removes through the mirror", async () => {
    const { store } = setup();
    await store.getState().load();
    const made = await store.getState().createPersona(APP, { providerId: "claude", name: "A" });
    const updated = await store.getState().updatePersona(APP, made!.id, { name: "B" });
    expect(updated?.name).toBe("B");
    expect(store.getState().personasFor(APP)[0].name).toBe("B");

    await store.getState().removePersona(APP, made!.id);
    expect(store.getState().personasFor(APP)).toStrictEqual([]);
  });

  it("getPersona reads through to the source of truth", async () => {
    const { store } = setup();
    await store.getState().load();
    const made = await store.getState().createPersona(APP, { providerId: "claude", name: "A" });
    expect(store.getState().getPersona(APP, made!.id)).toStrictEqual(made);
    expect(store.getState().getPersona(APP, "missing")).toBeNull();
  });

  it("captures a mutation failure instead of throwing", async () => {
    const { storage, store } = setup();
    // A corrupt document makes the persona store refuse writes.
    storage.docs.set("agents/personas.json", "{ not json");
    await store.getState().load();
    const result = await store.getState().createPersona(APP, { providerId: "claude" });
    expect(result).toBeNull();
    expect(store.getState().mutationError).toBeTruthy();
    // A later successful path clears the error.
  });

  it("clears the mutation error on the next successful mutation", async () => {
    const { store } = setup();
    await store.getState().load();
    // Blank provider fails validation.
    const bad = await store.getState().createPersona(APP, { providerId: "  " });
    expect(bad).toBeNull();
    expect(store.getState().mutationError).toBeTruthy();
    const good = await store.getState().createPersona(APP, { providerId: "claude" });
    expect(good).not.toBeNull();
    expect(store.getState().mutationError).toBeNull();
  });

  it("tracks the selected run", () => {
    const { store } = setup();
    expect(store.getState().selectedRunTaskId).toBeNull();
    store.getState().selectRun("task-1");
    expect(store.getState().selectedRunTaskId).toBe("task-1");
    store.getState().selectRun(null);
    expect(store.getState().selectedRunTaskId).toBeNull();
  });

  it("re-mirrors a scope synced before load resolved", async () => {
    const storage = new MockStorage();
    // Seed a project persona directly on disk through a separate store.
    const seeder = createPersonaStore({ storage, newId: () => "seed", now: () => 1 });
    await seeder.load();
    await seeder.create(PROJ, { providerId: "claude", name: "Helper" });

    const store = createAgentsStore({ store: createPersonaStore({ storage }) });
    // Sync the project scope BEFORE load — it mirrors an empty list at first.
    store.getState().syncScope(PROJ);
    expect(store.getState().personasFor(PROJ)).toStrictEqual([]);
    // load() re-mirrors every known scope from the now-read document.
    await store.getState().load();
    expect(store.getState().personasFor(PROJ).map((p) => p.name)).toStrictEqual([
      "Helper",
    ]);
  });

  it("reports unreadable storage after a corrupt load", async () => {
    const { storage, store } = setup();
    storage.docs.set("agents/personas.json", "{ not json");
    await store.getState().load();
    expect(store.getState().storageReadable).toBe(false);
  });

  it("reports readable storage on a clean load", async () => {
    const { store } = setup();
    await store.getState().load();
    expect(store.getState().storageReadable).toBe(true);
  });

  it("bumps runOpenSeq on every selectRun, even for the same id", () => {
    const { store } = setup();
    const s0 = store.getState().runOpenSeq;
    store.getState().selectRun("t");
    const s1 = store.getState().runOpenSeq;
    store.getState().selectRun("t");
    const s2 = store.getState().runOpenSeq;
    expect(s1).toBeGreaterThan(s0);
    expect(s2).toBeGreaterThan(s1);
  });

  it("clears the mutation error on demand", async () => {
    const { store } = setup();
    await store.getState().load();
    await store.getState().createPersona(APP, { providerId: "  " });
    expect(store.getState().mutationError).toBeTruthy();
    store.getState().clearMutationError();
    expect(store.getState().mutationError).toBeNull();
  });
});
