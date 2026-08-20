// Connections app-state (#64, Phase 4 slice 4): the reactive layer over the
// connection store (connection-store.ts), the sibling of agents-store.ts. The
// connection store stays the source of truth and owns persistence; this Zustand
// store is the thin, React-subscribable mirror the Connections UI renders from.
//
// Connections are mirrored per scope key ("app" or "project:<id>"), and a scope
// is only mirrored once something asks for it — the same lazy pattern the
// personas mirror uses, so an app with hundreds of projects never syncs lists it
// isn't showing.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { AgentConnection, ConnectionInput, ConnectionUpdate } from "./connection";
import type { ConnectionScope, ConnectionStore } from "./connection-store";

export type ConnectionsDeps = {
  store: ConnectionStore;
};

// A stable key for a scope, so app and per-project lists never collide.
export function connectionScopeKey(scope: ConnectionScope): string {
  return scope.kind === "app" ? "app" : `project:${scope.projectId}`;
}

export type ConnectionsState = {
  connections: Record<string, AgentConnection[]>;
  loaded: boolean;
  // False once the connection document was found unreadable (corrupt/forward
  // version). The UI surfaces this instead of an empty "no connections" state.
  storageReadable: boolean;
  // The last create/update/remove failure, surfaced inline. Cleared on the next
  // successful mutation or when explicitly cleared.
  mutationError: string | null;

  load(): Promise<void>;
  syncScope(scope: ConnectionScope): void;
  connectionsFor(scope: ConnectionScope): AgentConnection[];
  getConnection(scope: ConnectionScope, id: string): AgentConnection | null;
  createConnection(
    scope: ConnectionScope,
    input: ConnectionInput,
  ): Promise<AgentConnection | null>;
  updateConnection(
    scope: ConnectionScope,
    id: string,
    changes: ConnectionUpdate,
  ): Promise<AgentConnection | null>;
  removeConnection(scope: ConnectionScope, id: string): Promise<void>;
  clearMutationError(): void;
};

export function createConnectionsStore(deps: ConnectionsDeps): StoreApi<ConnectionsState> {
  const { store } = deps;
  // Scopes mirrored so far, so load() can re-read all of them once the document
  // is available. The app scope is always tracked.
  const known = new Map<string, ConnectionScope>([["app", { kind: "app" }]]);

  return createStore<ConnectionsState>((set, get) => {
    const mirror = (scope: ConnectionScope) => {
      const key = connectionScopeKey(scope);
      known.set(key, scope);
      const list = store.list(scope);
      set((state) => ({ connections: { ...state.connections, [key]: list } }));
    };

    const message = (error: unknown) =>
      error instanceof Error ? error.message : String(error);

    return {
      connections: {},
      loaded: false,
      storageReadable: true,
      mutationError: null,

      async load() {
        await store.load();
        for (const scope of known.values()) mirror(scope);
        set({ loaded: true, storageReadable: store.isReadable() });
      },

      syncScope(scope) {
        mirror(scope);
      },

      connectionsFor(scope) {
        return get().connections[connectionScopeKey(scope)] ?? [];
      },

      getConnection(scope, id) {
        return store.get(scope, id);
      },

      async createConnection(scope, input) {
        try {
          const connection = await store.create(scope, input);
          mirror(scope);
          set({ mutationError: null });
          return connection;
        } catch (error) {
          set({ mutationError: message(error) });
          return null;
        }
      },

      async updateConnection(scope, id, changes) {
        try {
          const connection = await store.update(scope, id, changes);
          mirror(scope);
          set({ mutationError: null });
          return connection;
        } catch (error) {
          set({ mutationError: message(error) });
          return null;
        }
      },

      async removeConnection(scope, id) {
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
    };
  });
}
