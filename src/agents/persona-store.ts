// Agent persona store (#64, Phase 4 slice 1). A plain, dependency-injected
// module — no zustand, no app-store wiring yet (that is slice 2). It owns one
// in-memory persona document, loads it once, and persists the whole document
// after every mutation (the Rust storage layer makes the write atomic).
//
// Personas live in two scopes inside one document: app-wide, and per-workspace
// keyed by projectId. The store keeps them apart so a project's personas never
// leak into another project or the app scope.

import type { StorageIpc } from "../ipc/contract";
import {
  createPersona,
  emptyPersonaDoc,
  parsePersistedPersonaDoc,
  personaDocName,
  updatePersona,
  type AgentPersona,
  type PersistedPersonaDoc,
  type PersonaInput,
  type PersonaUpdate,
} from "./persona";

// App scope, or one project's scope. The store reads/writes the right bucket.
export type PersonaScope = { kind: "app" } | { kind: "project"; projectId: string };

// Only the two document methods are needed; injecting the narrow slice keeps
// tests driving it with the shared MockStorage.
export type PersonaStorage = Pick<StorageIpc, "readDoc" | "writeDoc">;

export type PersonaStoreDeps = {
  storage: PersonaStorage;
  newId?: () => string;
  now?: () => number;
};

export type PersonaStore = {
  // Read and parse the document once. Idempotent; safe to await before any op.
  load(): Promise<void>;
  // A snapshot of every persona in one scope.
  list(scope: PersonaScope): AgentPersona[];
  // Mint and persist a new persona in the scope.
  create(scope: PersonaScope, input: PersonaInput): Promise<AgentPersona>;
  // Patch an existing persona; returns null when the id isn't in that scope.
  update(
    scope: PersonaScope,
    id: string,
    changes: PersonaUpdate,
  ): Promise<AgentPersona | null>;
  // Drop a persona from the scope. A missing id is a no-op (no write).
  remove(scope: PersonaScope, id: string): Promise<void>;
};

export function createPersonaStore(deps: PersonaStoreDeps): PersonaStore {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());

  let doc: PersistedPersonaDoc = emptyPersonaDoc();
  let loaded = false;

  // The personas array for a scope, from the live in-memory document.
  const bucket = (scope: PersonaScope): AgentPersona[] =>
    scope.kind === "app" ? doc.app : (doc.projects[scope.projectId] ?? []);

  // Replace a scope's personas and persist the whole document. An emptied
  // project bucket is removed so the doc doesn't accumulate dead keys.
  const write = async (scope: PersonaScope, personas: AgentPersona[]): Promise<void> => {
    if (scope.kind === "app") {
      doc = { ...doc, app: personas };
    } else {
      const projects = { ...doc.projects };
      if (personas.length > 0) projects[scope.projectId] = personas;
      else delete projects[scope.projectId];
      doc = { ...doc, projects };
    }
    await deps.storage.writeDoc(personaDocName, JSON.stringify(doc));
  };

  return {
    async load() {
      if (loaded) return;
      loaded = true;
      let raw: string | null = null;
      try {
        raw = await deps.storage.readDoc(personaDocName);
      } catch (error) {
        console.error("kodade: persona document read failed:", error);
        return;
      }
      if (!raw) return;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        // A half-written or corrupt file loads as an empty document.
        return;
      }
      doc = parsePersistedPersonaDoc(value);
    },

    list(scope) {
      return [...bucket(scope)];
    },

    async create(scope, input) {
      const persona = createPersona(newId(), now(), input);
      await write(scope, [...bucket(scope), persona]);
      return persona;
    },

    async update(scope, id, changes) {
      const personas = bucket(scope);
      const existing = personas.find((persona) => persona.id === id);
      if (!existing) return null;
      const next = updatePersona(existing, changes, now());
      await write(
        scope,
        personas.map((persona) => (persona.id === id ? next : persona)),
      );
      return next;
    },

    async remove(scope, id) {
      const personas = bucket(scope);
      if (!personas.some((persona) => persona.id === id)) return;
      await write(scope, personas.filter((persona) => persona.id !== id));
    },
  };
}
