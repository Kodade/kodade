// Agents app-state (#64, slice 2): the reactive layer over the persona store,
// plus the Agents tab's run selection. The persona store (persona-store.ts)
// stays the source of truth and owns persistence; this Zustand store is the
// thin, React-subscribable mirror the tab renders from — the same seam the
// KödWork store gives its pane.
//
// Personas are mirrored per scope key ("app" or "project:<id>"). A scope is
// only mirrored once something asks for it (load pulls app; the tab pulls the
// current workspace), so an app with hundreds of projects never syncs lists it
// isn't showing.

import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  AgentPersona,
  PersonaInput,
  PersonaUpdate,
} from "./persona";
import type { PersonaScope, PersonaStore } from "./persona-store";

export type AgentsDeps = {
  store: PersonaStore;
};

// A stable key for a scope, so app and per-project lists never collide.
export function personaScopeKey(scope: PersonaScope): string {
  return scope.kind === "app" ? "app" : `project:${scope.projectId}`;
}

export type AgentsState = {
  // Mirrored persona lists by scope key.
  personas: Record<string, AgentPersona[]>;
  loaded: boolean;
  // False once the persona document was found unreadable (corrupt/forward
  // version). The tab surfaces this instead of an empty "no personas" state.
  // Meaningful after load() resolves.
  storageReadable: boolean;
  // The last create/update/remove failure, surfaced by the editor. Cleared on
  // the next successful mutation or when the editor target changes.
  mutationError: string | null;
  // Which run the Agents tab's run area shows, or null for the empty state.
  selectedRunTaskId: string | null;
  // Bumps on every selectRun call (even for the same id), so a run row that is
  // re-opened while the editor is up still forces the run area back into view.
  runOpenSeq: number;

  // Load the document once and mirror every scope touched so far (app plus any
  // workspace already synced). Re-mirroring on load fixes the first-open race
  // where a workspace scope was synced before the read finished.
  load(): Promise<void>;
  // Ensure a scope's list is mirrored into state (idempotent; re-reads). The
  // scope is remembered so a later load() re-mirrors it too.
  syncScope(scope: PersonaScope): void;
  // A snapshot of one scope's personas from the mirror.
  personasFor(scope: PersonaScope): AgentPersona[];
  // One persona straight from the source of truth (cloned).
  getPersona(scope: PersonaScope, id: string): AgentPersona | null;
  // Mutations delegate to the persona store, then re-mirror the scope. They
  // return null on failure (with mutationError set) rather than throwing, so
  // the editor can show the message inline.
  createPersona(scope: PersonaScope, input: PersonaInput): Promise<AgentPersona | null>;
  updatePersona(
    scope: PersonaScope,
    id: string,
    changes: PersonaUpdate,
  ): Promise<AgentPersona | null>;
  removePersona(scope: PersonaScope, id: string): Promise<void>;
  // Clear the last mutation error (e.g. when the editor switches persona).
  clearMutationError(): void;
  // Select (or clear) the run shown in the tab's run area.
  selectRun(taskId: string | null): void;
};

export function createAgentsStore(deps: AgentsDeps): StoreApi<AgentsState> {
  const { store } = deps;
  // Scopes mirrored so far, so load() can re-read all of them once the document
  // is available. The app scope is always tracked.
  const known = new Map<string, PersonaScope>([["app", { kind: "app" }]]);

  return createStore<AgentsState>((set, get) => {
    // Read the scope from the source of truth and mirror it into state.
    const mirror = (scope: PersonaScope) => {
      const key = personaScopeKey(scope);
      known.set(key, scope);
      const list = store.list(scope);
      set((state) => ({ personas: { ...state.personas, [key]: list } }));
    };

    const message = (error: unknown) =>
      error instanceof Error ? error.message : String(error);

    return {
      personas: {},
      loaded: false,
      storageReadable: true,
      mutationError: null,
      selectedRunTaskId: null,
      runOpenSeq: 0,

      async load() {
        await store.load();
        // Re-mirror every scope now that the document is read — a workspace
        // scope synced before the read no longer shows an empty list.
        for (const scope of known.values()) mirror(scope);
        set({ loaded: true, storageReadable: store.isReadable() });
      },

      syncScope(scope) {
        mirror(scope);
      },

      personasFor(scope) {
        return get().personas[personaScopeKey(scope)] ?? [];
      },

      getPersona(scope, id) {
        return store.get(scope, id);
      },

      async createPersona(scope, input) {
        try {
          const persona = await store.create(scope, input);
          mirror(scope);
          set({ mutationError: null });
          return persona;
        } catch (error) {
          set({ mutationError: message(error) });
          return null;
        }
      },

      async updatePersona(scope, id, changes) {
        try {
          const persona = await store.update(scope, id, changes);
          mirror(scope);
          set({ mutationError: null });
          return persona;
        } catch (error) {
          set({ mutationError: message(error) });
          return null;
        }
      },

      async removePersona(scope, id) {
        try {
          await store.remove(scope, id);
          mirror(scope);
          set({ mutationError: null });
        } catch (error) {
          set({ mutationError: message(error) });
        }
      },

      clearMutationError() {
        if (get().mutationError !== null) set({ mutationError: null });
      },

      selectRun(taskId) {
        set((state) => ({
          selectedRunTaskId: taskId,
          runOpenSeq: state.runOpenSeq + 1,
        }));
      },
    };
  });
}
