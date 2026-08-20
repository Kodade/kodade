// Store logic tests against MOCK storage and a fake registry — no xterm, no
// Tauri. This is where project/session lifecycle rules are pinned down.

import { describe, expect, it, vi } from "vitest";
import { MockStorage } from "../ipc/mock";
import {
  createActivityAdapters,
  type WorkspaceActivityFact,
} from "../activity/adapters";
import { createActivityModule } from "../activity/activity";
import {
  createProjectsStore,
  STORAGE_VERSION,
  type PersistedDoc,
} from "./projects";
import { remoteProjectId } from "../ssh/model";
import { defaultShellLayout } from "../components/shell/shell-layout";

// Fake registry that records opens/closes (the store never sees xterm).
function fakeRegistry() {
  const opens: { id: string; cwd: string }[] = [];
  const closes: string[] = [];
  const writes: { id: string; data: string }[] = [];
  return {
    opens,
    closes,
    writes,
    registry: {
      open: (id: string, cwd: string) => void opens.push({ id, cwd }),
      close: async (id: string) => void closes.push(id),
      write: (id: string, data: string) => void writes.push({ id, data }),
    },
  };
}

// Deterministic id generator per store.
function idGen() {
  let n = 0;
  return () => `id-${++n}`;
}

function makeStore(
  storage = new MockStorage(),
  canonicalize?: (path: string) => Promise<string>,
  startHydration = true,
  extraDeps: Partial<Parameters<typeof createProjectsStore>[0]> = {},
) {
  const { opens, closes, writes, registry } = fakeRegistry();
  const store = createProjectsStore({
    storage,
    registry,
    newId: idGen(),
    canonicalize,
    ...extraDeps,
  });
  // Production starts hydration before any normal mutation can be made; mirror
  // that lifecycle here. Tests for the pre-start gate opt out explicitly.
  if (startHydration) void store.getState().hydrate();
  return { store, storage, opens, closes, writes };
}

describe("projects store", () => {
  it("flushes immediate and debounced persistence through one observable seam", async () => {
    const { store, storage } = makeStore();
    await store.getState().addProject("/repos/alpha");

    store.getState().setTheme("dark");
    store.getState().setLayout([10, 50, 15, 25]);
    await store.getState().flushPersistence();

    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      theme: "dark",
      layout: [10, 50, 15, 25],
    });
  });

  it("addProject adds, selects, and auto-opens a terminal at the project root", async () => {
    const { store, opens } = makeStore();
    await store.getState().addProject("/repos/alpha");

    const s = store.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0]).toMatchObject({
      name: "alpha",
      path: "/repos/alpha",
    });
    expect(s.activeProjectId).toBe(s.projects[0].id);
    // Auto-opened session lives at the project root and is the active one.
    expect(opens).toHaveLength(1);
    expect(opens[0].cwd).toBe("/repos/alpha");
    expect(s.sessions[0].name).toBe("zsh 1");
    expect(s.activeSessionByProject[s.projects[0].id]).toBe(s.sessions[0].id);
  });

  it("adding a duplicate path (even with trailing slash) selects, not duplicates", async () => {
    const { store, opens } = makeStore();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta");
    expect(store.getState().activeProjectId).toBe(
      store.getState().projects[1].id,
    );

    await store.getState().addProject("/repos/alpha/"); // duplicate, slash variant
    const s = store.getState();
    expect(s.projects).toHaveLength(2);
    expect(s.activeProjectId).toBe(s.projects[0].id); // selected the existing one
    expect(opens).toHaveLength(2); // no third terminal spawned
  });

  it("preserves Windows paths and deduplicates drive paths case-insensitively", async () => {
    const { store, opens } = makeStore();
    await store.getState().addProject("C:\\Users\\Keith\\Code\\Kodade\\");
    await store.getState().addProject("c:\\users\\keith\\code\\kodade");

    expect(store.getState().projects).toEqual([
      expect.objectContaining({
        name: "Kodade",
        path: "C:\\Users\\Keith\\Code\\Kodade",
      }),
    ]);
    expect(opens).toHaveLength(1);
    expect(opens[0].cwd).toBe("C:\\Users\\Keith\\Code\\Kodade");
  });

  it("persists and hydrates the project list across a restart", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().addProject("/repos/alpha");
    await first.store.getState().addProject("/repos/beta");

    // Persisted doc has the versioned schema.
    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.version).toBe(STORAGE_VERSION);
    expect(doc.projects.map((p) => p.path)).toEqual([
      "/repos/alpha",
      "/repos/beta",
    ]);
    expect(doc.activeProjectId).toBe(first.store.getState().projects[1].id);

    // "Restart": a fresh store hydrating from the same storage.
    const second = makeStore(storage);
    await second.store.getState().hydrate();
    const s = second.store.getState();
    expect(s.projects.map((p) => p.path)).toEqual([
      "/repos/alpha",
      "/repos/beta",
    ]);
    expect(s.activeProjectId).toBe(doc.activeProjectId);
    // Landing in the active project auto-opens a terminal at its root.
    expect(second.opens).toHaveLength(1);
    expect(second.opens[0].cwd).toBe("/repos/beta");
  });

  it("persists validated KödLocal saved endpoints in the versioned settings document", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().hydrate();
    await first.store.getState().addProject("/repos/endpoint-test");
    first.store.getState().setLocalModelPreferences({
      downloadedModelIds: [],
      customModels: [],
      contextLength: 4096,
      savedEndpoints: [
        {
          id: "studio",
          label: "Studio Mac",
          baseURL: "https://studio.example.test/v1",
          notes: "LAN GPU",
        },
      ],
    });
    await first.store.getState().flushPersistence();

    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      version: STORAGE_VERSION,
      local: {
        savedEndpoints: [
          {
            id: "studio",
            label: "Studio Mac",
            baseURL: "https://studio.example.test/v1",
            notes: "LAN GPU",
          },
        ],
      },
    });

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(
      second.store.getState().localModelPreferences.savedEndpoints,
    ).toEqual([
      {
        id: "studio",
        label: "Studio Mac",
        baseURL: "https://studio.example.test/v1",
        notes: "LAN GPU",
      },
    ]);
  });

  it("persists one-time KödMem agent reconciliation consent across a restart", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().hydrate();
    first.store.getState().setMemoryAgentAccess({
      enabled: true,
      access: "read-only",
    });
    await first.store.getState().flushPersistence();

    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      version: STORAGE_VERSION,
      memoryAgentAccess: {
        enabled: true,
        access: "read-only",
      },
    });

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().memoryAgentAccess).toEqual({
      enabled: true,
      access: "read-only",
    });
  });

  // Ködade's background prompt (#63). The default text lives in code, so a
  // first-run document must carry neither an override nor a disable flag.
  it("defaults the background prompt to on with no override", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().hydrate();
    expect(first.store.getState().ambientPromptEnabled).toBe(true);
    expect(first.store.getState().ambientPromptOverride).toBeNull();

    await first.store.getState().addProject("/repos/ambient");
    await first.store.getState().flushPersistence();
    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.ambientPromptEnabled).toBe(true);
    expect(doc.ambientPromptOverride).toBeUndefined();
  });

  it("persists a background-prompt override and the off switch across a restart", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().hydrate();
    first.store.getState().setAmbientPromptOverride("  Only speak in haiku.  ");
    first.store.getState().setAmbientPromptEnabled(false);
    await first.store.getState().flushPersistence();

    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      version: STORAGE_VERSION,
      ambientPromptEnabled: false,
      ambientPromptOverride: "Only speak in haiku.", // trimmed
    });

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().ambientPromptEnabled).toBe(false);
    expect(second.store.getState().ambientPromptOverride).toBe(
      "Only speak in haiku.",
    );
  });

  it("resetting the override drops it from the document", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().hydrate();
    first.store.getState().setAmbientPromptOverride("Only speak in haiku.");
    first.store.getState().setAmbientPromptOverride("   ");
    await first.store.getState().flushPersistence();

    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.ambientPromptOverride).toBeUndefined();
    expect(first.store.getState().ambientPromptOverride).toBeNull();
  });

  it("caps a pasted background prompt and tolerates a malformed one", async () => {
    const storage = new MockStorage();
    const store = makeStore(storage).store;
    await store.getState().hydrate();
    store.getState().setAmbientPromptOverride("x".repeat(9_000));
    expect(store.getState().ambientPromptOverride).toHaveLength(4_000);

    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      ambientPromptOverride: 42,
    });
    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().ambientPromptOverride).toBeNull();
    expect(second.store.getState().ambientPromptEnabled).toBe(true);
  });

  it("persists the sidebar rail mode across a restart", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    first.store.getState().setSidebarMode("rail");
    await first.store.getState().flushPersistence();

    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      sidebarMode: "rail",
    });

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().sidebarMode).toBe("rail");
  });

  it("holds an early sidebar toggle until hydration preserves saved projects", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "p-saved", name: "saved", path: "/repos/saved" }],
      activeProjectId: "p-saved",
      sidebarMode: "full",
    } satisfies PersistedDoc);
    const { store } = makeStore(storage, undefined, false);

    // The shortcut can run during startup before initApp() gets to hydrate().
    // Its persist must wait instead of overwriting this saved document.
    store.getState().setSidebarMode("rail");
    await store.getState().hydrate();
    await store.getState().flushPersistence();

    expect(store.getState().projects).toMatchObject([
      { id: "p-saved", path: "/repos/saved" },
    ]);
    expect(store.getState().sidebarMode).toBe("rail");
    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      projects: [{ id: "p-saved", path: "/repos/saved" }],
      sidebarMode: "rail",
    });
  });

  it("persists the files pane collapse across a restart", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    first.store.getState().toggleFilesPanel();
    await first.store.getState().flushPersistence();

    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      filesCollapsed: true,
    });

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().filesCollapsed).toBe(true);

    // Toggling back persists the expanded state too.
    second.store.getState().toggleFilesPanel();
    await second.store.getState().flushPersistence();
    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      filesCollapsed: false,
    });
  });

  it("hydrate ignores a non-boolean files pane collapse value", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      filesCollapsed: "yes",
    });

    const { store } = makeStore(storage);
    await store.getState().hydrate();
    expect(store.getState().filesCollapsed).toBe(false);
  });

  it("hydrate ignores an invalid sidebar mode", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      sidebarMode: "collapsed",
    });

    const { store } = makeStore(storage);
    await store.getState().hydrate();
    expect(store.getState().sidebarMode).toBe("full");
  });

  it("hydrate tolerates a corrupt document and starts fresh", async () => {
    const storage = new MockStorage();
    storage.doc = "{not json";
    const { store } = makeStore(storage);
    await store.getState().hydrate();
    expect(store.getState().projects).toEqual([]);
  });

  it("switching projects never closes background sessions", async () => {
    const { store, closes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta");

    const [alpha, beta] = store.getState().projects;
    await store.getState().setActiveProject(alpha.id);
    await store.getState().setActiveProject(beta.id);
    await store.getState().setActiveProject(alpha.id);

    expect(closes).toEqual([]); // nothing was killed by navigation
    expect(store.getState().sessions).toHaveLength(2); // both shells still listed
  });

  it("session names count up per project (max suffix + 1)", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];

    store.getState().addSession(alpha.id);
    store.getState().addSession(alpha.id);
    const names = store.getState().sessions.map((s) => s.name);
    expect(names).toEqual(["zsh 1", "zsh 2", "zsh 3"]);

    // Closing "zsh 1" must not recycle a live name: next is 4, not 1.
    await store.getState().closeSession(store.getState().sessions[0].id);
    store.getState().addSession(alpha.id);
    expect(store.getState().sessions.map((s) => s.name)).toEqual([
      "zsh 2",
      "zsh 3",
      "zsh 4",
    ]);
  });

  it("adds split terminals to the current workspace and closes them together", async () => {
    const { store, closes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const project = store.getState().projects[0];
    const workspace = store.getState().sessions[0];

    const splitId = store.getState().addTerminal(project.id, workspace.id);

    expect(splitId).toBeTruthy();
    expect(store.getState().sessions[0].workspaceId).toBeUndefined();
    expect(store.getState().sessions[1]).toMatchObject({
      id: splitId,
      workspaceId: workspace.id,
    });

    await store.getState().closeWorkspace(workspace.id);
    expect(store.getState().sessions).toEqual([]);
    expect(closes).toEqual([workspace.id, splitId]);
  });

  it("promotes a split sibling when the workspace's original terminal closes", async () => {
    const { store, closes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const project = store.getState().projects[0];
    const original = store.getState().sessions[0];
    const promotedId = store.getState().addTerminal(project.id, original.id)!;
    const siblingId = store.getState().addTerminal(project.id, original.id)!;

    await store.getState().closeSession(original.id);

    expect(store.getState().sessions).toEqual([
      expect.objectContaining({ id: promotedId, workspaceId: undefined }),
      expect.objectContaining({ id: siblingId, workspaceId: promotedId }),
    ]);
    await store.getState().closeWorkspace(promotedId);
    expect(store.getState().sessions).toEqual([]);
    expect(closes).toEqual([original.id, promotedId, siblingId]);
  });

  it("closeSession kills via the registry exactly once, even when double-closed", async () => {
    const { store, closes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const sessionId = store.getState().sessions[0].id;

    await store.getState().closeSession(sessionId);
    await store.getState().closeSession(sessionId); // stale double-click
    expect(closes).toEqual([sessionId]);
    expect(store.getState().sessions).toEqual([]);
  });

  it("closing the active session activates the project's remaining session", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];
    store.getState().addSession(alpha.id); // "zsh 2", now active

    const [first, second] = store.getState().sessions;
    expect(store.getState().activeSessionByProject[alpha.id]).toBe(second.id);

    await store.getState().closeSession(second.id);
    expect(store.getState().activeSessionByProject[alpha.id]).toBe(first.id);
  });

  it("removeProject closes its sessions, persists, and leaves other projects alone", async () => {
    const { store, storage, closes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta");
    const [alpha, beta] = store.getState().projects;
    store.getState().addSession(beta.id); // beta has two sessions

    const betaSessions = store
      .getState()
      .sessions.filter((s) => s.projectId === beta.id)
      .map((s) => s.id);

    await store.getState().removeProject(beta.id);
    const s = store.getState();
    expect(s.projects.map((p) => p.id)).toEqual([alpha.id]);
    expect(closes.sort()).toEqual(betaSessions.sort()); // beta's shells killed
    expect(s.sessions.every((x) => x.projectId === alpha.id)).toBe(true); // alpha untouched
    expect(s.activeProjectId).toBe(alpha.id); // fell back to remaining project

    // Removal is persisted; the doc never mentions beta again.
    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.projects.map((p) => p.path)).toEqual(["/repos/alpha"]);
  });

  it("a project added while hydrate awaits storage survives hydration", async () => {
    // Storage whose read resolves only when released — models a slow disk
    // losing the race against a fast user click on "+ Add project".
    let release!: (raw: string) => void;
    const writes: string[] = [];
    const slowStorage = {
      read: () => new Promise<string>((r) => (release = r)),
      write: async (contents: string) => void writes.push(contents),
      // Named side documents (KödChat transcripts) are irrelevant here.
      readDoc: async () => null,
      writeDoc: async () => undefined,
      deleteDoc: async () => undefined,
    };
    const { registry } = fakeRegistry();
    const store = createProjectsStore({
      storage: slowStorage,
      registry,
      newId: idGen(),
    });

    const hydrating = store.getState().hydrate();
    // User beats the disk: the click lands while hydration is pending. The
    // mutation gate makes the add wait for hydration, then merge in — so we
    // must not await it before releasing the slow read (that would deadlock).
    const adding = store.getState().addProject("/repos/fresh");
    release(
      JSON.stringify({
        version: STORAGE_VERSION,
        projects: [{ id: "p-old", name: "old", path: "/repos/old" }],
        activeProjectId: "p-old",
      } satisfies PersistedDoc),
    );
    await hydrating;
    await adding;

    const s = store.getState();
    // Both projects present; the user's fresh add was not clobbered...
    expect(s.projects.map((p) => p.path).sort()).toEqual([
      "/repos/fresh",
      "/repos/old",
    ]);
    // ...it stays active (outranks the stale doc)...
    expect(s.activeProjectId).toBe(
      s.projects.find((p) => p.path === "/repos/fresh")!.id,
    );
    // ...and the merged list was folded back onto disk.
    const lastWrite = JSON.parse(writes.at(-1)!) as PersistedDoc;
    expect(lastWrite.projects.map((p) => p.path).sort()).toEqual([
      "/repos/fresh",
      "/repos/old",
    ]);
  });

  it("hydrate skips malformed project entries instead of aborting", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        null,
        { id: "p1", name: "alpha", path: "/repos/alpha" },
        { id: 42, name: true },
      ],
      activeProjectId: "p1",
    });
    const { store } = makeStore(storage);
    await store.getState().hydrate(); // must not throw
    const s = store.getState();
    expect(s.projects.map((p) => p.path)).toEqual(["/repos/alpha"]);
    expect(s.activeProjectId).toBe("p1");
  });

  it("setShellBase changes default session names", async () => {
    const { store } = makeStore();
    store.getState().setShellBase("fish");
    await store.getState().addProject("/repos/alpha");
    expect(store.getState().sessions[0].name).toBe("fish 1");
  });

  it("a project added during an in-flight hydration survives it", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "old", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "old",
    });
    storage.deferRead = true;
    const { store } = makeStore(storage);

    const hydrateP = store.getState().hydrate(); // disk read pending
    const addP = store.getState().addProject("/repos/fresh"); // user acts NOW

    storage.resolveRead(); // hydration lands after the user's click
    await hydrateP;
    await addP;

    const s = store.getState();
    expect(s.projects.map((p) => p.path).sort()).toEqual([
      "/repos/alpha",
      "/repos/fresh",
    ]); // neither the persisted nor the fresh project was lost
    expect(s.projects.find((p) => p.path === "/repos/fresh")).toBeTruthy();
    expect(s.activeProjectId).toBe(
      s.projects.find((p) => p.path === "/repos/fresh")!.id,
    ); // the user's selection wins over the persisted one
  });

  it("hydrate skips invalid project entries instead of aborting", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        null,
        { id: "ok", name: "alpha", path: "/repos/alpha" },
        { id: 42, name: "bad-id", path: "/repos/bad" },
        { id: "no-path", name: "beta" },
      ],
      activeProjectId: "ok",
    });
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    const s = store.getState();
    expect(s.projects.map((p) => p.id)).toEqual(["ok"]); // valid subset only
    expect(s.activeProjectId).toBe("ok");
  });

  it("setProjectColor persists a picked color and restores it after restart", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().addProject("/repos/alpha");
    const alpha = first.store.getState().projects[0];

    first.store.getState().setProjectColor(alpha.id, "teal");
    await first.store.getState().flushPersistence();
    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      projects: [{ id: alpha.id, color: "teal" }],
    });

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().projects[0].color).toBe("teal");
  });

  it("setProjectColor null clears a picked color back to auto", async () => {
    const { store, storage } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];

    store.getState().setProjectColor(alpha.id, "teal");
    store.getState().setProjectColor(alpha.id, null);
    await store.getState().flushPersistence();

    expect(store.getState().projects[0].color).toBeUndefined();
    expect(
      (JSON.parse(storage.doc!) as PersistedDoc).projects[0].color,
    ).toBeUndefined();
  });

  it("hydrate drops an unknown project color without dropping its project", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        { id: "p1", name: "alpha", path: "/repos/alpha", color: "neon" },
      ],
      activeProjectId: "p1",
    });
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().projects).toEqual([
      { id: "p1", name: "alpha", path: "/repos/alpha" },
    ]);
  });

  it("hydrate migrates the retired violet project color to copper", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        { id: "p1", name: "alpha", path: "/repos/alpha", color: "violet" },
      ],
      activeProjectId: "p1",
    });
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().projects[0].color).toBe("copper");
  });

  it("dedupes projects on the canonical path", async () => {
    const canon = (p: string) =>
      Promise.resolve(p.startsWith("/tmp/") ? `/private${p}` : p);
    const { store, opens } = makeStore(new MockStorage(), canon);

    await store.getState().addProject("/tmp/proj");
    await store.getState().addProject("/private/tmp/proj"); // same real folder

    const s = store.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].path).toBe("/private/tmp/proj"); // canonical form stored
    expect(opens).toHaveLength(1); // second add selected, didn't spawn
  });

  it("markSessionExited flags the session and leaves the rest alone", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];
    store.getState().addSession(alpha.id);
    const [first, second] = store.getState().sessions;

    store.getState().markSessionExited(first.id);
    const s = store.getState();
    expect(s.sessions.find((x) => x.id === first.id)?.exited).toBe(true);
    expect(s.sessions.find((x) => x.id === second.id)?.exited).toBeUndefined();
  });

  // --- App-level layout persistence ---

  it("keeps the user's pane sizes when moving between projects", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta");
    const [, beta] = store.getState().projects;

    store.getState().setLayout([10, 50, 15, 25]);
    await store.getState().setActiveProject(beta.id);

    expect(store.getState().layout).toEqual([10, 50, 15, 25]);
  });

  it("setLayout stores app-level sizes and persists them (debounced)", async () => {
    vi.useFakeTimers();
    try {
      const { store, storage } = makeStore();
      await store.getState().addProject("/repos/alpha");

      store.getState().setLayout([10, 50, 15, 25]);
      expect(store.getState().layout).toEqual([10, 50, 15, 25]);

      // Nothing written to disk until the debounce elapses.
      const writesBefore = storage.writes;
      await vi.advanceTimersByTimeAsync(499);
      expect(storage.writes).toBe(writesBefore);
      await vi.advanceTimersByTimeAsync(1);
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.layout).toEqual([10, 50, 15, 25]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rapid layout changes collapse into a single debounced write", async () => {
    vi.useFakeTimers();
    try {
      const { store, storage } = makeStore();
      await store.getState().addProject("/repos/alpha");
      const writesBefore = storage.writes;

      // Many changes within the window (a drag) -> one write on pause.
      store.getState().setLayout([10, 50, 15, 25]);
      await vi.advanceTimersByTimeAsync(100);
      store.getState().setLayout([12, 48, 15, 25]);
      await vi.advanceTimersByTimeAsync(100);
      store.getState().setLayout([14, 46, 15, 25]);
      await vi.advanceTimersByTimeAsync(500);

      expect(storage.writes).toBe(writesBefore + 1);
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.layout).toEqual([14, 46, 15, 25]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setLayout ignores malformed sizes", () => {
    const { store } = makeStore();
    store.getState().setLayout([1, 2, 3]);
    expect(store.getState().layout).toBeUndefined();
  });

  it("the app-level layout survives a restart", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const first = makeStore(storage);
      await first.store.getState().addProject("/repos/alpha");
      first.store.getState().setLayout([10, 50, 15, 25]);
      await vi.advanceTimersByTimeAsync(500); // flush the debounced write
    } finally {
      vi.useRealTimers();
    }

    // "Restart": a fresh store hydrates the saved layout.
    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().layout).toEqual([10, 50, 15, 25]);
  });

  it("hydrates without a layout when the user has never resized panes", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().addProject("/repos/alpha"); // never resized

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().layout).toBeUndefined();
  });

  it("migrates the legacy active project's layout into the app-level preference", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        { id: "p1", name: "alpha", path: "/repos/alpha" },
        { id: "p2", name: "beta", path: "/repos/beta" },
      ],
      activeProjectId: "p1",
      layouts: {
        p1: [10, 50, 15, 25], // valid
        p2: "not an array", // malformed -> dropped
        p3: [1, 2, 3], // orphan (no such project) -> ignored
      },
    });
    const { store } = makeStore(storage);
    await store.getState().hydrate(); // must not throw
    expect(store.getState().layout).toEqual([10, 50, 15, 25]);
  });

  it("hydrate rejects an all-zero layout (crushed panes) as malformed", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "p1", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "p1",
      layouts: { p1: [0, 0, 0, 0] }, // sums to 0 -> every pane crushed
    });
    const { store } = makeStore(storage);
    await store.getState().hydrate();
    expect(store.getState().layout).toBeUndefined(); // dropped, defaults apply
  });

  it("overlapping persists land in call order (no stale write wins)", async () => {
    // Storage whose first write stalls until released — models the slow write
    // that would otherwise land after (and clobber) a newer one.
    const finished: string[] = [];
    let releaseFirst!: () => void;
    let call = 0;
    const gatedStorage = {
      read: async () => null,
      write: async (contents: string) => {
        call += 1;
        if (call === 1) {
          await new Promise<void>((r) => (releaseFirst = r));
          finished.push("first");
        } else {
          finished.push("second");
        }
        void contents;
      },
      readDoc: async () => null,
      writeDoc: async () => undefined,
      deleteDoc: async () => undefined,
    };
    const { registry } = fakeRegistry();
    const store = createProjectsStore({
      storage: gatedStorage,
      registry,
      newId: idGen(),
    });
    void store.getState().hydrate();

    const first = store.getState().addProject("/repos/alpha"); // write 1 (stalls)
    const second = store.getState().addProject("/repos/beta"); // write 2 (chained)
    // This deliberate scheduler window proves the second write cannot overtake
    // the blocked first write; ordinary persistence tests use flushPersistence.
    await new Promise((r) => setTimeout(r, 10));
    expect(finished).toEqual([]); // second waits on first — never overtakes
    releaseFirst();
    await Promise.all([first, second]);
    expect(finished).toEqual(["first", "second"]);
  });

  it("removing a project keeps the app-level pane layout", async () => {
    vi.useFakeTimers();
    const { store, storage } = makeStore();
    try {
      await store.getState().addProject("/repos/alpha");
      await store.getState().addProject("/repos/beta");
      store.getState().setLayout([20, 40, 20, 20]);
      vi.advanceTimersByTime(500);
    } finally {
      vi.useRealTimers();
    }

    const [, beta] = store.getState().projects;
    await store.getState().removeProject(beta.id);
    expect(store.getState().layout).toEqual([20, 40, 20, 20]);
    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.layout).toEqual([20, 40, 20, 20]);
  });

  it("addSession accepts a custom base name and counts it independently", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];

    // Provider-named sessions number per-base: "claude 1", "claude 2" — the
    // shell-named "zsh 1" doesn't bump the claude counter.
    store.getState().addSession(alpha.id, "claude");
    store.getState().addSession(alpha.id, "claude");
    const names = store.getState().sessions.map((s) => s.name);
    expect(names).toEqual(["zsh 1", "claude 1", "claude 2"]);
  });

  it("launchInSession opens a provider-named session and types the command", async () => {
    const { store, opens, writes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];

    await store.getState().launchInSession("claude", "claude");

    const s = store.getState();
    // A fresh session named after the provider is now active.
    const launched = s.sessions.at(-1)!;
    expect(launched.name).toBe("claude 1");
    expect(s.activeSessionByProject[alpha.id]).toBe(launched.id);
    // It opened at the project root and the command was typed with a return.
    expect(opens.at(-1)).toMatchObject({
      id: launched.id,
      cwd: "/repos/alpha",
    });
    expect(writes).toEqual([{ id: launched.id, data: "claude\r" }]);
  });

  it("emits metadata-only session lifecycle hooks", async () => {
    const storage = new MockStorage();
    const { registry } = fakeRegistry();
    const started = vi.fn();
    const exited = vi.fn();
    const store = createProjectsStore({
      storage,
      registry,
      newId: idGen(),
      onSessionStarted: started,
      onSessionExited: exited,
    });
    void store.getState().hydrate();
    await store.getState().addProject("/repos/alpha");
    await store.getState().launchInSession("claude --resume", "claude");
    const providerSession = store.getState().sessions.at(-1)!;
    store.getState().markSessionExited(providerSession.id);

    expect(started).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/repos/alpha" }),
      expect.objectContaining({ id: providerSession.id, name: "claude 1" }),
      "claude",
    );
    expect(exited).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/repos/alpha" }),
      expect.objectContaining({ id: providerSession.id }),
    );
    // The callback contract never includes the launched command or PTY data.
    expect(JSON.stringify(started.mock.calls)).not.toContain("--resume");
  });

  it("emits session exit metadata when removing a project with a live session", async () => {
    const storage = new MockStorage();
    const { registry } = fakeRegistry();
    const exited = vi.fn();
    const store = createProjectsStore({
      storage,
      registry,
      newId: idGen(),
      onSessionExited: exited,
    });
    void store.getState().hydrate();
    await store.getState().addProject("/repos/alpha");
    const project = store.getState().projects[0];
    const session = store.getState().sessions[0];

    await store.getState().removeProject(project.id);

    expect(exited).toHaveBeenCalledWith(project, session);
  });

  it("launchInSession reports when there is no active project", async () => {
    const { store, writes } = makeStore();
    await expect(
      store.getState().launchInSession("claude", "claude"),
    ).rejects.toThrow("open a project first");
    expect(writes).toEqual([]);
    expect(store.getState().sessions).toEqual([]);
  });

  // --- App-level theme persistence (M5) ---

  it("defaults theme to 'system' and persists a changed selection", async () => {
    const { store, storage } = makeStore();
    expect(store.getState().theme).toBe("system");

    store.getState().setTheme("dark");
    expect(store.getState().theme).toBe("dark");
    await store.getState().flushPersistence();
    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.theme).toBe("dark");
  });

  it("setTheme is a no-op for an unchanged or empty value", async () => {
    const { store, storage } = makeStore();
    store.getState().setTheme("system"); // same as default
    store.getState().setTheme(""); // empty ignored
    expect(store.getState().theme).toBe("system");
    expect(storage.doc).toBeNull(); // nothing persisted
  });

  it("theme survives a restart (round-trip through the persisted doc)", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    first.store.getState().setTheme("light");
    await first.store.getState().flushPersistence();

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().theme).toBe("light");
  });

  it("hydrate tolerates a missing or garbage theme field (keeps 'system')", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "p1", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "p1",
      theme: 42, // not a string -> ignored
    });
    const { store } = makeStore(storage);
    await store.getState().hydrate(); // must not throw
    expect(store.getState().theme).toBe("system");
  });

  it("persists KodWhisper's model choice and review setting across a restart", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    first.store.getState().setVoicePreferences({
      modelId: "small.en",
      installedModelIds: ["base.en", "small.en"],
      reviewBeforeInsert: false,
      reviewBeforeInsertConfigured: true,
      modelsDir: null,
      inputDeviceId: null,
      commandAutoConfirm: false,
      pushToTalkCombo: null,
      pushToTalkCommandCombo: null,
    });
    await first.store.getState().flushPersistence();

    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      voice: {
        modelId: "small.en",
        installedModelIds: ["base.en", "small.en"],
        reviewBeforeInsert: false,
      },
    });

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().voicePreferences).toEqual({
      modelId: "small.en",
      installedModelIds: ["base.en", "small.en"],
      reviewBeforeInsert: false,
      reviewBeforeInsertConfigured: true,
      modelsDir: null,
      inputDeviceId: null,
      commandAutoConfirm: false,
      pushToTalkCombo: null,
      pushToTalkCommandCombo: null,
    });
  });

  // Regression (M9f): sameVoicePreferences() must compare commandAutoConfirm,
  // or a change to ONLY that field (every other field left at its default)
  // is indistinguishable from a no-op and setVoicePreferences() bails out
  // before ever persisting it.
  it("persists a commandAutoConfirm-only change across a restart", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    const defaults = first.store.getState().voicePreferences;
    first.store.getState().setVoicePreferences({
      ...defaults,
      commandAutoConfirm: true,
    });
    await first.store.getState().flushPersistence();

    expect(first.store.getState().voicePreferences.commandAutoConfirm).toBe(
      true,
    );
    expect(JSON.parse(storage.doc!) as PersistedDoc).toMatchObject({
      voice: { commandAutoConfirm: true },
    });

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().voicePreferences.commandAutoConfirm).toBe(
      true,
    );
  });

  // --- Keyboard cycling (M6a) ---

  it("cycleSession moves through the active project's sessions and wraps", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];
    // addProject auto-opened session 1; add two more (each becomes active).
    store.getState().addSession(alpha.id);
    store.getState().addSession(alpha.id);
    const ids = store.getState().sessions.map((s) => s.id); // [s1, s2, s3]
    // Active is s3 (the last added). Next wraps to s1.
    store.getState().cycleSession(1);
    expect(store.getState().activeSessionByProject[alpha.id]).toBe(ids[0]);
    // Prev from s1 wraps back to s3.
    store.getState().cycleSession(-1);
    expect(store.getState().activeSessionByProject[alpha.id]).toBe(ids[2]);
    // Next steps s3 → s1 → s2.
    store.getState().cycleSession(1);
    store.getState().cycleSession(1);
    expect(store.getState().activeSessionByProject[alpha.id]).toBe(ids[1]);
  });

  it("cycleSession skips chat-owned terminals in the chat-first local runtime", async () => {
    const { store } = makeStore(
      new MockStorage(),
      undefined,
      true,
      { autoStartTerminal: false },
    );
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const firstChatId = store.getState().addChatThread(projectId, "claude")!;
    const terminalId = store.getState().addTerminal(projectId, firstChatId)!;
    const secondChatId = store.getState().addChatThread(projectId, "codex")!;

    store.getState().cycleSession(-1);
    expect(store.getState().activeSessionByProject[projectId]).toBe(firstChatId);
    store.getState().cycleSession(1);
    expect(store.getState().activeSessionByProject[projectId]).toBe(secondChatId);
    expect(store.getState().activeSessionByProject[projectId]).not.toBe(terminalId);
  });

  it("normalizes local chat-owned terminal selection back to its owning chat", async () => {
    const { store } = makeStore(
      new MockStorage(),
      undefined,
      true,
      { autoStartTerminal: false },
    );
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const chatId = store.getState().addChatThread(projectId, "claude")!;
    const terminalId = store.getState().addTerminal(projectId, chatId)!;

    store.getState().setActiveSession(projectId, terminalId);
    expect(store.getState().activeSessionByProject[projectId]).toBe(chatId);

    await store.getState().activateSession(projectId, terminalId);
    expect(store.getState().activeSessionByProject[projectId]).toBe(chatId);
  });

  it("rejects unowned local terminals in the chat-first runtime", async () => {
    const { store, opens } = makeStore(
      new MockStorage(),
      undefined,
      true,
      { autoStartTerminal: false },
    );
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;

    expect(store.getState().addSession(projectId)).toBeNull();
    expect(store.getState().sessions).toEqual([]);
    expect(opens).toEqual([]);
  });

  it("preserves terminal cycling for pinned remote projects", async () => {
    const { store } = makeStore(
      new MockStorage(),
      undefined,
      true,
      { autoStartTerminal: false },
    );
    const target = { host: "box", path: "/srv/app" };
    const projectId = remoteProjectId(target);
    store.getState().pinRemoteTarget(target);
    await store.getState().setActiveProject(projectId);
    const firstTerminalId = store.getState().addSession(projectId)!;
    const secondTerminalId = store.getState().addSession(projectId)!;

    store.getState().cycleSession(1);
    expect(store.getState().activeSessionByProject[projectId]).toBe(firstTerminalId);
    store.getState().cycleSession(-1);
    expect(store.getState().activeSessionByProject[projectId]).toBe(secondTerminalId);
  });

  it("cycleSession is a no-op with fewer than two sessions or no active project", async () => {
    const { store } = makeStore();
    // No active project.
    store.getState().cycleSession(1);
    expect(store.getState().activeProjectId).toBe(null);
    // One session only.
    await store.getState().addProject("/repos/alpha");
    const before =
      store.getState().activeSessionByProject[store.getState().projects[0].id];
    store.getState().cycleSession(1);
    expect(
      store.getState().activeSessionByProject[store.getState().projects[0].id],
    ).toBe(before);
  });

  it("cycleProject switches the active project and wraps", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta");
    await store.getState().addProject("/repos/gamma");
    const [a, b, g] = store.getState().projects; // active is gamma (last added)
    expect(store.getState().activeProjectId).toBe(g.id);
    // Next wraps gamma → alpha.
    await store.getState().cycleProject(1);
    expect(store.getState().activeProjectId).toBe(a.id);
    // Prev wraps alpha → gamma.
    await store.getState().cycleProject(-1);
    expect(store.getState().activeProjectId).toBe(g.id);
    // Next twice: gamma → alpha → beta.
    await store.getState().cycleProject(1);
    await store.getState().cycleProject(1);
    expect(store.getState().activeProjectId).toBe(b.id);
  });

  it("cycleProject is a no-op with fewer than two projects", async () => {
    const { store } = makeStore();
    await store.getState().cycleProject(1); // none
    expect(store.getState().activeProjectId).toBe(null);
    await store.getState().addProject("/repos/alpha");
    const before = store.getState().activeProjectId;
    await store.getState().cycleProject(1); // only one
    expect(store.getState().activeProjectId).toBe(before);
  });

  it("cycleProject includes pinned remote projects after local projects", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const localId = store.getState().projects[0].id;
    const target = { host: "box", path: "/srv/app" };
    const remoteId = remoteProjectId(target);
    store.getState().pinRemoteTarget(target);

    await store.getState().cycleProject(1);
    expect(store.getState().activeProjectId).toBe(remoteId);
    await store.getState().cycleProject(1);
    expect(store.getState().activeProjectId).toBe(localId);
  });
});

// --- Per-project open-tab persistence (v1.1) ---
describe("open-tab persistence", () => {
  it("setOpenTabs stores tabs per project and persists them (debounced)", async () => {
    vi.useFakeTimers();
    try {
      const { store, storage } = makeStore();
      await store.getState().addProject("/repos/alpha");
      const alpha = store.getState().projects[0];

      store
        .getState()
        .setOpenTabs(alpha.id, ["/repos/alpha/a.ts", "/repos/alpha/b.ts"]);
      expect(store.getState().openTabs[alpha.id]).toEqual([
        "/repos/alpha/a.ts",
        "/repos/alpha/b.ts",
      ]);

      const writesBefore = storage.writes;
      await vi.advanceTimersByTimeAsync(499);
      expect(storage.writes).toBe(writesBefore); // debounced, not yet written
      await vi.advanceTimersByTimeAsync(1);
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.openTabs?.[alpha.id]).toEqual([
        "/repos/alpha/a.ts",
        "/repos/alpha/b.ts",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setOpenTabs ignores unknown projects and malformed paths", () => {
    const { store } = makeStore();
    store.getState().setOpenTabs("nope", ["/x"]); // no such project
    expect(store.getState().openTabs).toEqual({});
  });

  it("tabs survive a restart and restore only for surviving projects", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const first = makeStore(storage);
      await first.store.getState().addProject("/repos/alpha");
      const alpha = first.store.getState().projects[0];
      first.store.getState().setOpenTabs(alpha.id, ["/repos/alpha/a.ts"]);
      await vi.advanceTimersByTimeAsync(500); // flush debounced write
    } finally {
      vi.useRealTimers();
    }

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    const s = second.store.getState();
    const alpha = s.projects.find((p) => p.path === "/repos/alpha")!;
    expect(s.openTabs[alpha.id]).toEqual(["/repos/alpha/a.ts"]);
  });

  it("hydrate tolerates a malformed openTabs field and drops bad entries", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        { id: "p1", name: "alpha", path: "/repos/alpha" },
        { id: "p2", name: "beta", path: "/repos/beta" },
      ],
      activeProjectId: "p1",
      openTabs: {
        p1: ["/repos/alpha/a.ts"], // valid
        p2: "not an array", // malformed -> dropped
        p3: ["/orphan"], // no such project -> ignored
        p4: [123, "/x"], // non-string member -> whole entry dropped
      },
    });
    const { store } = makeStore(storage);
    await store.getState().hydrate(); // must not throw
    expect(store.getState().openTabs).toEqual({ p1: ["/repos/alpha/a.ts"] });
  });

  it("removeProject drops the removed project's saved tabs", async () => {
    vi.useFakeTimers();
    try {
      const { store, storage } = makeStore();
      await store.getState().addProject("/repos/alpha");
      await store.getState().addProject("/repos/beta");
      const [alpha, beta] = store.getState().projects;
      store.getState().setOpenTabs(alpha.id, ["/repos/alpha/a.ts"]);
      store.getState().setOpenTabs(beta.id, ["/repos/beta/b.ts"]);
      await vi.advanceTimersByTimeAsync(500);

      await store.getState().removeProject(beta.id);
      expect(store.getState().openTabs[beta.id]).toBeUndefined();
      expect(store.getState().openTabs[alpha.id]).toEqual([
        "/repos/alpha/a.ts",
      ]);
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.openTabs?.[beta.id]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removeProject notifies onProjectRemoved with the removed project's path", async () => {
    const { registry } = fakeRegistry();
    const removed: string[] = [];
    const store = createProjectsStore({
      storage: new MockStorage(),
      registry,
      newId: idGen(),
      onProjectRemoved: (path) => removed.push(path),
    });
    void store.getState().hydrate();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta");
    const [, beta] = store.getState().projects;

    await store.getState().removeProject(beta.id);
    expect(removed).toEqual(["/repos/beta"]); // the files store prunes this root's tabs

    // Removing an unknown id is a no-op — no spurious notification.
    await store.getState().removeProject("nope");
    expect(removed).toEqual(["/repos/beta"]);
  });
});

// --- KödPR reviewed-checkmarks persistence (M12d) ---
describe("review-checkmarks persistence", () => {
  it("setReviewChecks stores paths per project path + scope key and persists them (debounced)", async () => {
    vi.useFakeTimers();
    try {
      const { store, storage } = makeStore();
      await store.getState().addProject("/repos/alpha");

      store
        .getState()
        .setReviewChecks("/repos/alpha", "worktree", ["a.ts", "b.ts"]);
      expect(
        store.getState().reviewChecks["/repos/alpha"]?.worktree.paths,
      ).toEqual(["a.ts", "b.ts"]);

      const writesBefore = storage.writes;
      await vi.advanceTimersByTimeAsync(499);
      expect(storage.writes).toBe(writesBefore); // debounced, not yet written
      await vi.advanceTimersByTimeAsync(1);
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.reviewChecks?.["/repos/alpha"]?.worktree.paths).toEqual([
        "a.ts",
        "b.ts",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setReviewChecks ignores unknown project paths and malformed paths", () => {
    const { store } = makeStore();
    store.getState().setReviewChecks("/nope", "worktree", ["/x"]); // no such project
    expect(store.getState().reviewChecks).toEqual({});
  });

  it("keeps distinct scopes (worktree vs branch identity) as separate entries for one project", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");

    store.getState().setReviewChecks("/repos/alpha", "worktree", ["a.ts"]);
    store
      .getState()
      .setReviewChecks("/repos/alpha", "branch:feature/x:main", ["b.ts"]);

    const scopes = store.getState().reviewChecks["/repos/alpha"];
    expect(scopes.worktree.paths).toEqual(["a.ts"]);
    expect(scopes["branch:feature/x:main"].paths).toEqual(["b.ts"]);
  });

  it("caps a project's scopes to MAX_REVIEW_SCOPES_PER_PROJECT, evicting the oldest-updated first", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");

    // 21 distinct branch scopes; the cap is 20 — the first write should be evicted.
    for (let i = 0; i < 21; i++) {
      store
        .getState()
        .setReviewChecks("/repos/alpha", `branch:b${i}:main`, [`f${i}.ts`]);
    }
    const scopes = store.getState().reviewChecks["/repos/alpha"];
    expect(Object.keys(scopes)).toHaveLength(20);
    expect(scopes["branch:b0:main"]).toBeUndefined(); // oldest, evicted
    expect(scopes["branch:b20:main"]).toBeDefined(); // newest, survives
  });

  it("reviewChecks survive a restart and restore only for surviving projects (keyed by path)", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const first = makeStore(storage);
      await first.store.getState().addProject("/repos/alpha");
      first.store
        .getState()
        .setReviewChecks("/repos/alpha", "worktree", ["a.ts"]);
      await vi.advanceTimersByTimeAsync(500); // flush debounced write
    } finally {
      vi.useRealTimers();
    }

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    const s = second.store.getState();
    expect(s.reviewChecks["/repos/alpha"]?.worktree.paths).toEqual(["a.ts"]);
  });

  it("hydrate tolerates a malformed reviewChecks field and drops bad entries", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        { id: "p1", name: "alpha", path: "/repos/alpha" },
        { id: "p2", name: "beta", path: "/repos/beta" },
      ],
      activeProjectId: "p1",
      reviewChecks: {
        "/repos/alpha": {
          worktree: { paths: ["a.ts"], updatedAt: 1 }, // valid
          bad1: { paths: "not an array", updatedAt: 1 }, // malformed paths -> dropped
          bad2: { paths: ["a.ts"], updatedAt: "not a number" }, // malformed timestamp -> dropped
        },
        "/orphan/path": { worktree: { paths: ["x.ts"], updatedAt: 1 } }, // no such project -> ignored
      },
    });
    const { store } = makeStore(storage);
    await store.getState().hydrate(); // must not throw
    expect(store.getState().reviewChecks).toEqual({
      "/repos/alpha": { worktree: { paths: ["a.ts"], updatedAt: 1 } },
    });
  });

  it("removeProject drops the removed project's reviewed checkmarks (keyed by path)", async () => {
    vi.useFakeTimers();
    try {
      const { store, storage } = makeStore();
      await store.getState().addProject("/repos/alpha");
      await store.getState().addProject("/repos/beta");
      const [alpha, beta] = store.getState().projects;
      store.getState().setReviewChecks("/repos/alpha", "worktree", ["a.ts"]);
      store.getState().setReviewChecks("/repos/beta", "worktree", ["b.ts"]);
      await vi.advanceTimersByTimeAsync(500);

      await store.getState().removeProject(beta.id);
      expect(store.getState().reviewChecks["/repos/beta"]).toBeUndefined();
      expect(
        store.getState().reviewChecks["/repos/alpha"]?.worktree.paths,
      ).toEqual(["a.ts"]);
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.reviewChecks?.["/repos/beta"]).toBeUndefined();
      void alpha;
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- v1.1 session QoL: inline rename, foreground auto-naming, collapse ---

import { MockForeground } from "../ipc/mock";
import { sessionDisplayName } from "./projects";

// Store wired with a foreground mock (and identity timers/visibility unless a
// test overrides them). shellBase defaults to "zsh" as in the app.
function makeQolStore(
  over?: Partial<Parameters<typeof createProjectsStore>[0]>,
) {
  const { opens, closes, writes, registry } = fakeRegistry();
  const foreground = new MockForeground();
  const store = createProjectsStore({
    storage: new MockStorage(),
    registry,
    newId: idGen(),
    foreground,
    ...over,
  });
  void store.getState().hydrate();
  return { store, foreground, opens, closes, writes };
}

// The session in the given project (first by default).
function sessionOf(store: ReturnType<typeof makeQolStore>["store"], i = 0) {
  return store.getState().sessions[i];
}

describe("session inline rename", () => {
  it("renames and locks the name so auto-naming can never overwrite it", async () => {
    const { store, foreground } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    const s = sessionOf(store);
    expect(s.name).toBe("zsh 1");

    store.getState().renameSession(s.id, "  build  "); // trims
    const renamed = sessionOf(store);
    expect(renamed.name).toBe("build");
    expect(renamed.nameLocked).toBe(true);
    expect(sessionDisplayName(renamed)).toBe("build");

    // Auto-naming must NEVER touch a locked session, even with a live foreground.
    foreground.names.set(s.id, "claude");
    await store.getState().pollForeground();
    const after = sessionOf(store);
    expect(after.autoName).toBeUndefined();
    expect(sessionDisplayName(after)).toBe("build"); // manual name wins, forever
  });

  it("empty/whitespace rename reverts (no-op, no lock)", async () => {
    const { store } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    const s = sessionOf(store);
    store.getState().renameSession(s.id, "   ");
    const after = sessionOf(store);
    expect(after.name).toBe("zsh 1");
    expect(after.nameLocked).toBeUndefined();
  });

  it("a manual rename drops any auto-name in effect", async () => {
    const { store, foreground } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    const s = sessionOf(store);
    foreground.names.set(s.id, "claude");
    await store.getState().pollForeground();
    expect(sessionDisplayName(sessionOf(store))).toBe("claude");

    store.getState().renameSession(s.id, "agent");
    const after = sessionOf(store);
    expect(after.autoName).toBeUndefined();
    expect(sessionDisplayName(after)).toBe("agent");
  });
});

describe("foreground auto-naming", () => {
  it("sets an auto-name when a command runs, then reverts when the shell returns", async () => {
    const { store, foreground } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    const s = sessionOf(store);

    // Idle shell → no auto-name (base name shows).
    foreground.names.set(s.id, "zsh");
    await store.getState().pollForeground();
    expect(sessionOf(store).autoName).toBeUndefined();
    expect(sessionDisplayName(sessionOf(store))).toBe("zsh 1");

    // Command runs → auto-name appears.
    foreground.names.set(s.id, "claude");
    await store.getState().pollForeground();
    expect(sessionOf(store).autoName).toBe("claude");
    expect(sessionDisplayName(sessionOf(store))).toBe("claude");

    // Command exits back to the shell → auto-name clears (revert cycle).
    foreground.names.set(s.id, "zsh");
    await store.getState().pollForeground();
    expect(sessionOf(store).autoName).toBeUndefined();
    expect(sessionDisplayName(sessionOf(store))).toBe("zsh 1");
  });

  it("treats a null/unresolved foreground as idle", async () => {
    const { store, foreground } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    const s = sessionOf(store);
    foreground.names.set(s.id, "vitest");
    await store.getState().pollForeground();
    expect(sessionOf(store).autoName).toBe("vitest");

    foreground.names.set(s.id, null); // lookup failed / process gone
    await store.getState().pollForeground();
    expect(sessionOf(store).autoName).toBeUndefined();
  });

  it("polls visible sessions: active + expanded projects, never collapsed ones", async () => {
    const { store, foreground } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    const alphaSession = sessionOf(store);
    const alpha = store.getState().projects[0];
    await store.getState().addProject("/repos/beta"); // beta is now active
    const betaSession = store
      .getState()
      .sessions.find((x) => x.id !== alphaSession.id)!;

    // Alpha stayed expanded from when it was active (multi-expand) — its
    // sessions are on screen, so they poll too.
    await store.getState().pollForeground();
    expect(foreground.queries).toContain(betaSession.id);
    expect(foreground.queries).toContain(alphaSession.id);

    // Collapse alpha: its sessions leave the screen and leave the poll set.
    foreground.queries.length = 0;
    store.getState().toggleProjectExpanded(alpha.id);
    await store.getState().pollForeground();
    expect(foreground.queries).toContain(betaSession.id);
    expect(foreground.queries).not.toContain(alphaSession.id);
  });

  it("a late lookup never restores an auto-name on a session exited mid-flight", async () => {
    // Gated foreground: the lookup hangs until released, so we can flip the
    // session to exited AFTER the poll starts but BEFORE its result applies.
    let release!: (name: string | null) => void;
    const queries: string[] = [];
    const gatedForeground = {
      foreground: (id: string) => {
        queries.push(id);
        return new Promise<string | null>((r) => (release = r));
      },
    };
    const { store } = makeQolStore({ foreground: gatedForeground });
    await store.getState().addProject("/repos/alpha");
    const s = sessionOf(store);

    const polling = store.getState().pollForeground(); // lookup in flight (gated)
    expect(queries).toContain(s.id);
    // Shell dies while the lookup is outstanding.
    store.getState().markSessionExited(s.id);
    expect(sessionOf(store).exited).toBe(true);
    // The late result lands "claude" — it must NOT resurrect an auto-name.
    release("claude");
    await polling;

    const after = sessionOf(store);
    expect(after.exited).toBe(true);
    expect(after.autoName).toBeUndefined();
    expect(sessionDisplayName(after)).toBe("zsh 1");
  });

  it("an older delayed poll cycle can't overwrite a newer cycle's result", async () => {
    // Two gated lookups queued in order; we resolve the NEWER cycle first, then
    // the OLDER one. The stale older batch must be dropped (ordering token).
    const releasers: ((name: string | null) => void)[] = [];
    const gatedForeground = {
      foreground: () => new Promise<string | null>((r) => releasers.push(r)),
    };
    const { store } = makeQolStore({ foreground: gatedForeground });
    await store.getState().addProject("/repos/alpha");

    const older = store.getState().pollForeground(); // cycle 1 (gated)
    const newer = store.getState().pollForeground(); // cycle 2 (gated)
    expect(releasers).toHaveLength(2);

    // Newer cycle lands first with the real answer, then the older cycle lands
    // late with a stale answer that must be ignored.
    releasers[1]("claude"); // cycle 2 → claude
    await newer;
    expect(sessionOf(store).autoName).toBe("claude");

    releasers[0]("vitest"); // cycle 1 (older) lands late → dropped
    await older;
    expect(sessionOf(store).autoName).toBe("claude"); // newer result stands
  });

  it("skips exited sessions and does not poll them", async () => {
    const { store, foreground } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    const s = sessionOf(store);
    store.getState().markSessionExited(s.id);
    await store.getState().pollForeground();
    expect(foreground.queries).not.toContain(s.id);
  });

  it("does not poll when the window is hidden", async () => {
    let hidden = true;
    const { store, foreground } = makeQolStore({ isHidden: () => hidden });
    await store.getState().addProject("/repos/alpha");
    const s = sessionOf(store);
    foreground.names.set(s.id, "claude");

    await store.getState().pollForeground(); // hidden → skipped
    expect(foreground.queries).toHaveLength(0);

    hidden = false;
    await store.getState().pollForeground(); // visible → polls
    expect(foreground.queries).toContain(s.id);
  });

  it("startForegroundPolling schedules on the injected interval; stop clears it", async () => {
    let scheduled: (() => void) | null = null;
    let cleared = false;
    const fakeSetInterval = ((fn: () => void) => {
      scheduled = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const fakeClearInterval = (() => {
      cleared = true;
    }) as typeof clearInterval;

    const { store, foreground } = makeQolStore({
      setInterval: fakeSetInterval,
      clearInterval: fakeClearInterval,
    });
    await store.getState().addProject("/repos/alpha");
    const s = sessionOf(store);
    foreground.names.set(s.id, "claude");

    store.getState().startForegroundPolling();
    store.getState().startForegroundPolling(); // idempotent — no second schedule
    expect(scheduled).not.toBeNull();

    // Firing the scheduled tick runs a poll.
    scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    expect(foreground.queries).toContain(s.id);

    store.getState().stopForegroundPolling();
    expect(cleared).toBe(true);
  });
});

describe("per-project expansion", () => {
  it("expansion state is per-project and toggles independently", async () => {
    const { store } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta");
    const [alpha, beta] = store.getState().projects;

    // Activating beta did not collapse the previously expanded alpha row.
    expect(store.getState().expandedProjects[alpha.id]).toBe(true);
    expect(store.getState().expandedProjects[beta.id]).toBe(true);

    store.getState().toggleProjectExpanded(alpha.id);
    expect(store.getState().expandedProjects[alpha.id]).toBe(false);
    expect(store.getState().expandedProjects[beta.id]).toBe(true); // independent

    store.getState().toggleProjectExpanded(alpha.id); // back
    expect(store.getState().expandedProjects[alpha.id]).toBe(true);
  });

  it("removeProject prunes the removed project's expansion state", async () => {
    const { store } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta");
    const [alpha, beta] = store.getState().projects;

    // Collapse and reopen alpha (background) so it has a live entry to prune.
    store.getState().toggleProjectExpanded(alpha.id);
    store.getState().toggleProjectExpanded(alpha.id);
    expect(store.getState().expandedProjects[alpha.id]).toBe(true);

    await store.getState().removeProject(alpha.id);
    expect(store.getState().expandedProjects[alpha.id]).toBeUndefined();
    // beta untouched.
    expect(store.getState().expandedProjects[beta.id]).toBe(true);
  });

  it("activating a project auto-expands it without collapsing others", async () => {
    const { store } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta"); // beta active
    const [alpha, beta] = store.getState().projects;

    // Collapse alpha while it is in the background.
    store.getState().toggleProjectExpanded(alpha.id);
    expect(store.getState().expandedProjects[alpha.id]).toBe(false);

    // Switching to alpha keeps beta expanded too.
    await store.getState().setActiveProject(alpha.id);
    expect(store.getState().activeProjectId).toBe(alpha.id);
    expect(store.getState().expandedProjects[alpha.id]).toBe(true);
    expect(store.getState().expandedProjects[beta.id]).toBe(true);
  });

  it("hydrates with only the active project expanded", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        { id: "alpha", name: "alpha", path: "/repos/alpha" },
        { id: "beta", name: "beta", path: "/repos/beta" },
      ],
      activeProjectId: "beta",
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);

    await store.getState().hydrate();

    expect(store.getState().expandedProjects).toEqual({ beta: true });
  });

  it("activateSession switches project and session atomically", async () => {
    const { store } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    await store.getState().addProject("/repos/beta");
    const [alpha, beta] = store.getState().projects;
    const alphaSession = store
      .getState()
      .sessions.find((s) => s.projectId === alpha.id)!;
    const betaSession = store
      .getState()
      .sessions.find((s) => s.projectId === beta.id)!;

    await store.getState().activateSession(alpha.id, alphaSession.id);

    expect(store.getState().activeProjectId).toBe(alpha.id);
    expect(store.getState().activeSessionByProject[alpha.id]).toBe(
      alphaSession.id,
    );
    expect(store.getState().activeSessionByProject[beta.id]).toBe(
      betaSession.id,
    );
    expect(store.getState().expandedProjects[alpha.id]).toBe(true);
    expect(store.getState().expandedProjects[beta.id]).toBe(true);
  });

  it("session rename and auto-name state are independent of expansion", async () => {
    const { store, foreground } = makeQolStore();
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];
    const session = store.getState().sessions[0];

    foreground.names.set(session.id, "claude");
    await store.getState().pollForeground();
    store.getState().toggleProjectExpanded(alpha.id);
    expect(sessionDisplayName(store.getState().sessions[0])).toBe("claude");

    store.getState().renameSession(session.id, "build");
    store.getState().toggleProjectExpanded(alpha.id);
    const renamed = store.getState().sessions[0];
    expect(renamed.nameLocked).toBe(true);
    expect(sessionDisplayName(renamed)).toBe("build");
  });
});

describe("projects store activity facts", () => {
  it("reports lifecycle and foreground transitions through the injected adapter seam", async () => {
    const facts: WorkspaceActivityFact[] = [];
    const foreground = new MockForeground();
    const store = createProjectsStore({
      storage: new MockStorage(),
      registry: {
        open: () => undefined,
        close: async () => undefined,
        write: () => undefined,
      },
      newId: idGen(),
      foreground,
      onActivity: (fact) => facts.push(fact),
    });
    void store.getState().hydrate();

    await store.getState().addProject("/repos/alpha");
    const project = store.getState().projects[0];
    const session = store.getState().sessions[0];
    foreground.names.set(session.id, "codex");
    await store.getState().pollForeground();

    expect(facts).toEqual(
      expect.arrayContaining([
        { type: "project-added", projectId: project.id, projectName: "alpha" },
        {
          type: "session-created",
          projectId: project.id,
          sessionId: session.id,
          name: "zsh 1",
        },
        {
          type: "session-selected",
          projectId: project.id,
          sessionId: session.id,
        },
        {
          type: "terminal-foreground",
          projectId: project.id,
          sessionId: session.id,
          process: "codex",
        },
      ]),
    );
  });

  it("reports locked sessions as working then idle without changing their manual name", async () => {
    let now = 0;
    const activity = createActivityModule();
    const adapters = createActivityAdapters(activity, () => now);
    const { store, foreground } = makeQolStore({
      onActivity: adapters.workspace,
    });
    await store.getState().addProject("/repos/alpha");
    const session = sessionOf(store);
    store.getState().renameSession(session.id, "release build");

    now = 1;
    foreground.names.set(session.id, "codex");
    await store.getState().pollForeground();
    const projected = () =>
      activity
        .workspaceView(now)
        .groups.flatMap((group) => group.sessions)
        .find((item) => item.sessionId === session.id)!;
    expect(projected()).toMatchObject({
      status: "working",
      foregroundProcess: "codex",
    });

    now = 2;
    foreground.names.set(session.id, "zsh");
    await store.getState().pollForeground();

    expect(sessionDisplayName(sessionOf(store))).toBe("release build");
    expect(sessionOf(store).autoName).toBeUndefined();
    expect(projected()).toMatchObject({
      status: "idle",
      foregroundProcess: null,
    });
  });

  it("does not select a background project's fallback when closing its active session", async () => {
    const facts: WorkspaceActivityFact[] = [];
    const activity = createActivityModule();
    const adapters = createActivityAdapters(activity, () => 0);
    const { store } = makeQolStore({
      onActivity: (fact) => {
        facts.push(fact);
        adapters.workspace(fact);
      },
    });
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];
    const alphaFallback = sessionOf(store);
    await store.getState().addProject("/repos/beta");
    const beta = store.getState().projects[1];
    const betaSession = store
      .getState()
      .sessions.find((session) => session.projectId === beta.id)!;

    const alphaActive = store.getState().addSession(alpha.id)!;
    await store.getState().activateSession(alpha.id, alphaActive);
    await store.getState().setActiveProject(beta.id);
    expect(store.getState().expandedProjects[alpha.id]).toBe(true);
    expect(store.getState().activeProjectId).toBe(beta.id);
    expect(store.getState().activeSessionByProject[alpha.id]).toBe(alphaActive);
    facts.length = 0;

    await store.getState().closeSession(alphaActive);

    expect(store.getState().activeSessionByProject[alpha.id]).toBe(
      alphaFallback.id,
    );
    expect(facts).toContainEqual({
      type: "session-closed",
      projectId: alpha.id,
      sessionId: alphaActive,
    });
    expect(facts).not.toContainEqual({
      type: "session-selected",
      projectId: alpha.id,
      sessionId: alphaFallback.id,
    });
    expect(
      activity
        .workspaceView(0)
        .groups.flatMap((group) => group.sessions)
        .filter((session) => session.selected)
        .map((session) => session.sessionId),
    ).toEqual([betaSession.id]);
  });

  it("keeps background session mutations local while active-project changes select globally", async () => {
    const facts: WorkspaceActivityFact[] = [];
    const activity = createActivityModule();
    const adapters = createActivityAdapters(activity, () => 0);
    const { store } = makeQolStore({
      onActivity: (fact) => {
        facts.push(fact);
        adapters.workspace(fact);
      },
    });
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];
    const alphaFirst = sessionOf(store);
    await store.getState().addProject("/repos/beta");
    const beta = store.getState().projects[1];
    const betaFirst = store
      .getState()
      .sessions.find((session) => session.projectId === beta.id)!;
    facts.length = 0;

    const alphaSecond = store.getState().addSession(alpha.id)!;
    store.getState().setActiveSession(alpha.id, alphaFirst.id);

    expect(store.getState().activeSessionByProject[alpha.id]).toBe(
      alphaFirst.id,
    );
    expect(facts).not.toContainEqual({
      type: "session-selected",
      projectId: alpha.id,
      sessionId: alphaSecond,
    });
    expect(facts).not.toContainEqual({
      type: "session-selected",
      projectId: alpha.id,
      sessionId: alphaFirst.id,
    });
    expect(
      activity
        .workspaceView(0)
        .groups.flatMap((group) => group.sessions)
        .filter((session) => session.selected)
        .map((session) => session.sessionId),
    ).toEqual([betaFirst.id]);

    const betaSecond = store.getState().addSession(beta.id)!;
    store.getState().setActiveSession(beta.id, betaFirst.id);

    expect(facts).toEqual(
      expect.arrayContaining([
        {
          type: "session-selected",
          projectId: beta.id,
          sessionId: betaSecond,
        },
        {
          type: "session-selected",
          projectId: beta.id,
          sessionId: betaFirst.id,
        },
      ]),
    );
    expect(
      activity
        .workspaceView(0)
        .groups.flatMap((group) => group.sessions)
        .filter((session) => session.selected)
        .map((session) => session.sessionId),
    ).toEqual([betaFirst.id]);
  });

  it("selects the existing promoted project's session after removeProject", async () => {
    const facts: WorkspaceActivityFact[] = [];
    const { store } = makeQolStore({
      onActivity: (fact) => facts.push(fact),
    });
    await store.getState().addProject("/repos/alpha");
    const alpha = store.getState().projects[0];
    const alphaSession = sessionOf(store);
    await store.getState().addProject("/repos/beta");
    const beta = store.getState().projects[1];
    facts.length = 0;

    await store.getState().removeProject(beta.id);

    expect(store.getState().activeProjectId).toBe(alpha.id);
    expect(store.getState().activeSessionByProject[alpha.id]).toBe(
      alphaSession.id,
    );
    expect(store.getState().expandedProjects[alpha.id]).toBe(true);
    expect(facts).toEqual([
      { type: "project-removed", projectId: beta.id },
      {
        type: "session-selected",
        projectId: alpha.id,
        sessionId: alphaSession.id,
      },
    ]);
  });
});

describe("pinned remote targets (M11c)", () => {
  // The pin/unpin persist path awaits hydrationSettled + a chained storage
  // write; flush enough microtasks for both to land.
  async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it("pins, persists to kodade.json, and survives a reload", async () => {
    const storage = new MockStorage();
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    store.getState().pinRemoteTarget({ host: "box", path: "/home/keith/app" });
    await settle();

    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.version).toBe(STORAGE_VERSION);
    expect(doc.remoteTargets).toEqual([
      { host: "box", path: "/home/keith/app" },
    ]);

    // A fresh store over the same storage rehydrates the pin.
    const { store: reloaded } = makeStore(storage);
    await reloaded.getState().hydrate();
    expect(reloaded.getState().remoteTargets).toEqual([
      { host: "box", path: "/home/keith/app" },
    ]);
  });

  it("pinning is idempotent (same host+path won't duplicate)", async () => {
    const { store } = makeStore();
    await store.getState().hydrate();
    store.getState().pinRemoteTarget({ host: "box", path: "/x" });
    store.getState().pinRemoteTarget({ host: "box", path: "/x" });
    expect(store.getState().remoteTargets).toEqual([
      { host: "box", path: "/x" },
    ]);
  });

  it("selects a pinned target as a project and nests chat sessions under it", async () => {
    const { store, opens } = makeStore();
    await store.getState().hydrate();
    const target = { host: "box", path: "/srv/app" };
    store.getState().pinRemoteTarget(target);
    const projectId = remoteProjectId(target);

    await store.getState().setActiveProject(projectId);
    const threadId = store.getState().addChatThread(projectId, "claude");

    expect(store.getState().activeProjectId).toBe(projectId);
    expect(store.getState().expandedProjects[projectId]).toBe(true);
    expect(store.getState().sessions).toContainEqual(
      expect.objectContaining({
        id: threadId,
        projectId,
        name: "claude 1",
        kind: "chat",
        remote: true,
      }),
    );
    expect(store.getState().activeSessionByProject[projectId]).toBe(threadId);
    expect(opens).toHaveLength(0);
  });

  it("opens direct and provider terminals through SSH for a remote project", async () => {
    const { store, opens, writes } = makeStore();
    await store.getState().hydrate();
    const target = { host: "box", path: "/srv/app" };
    const projectId = remoteProjectId(target);
    store.getState().pinRemoteTarget(target);
    await store.getState().setActiveProject(projectId);

    const terminalId = store.getState().addSession(projectId)!;
    await settle();
    expect(opens).toContainEqual({ id: terminalId, cwd: "" });
    expect(writes.at(-1)).toMatchObject({ id: terminalId });
    expect(writes.at(-1)!.data).toContain("ssh -t box");
    expect(writes.at(-1)!.data).toContain("/srv/app");

    await store.getState().launchInSession("claude", "claude");
    await settle();
    expect(writes.at(-1)!.data).toContain("exec claude");
    expect(
      store.getState().sessions.find((session) => session.id !== terminalId),
    ).toMatchObject({ projectId, name: "ssh claude 1", remote: true });
  });

  it("keeps persisted remote projects inaccessible without ssh.pro", async () => {
    const { store, opens } = makeStore(
      new MockStorage(),
      undefined,
      true,
      { canUseRemote: () => false },
    );
    await store.getState().hydrate();
    const target = { host: "box", path: "/srv/app" };
    const projectId = remoteProjectId(target);
    store.getState().pinRemoteTarget(target);

    await store.getState().setActiveProject(projectId);

    expect(store.getState().activeProjectId).toBeNull();
    expect(store.getState().addChatThread(projectId, "claude")).toBeNull();
    expect(store.getState().addSession(projectId)).toBeNull();
    expect(opens).toHaveLength(0);
  });

  it("persists and revives chats under their remote project", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    const target = { host: "box", path: "/srv/app" };
    const projectId = remoteProjectId(target);
    try {
      const first = makeStore(storage);
      await first.store.getState().hydrate();
      first.store.getState().pinRemoteTarget(target);
      await first.store.getState().setActiveProject(projectId);
      const threadId = first.store
        .getState()
        .addChatThread(projectId, "codex")!;
      first.store
        .getState()
        .setOpenTabs(projectId, ["remote-files:box\0/srv/app"]);
      await vi.advanceTimersByTimeAsync(500);

      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.activeProjectId).toBe(projectId);
      expect(doc.sessions?.[projectId]).toContainEqual(
        expect.objectContaining({ id: threadId, kind: "chat", remote: true }),
      );
      expect(doc.openTabs?.[projectId]).toEqual([
        "remote-files:box\0/srv/app",
      ]);
    } finally {
      vi.useRealTimers();
    }

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().activeProjectId).toBe(projectId);
    expect(second.store.getState().sessions).toContainEqual(
      expect.objectContaining({
        projectId,
        name: "codex 1",
        kind: "chat",
        remote: true,
      }),
    );
    expect(second.store.getState().openTabs[projectId]).toEqual([
      "remote-files:box\0/srv/app",
    ]);
    expect(second.opens).toHaveLength(0);
  });

  it("unpins a target and persists the removal", async () => {
    const storage = new MockStorage();
    const { store } = makeStore(storage);
    await store.getState().hydrate();
    store.getState().pinRemoteTarget({ host: "box", path: "/x" });
    store.getState().pinRemoteTarget({ host: "vps", path: "/srv" });
    await settle();

    store.getState().unpinRemoteTarget({ host: "box", path: "/x" });
    await settle();

    expect(store.getState().remoteTargets).toEqual([
      { host: "vps", path: "/srv" },
    ]);
    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.remoteTargets).toEqual([{ host: "vps", path: "/srv" }]);
  });

  it("unpinning removes the remote project's nested sessions", async () => {
    const removed = vi.fn();
    const { store, closes } = makeStore(
      new MockStorage(),
      undefined,
      true,
      { onSessionRemoved: removed },
    );
    await store.getState().hydrate();
    const target = { host: "box", path: "/srv/app" };
    const projectId = remoteProjectId(target);
    store.getState().pinRemoteTarget(target);
    await store.getState().setActiveProject(projectId);
    const chatId = store.getState().addChatThread(projectId, "claude")!;
    const terminalId = store.getState().addSession(projectId)!;

    store.getState().unpinRemoteTarget(target);
    await settle();

    expect(
      store.getState().sessions.some((session) => session.projectId === projectId),
    ).toBe(false);
    expect(store.getState().activeProjectId).toBeNull();
    expect(closes).toContain(terminalId);
    expect(closes).not.toContain(chatId);
    expect(removed).toHaveBeenCalledTimes(2);
  });

  it("tolerates a corrupt persisted entry without failing hydration", async () => {
    const storage = new MockStorage();
    const doc: PersistedDoc = {
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      remoteTargets: [
        { host: "good", path: "/ok" },
        { host: "", path: "/bad" } as never, // empty host — dropped
        { path: "/no-host" } as never, // missing host — dropped
        { host: "evil", path: "/a\n&& touch pwn" }, // control char — dropped
        "garbage" as never,
      ],
    };
    storage.doc = JSON.stringify(doc);

    const { store } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().remoteTargets).toEqual([
      { host: "good", path: "/ok" },
    ]);
  });
});

// Session identity (id/name/lock) persists so an app restart recreates local
// sessions with stable ids.
describe("session identity persistence", () => {
  it("persists session ids and revives them (not fresh ids) after a restart", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const first = makeStore(storage);
      await first.store.getState().addProject("/repos/alpha");
      const alpha = first.store.getState().projects[0];
      first.store.getState().addSession(alpha.id); // second terminal
      await vi.advanceTimersByTimeAsync(500); // flush debounced persist

      const saved = first.store.getState().sessions;
      expect(saved).toHaveLength(2);
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.sessions?.[alpha.id]).toEqual([
        { id: saved[0].id, name: "zsh 1" },
        { id: saved[1].id, name: "zsh 2" },
      ]);

      // "Reload": a fresh store hydrating from the same storage.
      const second = makeStore(storage);
      await second.store.getState().hydrate();
      const s = second.store.getState();
      expect(s.sessions.map((x) => ({ id: x.id, name: x.name }))).toEqual([
        { id: saved[0].id, name: "zsh 1" },
        { id: saved[1].id, name: "zsh 2" },
      ]);
      // The shells were (re)spawned under the PERSISTED ids at the project root.
      expect(second.opens).toEqual([
        { id: saved[0].id, cwd: "/repos/alpha" },
        { id: saved[1].id, cwd: "/repos/alpha" },
      ]);
      expect(s.activeSessionByProject[alpha.id]).toBe(saved[1].id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists split-terminal workspace membership across a restart", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const first = makeStore(storage);
      await first.store.getState().addProject("/repos/alpha");
      const project = first.store.getState().projects[0];
      const workspace = first.store.getState().sessions[0];
      const splitId = first.store
        .getState()
        .addTerminal(project.id, workspace.id)!;
      await vi.advanceTimersByTimeAsync(500);

      expect((JSON.parse(storage.doc!) as PersistedDoc).sessions?.[project.id]).toEqual([
        { id: workspace.id, name: "zsh 1" },
        { id: splitId, name: "zsh 2", workspaceId: workspace.id },
      ]);

      const second = makeStore(storage);
      await second.store.getState().hydrate();
      expect(second.store.getState().sessions[1]).toMatchObject({
        id: splitId,
        workspaceId: workspace.id,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing a session removes it from persistence", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const { store } = makeStore(storage);
      await store.getState().addProject("/repos/alpha");
      const alpha = store.getState().projects[0];
      const keep = store.getState().sessions[0];
      const closedId = store.getState().addSession(alpha.id)!;
      await store.getState().closeSession(closedId);
      await vi.advanceTimersByTimeAsync(500);

      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.sessions?.[alpha.id]).toEqual([
        { id: keep.id, name: "zsh 1" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an exited session stays listed but drops out of persistence", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const { store } = makeStore(storage);
      await store.getState().addProject("/repos/alpha");
      const alpha = store.getState().projects[0];
      const dead = store.getState().sessions[0];
      store.getState().markSessionExited(dead.id);
      await vi.advanceTimersByTimeAsync(500);

      // The row remains visible (dimmed) for the user to read and close…
      expect(store.getState().sessions[0]).toMatchObject({
        id: dead.id,
        exited: true,
      });
      // …but a reload must not try to reattach a dead shell.
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.sessions?.[alpha.id]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a project with no saved sessions still gets a fresh id", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "p1", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "p1",
      // no sessions field at all (a pre-M13 document)
    } satisfies PersistedDoc);
    const { store, opens } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().sessions).toMatchObject([
      { id: "id-1", projectId: "p1", name: "zsh 1" },
    ]);
    expect(opens).toEqual([{ id: "id-1", cwd: "/repos/alpha" }]);
  });

  it("keeps a background project's saved sessions across persists and revives them on activation", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        { id: "pa", name: "alpha", path: "/repos/alpha" },
        { id: "pb", name: "beta", path: "/repos/beta" },
      ],
      activeProjectId: "pa",
      sessions: {
        pa: [{ id: "sess-a", name: "zsh 1" }],
        pb: [{ id: "sess-b", name: "claude 1", nameLocked: true }],
      },
    } satisfies PersistedDoc);
    const { store, opens } = makeStore(storage);
    await store.getState().hydrate();

    // Boot revived only the active project's session; a persist in between
    // (e.g. a theme change) must NOT drop beta's still-unrevived sessions.
    expect(opens).toEqual([{ id: "sess-a", cwd: "/repos/alpha" }]);
    store.getState().setTheme("dark");
    await store.getState().flushPersistence();
    let doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.sessions?.pb).toEqual([
      { id: "sess-b", name: "claude 1", nameLocked: true },
    ]);

    // Activating beta revives its saved session (id, name, and lock intact).
    await store.getState().setActiveProject("pb");
    expect(opens).toEqual([
      { id: "sess-a", cwd: "/repos/alpha" },
      { id: "sess-b", cwd: "/repos/beta" },
    ]);
    expect(
      store.getState().sessions.find((s) => s.id === "sess-b"),
    ).toMatchObject({ name: "claude 1", nameLocked: true });
    doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.sessions?.pb).toEqual([
      { id: "sess-b", name: "claude 1", nameLocked: true },
    ]);
  });

  it("a manual rename (and its lock) survives a restart", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().addProject("/repos/alpha");
    const session = first.store.getState().sessions[0];
    first.store.getState().renameSession(session.id, "build watcher");
    await first.store.getState().flushPersistence();

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().sessions[0]).toMatchObject({
      id: session.id,
      name: "build watcher",
      nameLocked: true,
    });
  });

  it("hydrate tolerates a malformed sessions field and drops bad entries", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "p1", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "p1",
      sessions: {
        p1: [
          null,
          { id: 42, name: "zsh 1" },
          { id: "", name: "zsh 1" },
          { id: "sess-ok", name: "" },
        ],
      },
    });
    const { store, opens } = makeStore(storage);
    await store.getState().hydrate(); // must not throw

    // Every entry was garbage → boots a fresh session, exactly as before.
    expect(store.getState().sessions).toMatchObject([
      { id: "id-1", name: "zsh 1" },
    ]);
    expect(opens).toHaveLength(1);
  });

  it("a removed project's saved sessions are never revived on re-add", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        { id: "pa", name: "alpha", path: "/repos/alpha" },
        { id: "pb", name: "beta", path: "/repos/beta" },
      ],
      activeProjectId: "pa",
      sessions: { pb: [{ id: "sess-stale", name: "zsh 1" }] },
    } satisfies PersistedDoc);
    const { store, opens } = makeStore(storage);
    await store.getState().hydrate();

    // Remove beta before it was ever activated, then re-add the same path.
    const beta = store
      .getState()
      .projects.find((p) => p.path === "/repos/beta")!;
    await store.getState().removeProject(beta.id);
    await store.getState().addProject("/repos/beta");

    // The re-added project gets a fresh session, not the stale identity.
    const revived = opens.find((o) => o.id === "sess-stale");
    expect(revived).toBeUndefined();
    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    const readded = store
      .getState()
      .projects.find((p) => p.path === "/repos/beta")!;
    expect(doc.sessions?.[readded.id]).toMatchObject([{ name: "zsh 1" }]);
    expect(doc.sessions?.[readded.id]?.[0].id).not.toBe("sess-stale");
  });
});

// Remote SSH sessions persist like any other, but are not revived after an app
// restart: the process has exited, and reviving the identity would boot a local
// shell mislabeled `ssh <host>`.
describe("remote SSH session revive (#121)", () => {
  it("a remote launch stamps the durable marker and persists it", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const { store, writes } = makeStore(storage);
      await store.getState().addProject("/repos/alpha");
      // The M11b convention: every remote path launches with an `ssh ` base.
      await store.getState().launchInSession("ssh -t box", "ssh box");
      await vi.advanceTimersByTimeAsync(500); // flush debounced persist

      const remote = store
        .getState()
        .sessions.find((s) => s.name === "ssh box 1")!;
      expect(remote.remote).toBe(true);
      expect(writes).toContainEqual({ id: remote.id, data: "ssh -t box\r" });
      const alpha = store.getState().projects[0];
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      expect(doc.sessions?.[alpha.id]).toEqual([
        { id: store.getState().sessions[0].id, name: "zsh 1" },
        { id: remote.id, name: "ssh box 1", remote: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("desktop reload revives local sessions but skips marker-flagged remote ones", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "p1", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "p1",
      sessions: {
        p1: [
          { id: "sess-local", name: "zsh 1" },
          // Renamed remote tab: no `ssh ` prefix left — only the marker knows.
          { id: "sess-ssh", name: "prod box", nameLocked: true, remote: true },
        ],
      },
    } satisfies PersistedDoc);
    const { store, opens } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().sessions.map((s) => s.id)).toEqual(["sess-local"]);
    expect(opens).toEqual([{ id: "sess-local", cwd: "/repos/alpha" }]);
  });

  it("desktop reload also skips legacy `ssh `-prefixed sessions that predate the marker", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "p1", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "p1",
      sessions: {
        p1: [
          { id: "sess-local", name: "zsh 1" },
          { id: "sess-ssh", name: "ssh box 1" }, // pre-#121 doc, prefix only
        ],
      },
    } satisfies PersistedDoc);
    const { store, opens } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().sessions.map((s) => s.id)).toEqual(["sess-local"]);
    expect(opens).toEqual([{ id: "sess-local", cwd: "/repos/alpha" }]);
  });

  it("desktop reload with only remote sessions saved boots a fresh, plainly-named shell", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "p1", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "p1",
      sessions: { p1: [{ id: "sess-ssh", name: "ssh box 1", remote: true }] },
    } satisfies PersistedDoc);
    const { store, opens } = makeStore(storage);
    await store.getState().hydrate();

    // Never a local shell wearing the `ssh box 1` label — a fresh default tab.
    expect(store.getState().sessions).toMatchObject([
      { id: "id-1", name: "zsh 1" },
    ]);
    expect(opens).toEqual([{ id: "id-1", cwd: "/repos/alpha" }]);
  });

  it("persists per-project voice vocabulary, survives a restart, and dedupes", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const first = makeStore(storage);
      await first.store.getState().addProject("/repos/alpha");
      first.store
        .getState()
        .setVoiceVocabularyTerms("/repos/alpha", [
          "appStore",
          " voxStart ",
          "appStore",
        ]);
      await vi.advanceTimersByTimeAsync(500); // flush the debounced write
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      // Trimmed + deduped, keyed by path.
      expect(doc.voiceVocabulary?.["/repos/alpha"]).toEqual([
        "appStore",
        "voxStart",
      ]);
    } finally {
      vi.useRealTimers();
    }

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    expect(second.store.getState().voiceVocabulary["/repos/alpha"]).toEqual([
      "appStore",
      "voxStart",
    ]);
  });

  it("ignores voice vocabulary writes for an untracked project path", () => {
    const { store } = makeStore();
    store.getState().setVoiceVocabularyTerms("/repos/ghost", ["term"]);
    expect(store.getState().voiceVocabulary).toEqual({});
  });

  it("drops a project's voice vocabulary when the project is removed", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    store.getState().setVoiceVocabularyTerms("/repos/alpha", ["appStore"]);
    const alpha = store.getState().projects[0];
    await store.getState().removeProject(alpha.id);
    expect(store.getState().voiceVocabulary["/repos/alpha"]).toBeUndefined();
  });

  it("caps voice vocabulary term count so the doc can't grow unbounded", async () => {
    // The add-a-term UI has no client-side limit on how many terms a user can
    // add (or how long a single pasted "term" can be), so the store itself
    // must bound the persisted doc's growth.
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const manyTerms = Array.from({ length: 250 }, (_, i) => `term${i}`);
    store.getState().setVoiceVocabularyTerms("/repos/alpha", manyTerms);
    const stored = store.getState().voiceVocabulary["/repos/alpha"];
    expect(stored.length).toBeLessThanOrEqual(200);
  });

  it("caps an individual voice vocabulary term's length", async () => {
    const { store } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const hugeTerm = "x".repeat(5_000);
    store.getState().setVoiceVocabularyTerms("/repos/alpha", [hugeTerm]);
    const stored = store.getState().voiceVocabulary["/repos/alpha"];
    expect(stored[0].length).toBeLessThanOrEqual(200);
  });

  it("caps an oversized hand-edited voice vocabulary doc on hydrate", async () => {
    vi.useFakeTimers();
    const storage = new MockStorage();
    try {
      const first = makeStore(storage);
      await first.store.getState().addProject("/repos/alpha");
      first.store
        .getState()
        .setVoiceVocabularyTerms("/repos/alpha", ["appStore"]);
      await vi.advanceTimersByTimeAsync(500); // flush the debounced write
      const doc = JSON.parse(storage.doc!) as PersistedDoc;
      // Simulate a hand-edited/corrupt doc that exceeds the cap.
      doc.voiceVocabulary = {
        "/repos/alpha": Array.from({ length: 500 }, (_, i) => `term${i}`),
      };
      storage.doc = JSON.stringify(doc);
    } finally {
      vi.useRealTimers();
    }

    const second = makeStore(storage);
    await second.store.getState().hydrate();
    const stored = second.store.getState().voiceVocabulary["/repos/alpha"];
    expect(stored?.length).toBeLessThanOrEqual(200);
  });
});

describe("chat threads are sessions without a PTY (KödChat, #163)", () => {
  it("revives chat metadata without restarting its previously owned terminal", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "project", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "project",
      sessions: {
        project: [
          { id: "chat", name: "claude 1", kind: "chat" },
          { id: "terminal", name: "zsh 1", workspaceId: "chat" },
        ],
      },
    } satisfies PersistedDoc);
    const { store, opens } = makeStore(
      storage,
      undefined,
      true,
      { autoStartTerminal: false },
    );

    await store.getState().hydrate();

    expect(store.getState().sessions).toEqual([
      { id: "chat", projectId: "project", name: "claude 1", kind: "chat" },
    ]);
    expect(opens).toEqual([]);
  });

  it("adding a project and chat creates no terminal until the chat explicitly opens one", async () => {
    const { store, opens } = makeStore(
      new MockStorage(),
      undefined,
      true,
      { autoStartTerminal: false },
    );
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    expect(opens).toHaveLength(0);

    const threadId = store.getState().addChatThread(projectId, "claude");
    expect(threadId).not.toBeNull();
    const thread = store.getState().sessions.find((s) => s.id === threadId)!;
    expect(thread.kind).toBe("chat");
    expect(thread.name).toBe("claude 1");
    // The load-bearing assertion: no registry host was opened for the thread.
    expect(opens).toHaveLength(0);
    // It still becomes the project's selected session, like any other.
    expect(store.getState().activeSessionByProject[projectId]).toBe(threadId);
  });

  it("launches a local provider into the selected chat without replacing the chat selection", async () => {
    const { store, opens, writes } = makeStore(
      new MockStorage(),
      undefined,
      true,
      { autoStartTerminal: false },
    );
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const threadId = store.getState().addChatThread(projectId, "claude")!;

    await store.getState().launchInSession("claude", "claude");

    const terminal = store
      .getState()
      .sessions.find((session) => session.kind !== "chat")!;
    expect(terminal.workspaceId).toBe(threadId);
    expect(store.getState().activeSessionByProject[projectId]).toBe(threadId);
    expect(opens).toEqual([{ id: terminal.id, cwd: "/repos/alpha" }]);
    expect(writes).toEqual([{ id: terminal.id, data: "claude\r" }]);
  });

  it("closing a chat thread never touches the registry", async () => {
    const { store, closes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const threadId = store.getState().addChatThread(projectId, "claude")!;

    await store.getState().closeSession(threadId);
    expect(closes).not.toContain(threadId);
    expect(store.getState().sessions.some((s) => s.id === threadId)).toBe(false);
  });

  it("a terminal session still opens and closes its registry host", async () => {
    const { store, opens, closes } = makeStore();
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const terminalId = store.getState().addSession(projectId)!;

    expect(opens.some((entry) => entry.id === terminalId)).toBe(true);
    await store.getState().closeSession(terminalId);
    expect(closes).toContain(terminalId);
  });

  it("persists and revives the chat kind, leaving terminals unmarked", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage);
    await first.store.getState().addProject("/repos/alpha");
    const projectId = first.store.getState().projects[0].id;
    first.store.getState().addChatThread(projectId, "codex");
    await first.store.getState().addProject("/repos/beta"); // forces a persist

    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    const saved = doc.sessions![projectId];
    expect(saved.some((s) => s.kind === "chat")).toBe(true);
    // A terminal session carries no `kind`, so a pre-KödChat document and a new
    // one are identical for terminals — that is what makes the field a
    // no-migration addition.
    expect(saved.some((s) => s.kind === undefined)).toBe(true);

    // Revive: the chat thread comes back as one, and opens no host.
    const second = makeStore(storage);
    await second.store.getState().hydrate();
    await second.store.getState().setActiveProject(projectId);
    const revivedChat = second.store
      .getState()
      .sessions.filter((s) => s.projectId === projectId && s.kind === "chat");
    expect(revivedChat).toHaveLength(1);
    expect(second.opens.some((entry) => entry.id === revivedChat[0].id)).toBe(
      false,
    );
  });

  it("the foreground poller skips chat threads entirely", async () => {
    // Typed with its real parameter so the recorded session ids are readable.
    const foreground = {
      foreground: vi.fn(async (_id: string) => "claude" as string | null),
    };
    const { store } = makeStore(new MockStorage(), undefined, true, {
      foreground,
      isHidden: () => false,
    });
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const terminalId = store.getState().activeSessionByProject[projectId];
    const threadId = store.getState().addChatThread(projectId, "claude")!;

    await store.getState().pollForeground();
    const polled = foreground.foreground.mock.calls.map((call) => call[0]);
    expect(polled).toContain(terminalId);
    expect(polled).not.toContain(threadId);
  });
});

describe("KödWork tasks are sessions without a PTY (#43)", () => {
  it("creates a work session without a terminal and without stealing the selection", async () => {
    const { store, opens } = makeStore(new MockStorage(), undefined, true, {
      autoStartTerminal: false,
    });
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const threadId = store.getState().addChatThread(projectId, "claude")!;

    const taskId = store.getState().addWorkSession(projectId);
    expect(taskId).not.toBeNull();
    const task = store.getState().sessions.find((s) => s.id === taskId)!;
    expect(task.kind).toBe("work");
    expect(task.name).toBe("work 1");
    // No registry host, and the chat keeps the pane — the task is background.
    expect(opens).toHaveLength(0);
    expect(store.getState().activeSessionByProject[projectId]).toBe(threadId);
  });

  it("persists and revives the work kind without opening a host", async () => {
    const storage = new MockStorage();
    const first = makeStore(storage, undefined, true, { autoStartTerminal: false });
    await first.store.getState().addProject("/repos/alpha");
    const projectId = first.store.getState().projects[0].id;
    first.store.getState().addWorkSession(projectId);
    await first.store.getState().flushPersistence();

    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.sessions![projectId].some((s) => s.kind === "work")).toBe(true);

    const second = makeStore(storage, undefined, true, { autoStartTerminal: false });
    await second.store.getState().hydrate();
    await second.store.getState().setActiveProject(projectId);
    const revived = second.store
      .getState()
      .sessions.filter((s) => s.projectId === projectId && s.kind === "work");
    expect(revived).toHaveLength(1);
    expect(second.opens).toHaveLength(0);
  });

  it("revives work sessions for inactive projects so schedules can run", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [
        { id: "active", name: "active", path: "/repos/active" },
        { id: "background", name: "background", path: "/repos/background" },
      ],
      activeProjectId: "active",
      sessions: {
        active: [{ id: "chat-1", name: "claude 1", kind: "chat" }],
        background: [{ id: "work-1", name: "work 1", kind: "work" }],
      },
    } satisfies PersistedDoc);
    const { store, opens } = makeStore(storage, undefined, true, {
      autoStartTerminal: false,
    });

    await store.getState().hydrate();

    expect(store.getState().activeProjectId).toBe("active");
    expect(store.getState().sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "work-1", projectId: "background", kind: "work" }),
    ]));
    expect(opens).toHaveLength(0);
  });

  it("hydrates old documents untouched: absent and unknown kinds restore terminals", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [{ id: "project", name: "alpha", path: "/repos/alpha" }],
      activeProjectId: "project",
      sessions: {
        project: [
          { id: "legacy", name: "zsh 1" },
          { id: "odd", name: "zsh 2", kind: "widget" },
        ],
      },
    });
    const { store, opens } = makeStore(storage);

    await store.getState().hydrate();
    const kinds = store.getState().sessions.map((s) => s.kind);
    expect(kinds).toEqual([undefined, undefined]);
    // Both revive as real terminals, exactly as before the field existed.
    expect(opens.map((entry) => entry.id)).toEqual(["legacy", "odd"]);
  });

  it("closing a work session skips the registry and reports the removal", async () => {
    const removed: string[] = [];
    const { store, closes } = makeStore(new MockStorage(), undefined, true, {
      autoStartTerminal: false,
      // onSessionRemoved is how the app drops the task's kodwork document.
      onSessionRemoved: (session) => void removed.push(session.id),
    });
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const taskId = store.getState().addWorkSession(projectId)!;

    await store.getState().closeSession(taskId);
    expect(closes).not.toContain(taskId);
    expect(removed).toContain(taskId);
    expect(store.getState().sessions.some((s) => s.id === taskId)).toBe(false);
  });

  it("refuses a work session on a pinned remote project", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      remoteTargets: [{ host: "studio", path: "/srv/kodade" }],
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);
    await store.getState().hydrate();
    const projectId = remoteProjectId({ host: "studio", path: "/srv/kodade" });
    expect(store.getState().addWorkSession(projectId)).toBeNull();
  });

  it("the foreground poller skips work sessions entirely", async () => {
    const foreground = {
      foreground: vi.fn(async (_id: string) => "claude" as string | null),
    };
    const { store } = makeStore(new MockStorage(), undefined, true, {
      foreground,
      isHidden: () => false,
    });
    await store.getState().addProject("/repos/alpha");
    const projectId = store.getState().projects[0].id;
    const terminalId = store.getState().activeSessionByProject[projectId];
    const taskId = store.getState().addWorkSession(projectId)!;

    await store.getState().pollForeground();
    const polled = foreground.foreground.mock.calls.map((call) => call[0]);
    expect(polled).toContain(terminalId);
    expect(polled).not.toContain(taskId);
  });
});

describe("v2 shell state (#62)", () => {
  it("hydrates a persisted v2 shell document", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      shell: {
        version: 2,
        activeTab: "editor",
        sidebarPct: 22,
        code: { mode: "chat", chatPct: 70, expanded: null },
        editor: { filesPct: 40, panels: { github: true, review: false } },
      },
      shellV2: true,
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().shellLayout).toMatchObject({
      activeTab: "editor",
      sidebarPct: 22,
      code: { mode: "chat", chatPct: 70 },
    });
    expect(store.getState().shellV2Enabled).toBe(true);
  });

  it("falls back to the v1 pane array so the first v2 boot keeps the sidebar width", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      layout: [22, 32, 16, 30],
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().shellLayout.sidebarPct).toBe(22);
    // Absent fields mean the v2.0 default: the v2 shell is on.
    expect(store.getState().shellV2Enabled).toBe(true);
  });

  it("defaults the v2 shell layout when the document has neither field", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      shellV2: "yes" as unknown as boolean,
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().shellLayout.activeTab).toBe("code");
    // Invalid legacy flag, no fallback field: still the v2.0 default.
    expect(store.getState().shellV2Enabled).toBe(true);
  });

  it("persists a new shell layout and rejects a malformed one", async () => {
    const { store, storage } = makeStore();
    const next = { ...store.getState().shellLayout, activeTab: "agents" as const };
    store.getState().setShellLayout(next);
    await store.getState().flushPersistence();

    expect(store.getState().shellLayout.activeTab).toBe("agents");
    expect((JSON.parse(storage.doc!) as PersistedDoc).shell).toMatchObject({
      version: 2,
      activeTab: "agents",
    });

    store
      .getState()
      .setShellLayout({ ...next, sidebarPct: 999 } as never);
    expect(store.getState().shellLayout.activeTab).toBe("agents");
    expect(store.getState().shellLayout.sidebarPct).toBe(next.sidebarPct);
  });

  it("leaves the v1 layout authoritative until the v2 shell is actually used", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      layout: [22, 32, 16, 30],
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);
    await store.getState().hydrate();
    store.getState().setLayout([18, 36, 16, 30]);
    await store.getState().flushPersistence();

    // No `shell` field yet: a v1-only session must not freeze a derived shell
    // document, or later sidebar resizes would never reach the first v2 boot.
    expect(JSON.parse(storage.doc!)).not.toHaveProperty("shell");

    // Actually using the v2 shell (off and back on) freezes the layout doc.
    store.getState().setShellV2Enabled(false);
    store.getState().setShellV2Enabled(true);
    await store.getState().flushPersistence();
    expect((JSON.parse(storage.doc!) as PersistedDoc).shell).toMatchObject({
      version: 2,
    });

    // Sticky: switching back to the v1 shell keeps the remembered v2 layout.
    store.getState().setShellV2Enabled(false);
    await store.getState().flushPersistence();
    const doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.shell).toMatchObject({ version: 2 });
    expect(doc.shellV2).toBe(false);
    expect(doc.shellV1Fallback).toBe(true);
  });

  it("keeps persisting a shell document that was already on disk", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      shell: { ...defaultShellLayout(), activeTab: "agents" },
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);
    await store.getState().hydrate();
    store.getState().setTheme("dark");
    await store.getState().flushPersistence();

    expect((JSON.parse(storage.doc!) as PersistedDoc).shell).toMatchObject({
      activeTab: "agents",
    });
  });

  it("persists the v2 shell toggle", async () => {
    const { store, storage } = makeStore();
    expect(store.getState().shellV2Enabled).toBe(true);

    store.getState().setShellV2Enabled(false);
    await store.getState().flushPersistence();
    let doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.shellV1Fallback).toBe(true);
    expect(doc.shellV2).toBe(false);

    store.getState().setShellV2Enabled(true);
    await store.getState().flushPersistence();
    doc = JSON.parse(storage.doc!) as PersistedDoc;
    expect(doc.shellV1Fallback).toBe(false);
    expect(doc.shellV2).toBe(true);
  });

  // v2.0 default flip (#65). The legacy `shellV2` field was written on EVERY
  // persist while the default was off, so a `false` there is not an opt-out.
  it("gives an upgrading user the v2 shell despite a legacy shellV2: false", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      shellV2: false,
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().shellV2Enabled).toBe(true);
  });

  it("honors the explicit v1 escape hatch", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      shellV2: false,
      shellV1Fallback: true,
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().shellV2Enabled).toBe(false);
  });

  it("lets an explicit fallback outrank a legacy shellV2: true", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      shellV2: true,
      shellV1Fallback: true,
    } satisfies PersistedDoc);
    const { store } = makeStore(storage);
    await store.getState().hydrate();

    expect(store.getState().shellV2Enabled).toBe(false);
  });

  it("keeps a pre-hydration switch to the classic shell", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
    } satisfies PersistedDoc);
    storage.deferRead = true;
    const { store } = makeStore(storage);

    const hydrateP = store.getState().hydrate(); // disk read pending
    store.getState().setShellV2Enabled(false); // user acts NOW
    storage.resolveRead();
    await hydrateP;

    expect(store.getState().shellV2Enabled).toBe(false);
  });

  // The mirror of the disable race, and the reason session intent is recorded
  // even when the click doesn't change the value: the default is already true,
  // so this click is a no-op against state and only the intent flag keeps
  // hydration from re-applying the saved opt-out.
  it("keeps a pre-hydration switch back to the tabbed shell", async () => {
    const storage = new MockStorage();
    storage.doc = JSON.stringify({
      version: STORAGE_VERSION,
      projects: [],
      activeProjectId: null,
      shellV2: false,
      shellV1Fallback: true,
    } satisfies PersistedDoc);
    storage.deferRead = true;
    const { store } = makeStore(storage);

    const hydrateP = store.getState().hydrate(); // disk read pending
    store.getState().setShellV2Enabled(true); // user acts NOW
    storage.resolveRead();
    await hydrateP;

    expect(store.getState().shellV2Enabled).toBe(true);
    // And the choice reaches disk, so it survives the next restart.
    await store.getState().flushPersistence();
    expect(
      (JSON.parse(storage.doc!) as PersistedDoc).shellV1Fallback,
    ).toBe(false);
  });

  it("round-trips the escape hatch through persistence", async () => {
    const { store, storage } = makeStore();
    store.getState().setShellV2Enabled(false);
    await store.getState().flushPersistence();
    expect(
      (JSON.parse(storage.doc!) as PersistedDoc).shellV1Fallback,
    ).toBe(true);

    const { store: reloaded } = makeStore(storage);
    await reloaded.getState().hydrate();
    expect(reloaded.getState().shellV2Enabled).toBe(false);
  });
});
