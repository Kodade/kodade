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
  // The last create/update/remove failure, surfaced by the editor. Cleared on
  // the next successful mutation.
  mutationError: string | null;
  // Which run the Agents tab's run area shows, or null for the empty state.
  selectedRunTaskId: string | null;

  // Load the document once and mirror the app scope.
  load(): Promise<void>;
  // Ensure a scope's list is mirrored into state (idempotent; re-reads).
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
  // Select (or clear) the run shown in the tab's run area.
  selectRun(taskId: string | null): void;
};

export function createAgentsStore(deps: AgentsDeps): StoreApi<AgentsState> {
  const { store } = deps;

  return createStore<AgentsState>((set, get) => {
    // Read the scope from the source of truth and mirror it into state.
    const mirror = (scope: PersonaScope) => {
      const key = personaScopeKey(scope);
      const list = store.list(scope);
      set((state) => ({ personas: { ...state.personas, [key]: list } }));
    };

    const message = (error: unknown) =>
      error instanceof Error ? error.message : String(error);

    return {
      personas: {},
      loaded: false,
      mutationError: null,
      selectedRunTaskId: null,

      async load() {
        await store.load();
        mirror({ kind: "app" });
        set({ loaded: true });
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

      selectRun(taskId) {
        set({ selectedRunTaskId: taskId });
      },
    };
  });
}
