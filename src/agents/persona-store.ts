// Agent persona store (#64, Phase 4 slice 1). A plain, dependency-injected
// module — no zustand, no app-store wiring yet (that is slice 2). It owns one
// in-memory persona document, loads it once, and persists the whole document
// after every mutation (the Rust storage layer makes the write atomic).
//
// Personas live in two scopes inside one document: app-wide, and per-workspace
// keyed by projectId. The store keeps them apart so a project's personas never
// leak into another project or the app scope.
//
// Safety invariant: the store will NOT overwrite a document it could not read.
// A read error, corrupt JSON, or an unknown/forward version marks the document
// unreadable and every mutation rejects until a clean reload — so a crash mid
// read or a downgrade to an older build can never wipe personas.

import type { StorageIpc } from "../ipc/contract";
import {
  createPersona,
  emptyPersonaDoc,
  isValidProviderId,
  MAX_PERSONAS,
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
  // Read and parse the document once. Concurrent callers share one read.
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
  // false once the on-disk document could not be understood: every write is then
  // refused so a partial/older doc cannot clobber a good one.
  let readable = true;
  // Memoized so concurrent load() calls await the same read; cleared on a
  // transient read error so a later load() can retry.
  let loadPromise: Promise<void> | null = null;

  const runLoad = async (): Promise<void> => {
    let raw: string | null;
    try {
      raw = await deps.storage.readDoc(personaDocName);
    } catch (error) {
      console.error("kodade: persona document read failed:", error);
      readable = false;
      loadPromise = null; // a read error may be transient — allow a retry
      return;
    }
    // No document yet is a clean bootstrap: an empty, writable doc.
    if (raw === null) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // Corrupt bytes: keep the empty in-memory doc but refuse to overwrite the
      // file, so a hand-edit mistake isn't silently destroyed.
      readable = false;
      return;
    }
    const parsed = parsePersistedPersonaDoc(value);
    if (!parsed) {
      // Non-object or an unknown/forward version — do not overwrite it.
      readable = false;
      return;
    }
    doc = parsed;
  };

  // The personas array for a scope, from the live in-memory document.
  const bucket = (scope: PersonaScope): AgentPersona[] =>
    scope.kind === "app" ? doc.app : (doc.projects[scope.projectId] ?? []);

  // Replace a scope's personas and persist the whole document. Refuses to write
  // when the loaded document was unreadable. An emptied project bucket is
  // removed so the doc doesn't accumulate dead keys.
  const write = async (scope: PersonaScope, personas: AgentPersona[]): Promise<void> => {
    if (!readable) {
      throw new Error(
        "Persona document is unreadable; refusing to overwrite it. Resolve the on-disk document first.",
      );
    }
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
    load() {
      if (!loadPromise) loadPromise = runLoad();
      return loadPromise;
    },

    list(scope) {
      // Deep copy so a caller cannot mutate a stored persona (or the array).
      return bucket(scope).map((persona) => structuredClone(persona));
    },

    async create(scope, input) {
      if (!isValidProviderId(input.providerId)) {
        throw new Error("A persona requires a non-empty providerId.");
      }
      const current = bucket(scope);
      if (current.length >= MAX_PERSONAS) {
        throw new Error(`A scope cannot hold more than ${MAX_PERSONAS} personas.`);
      }
      const persona = createPersona(newId(), now(), input);
      await write(scope, [...current, persona]);
      return structuredClone(persona);
    },

    async update(scope, id, changes) {
      const personas = bucket(scope);
      const existing = personas.find((persona) => persona.id === id);
      if (!existing) return null;
      // Throws on an invalid providerId change (refuses the update).
      const next = updatePersona(existing, changes, now());
      await write(
        scope,
        personas.map((persona) => (persona.id === id ? next : persona)),
      );
      return structuredClone(next);
    },

    async remove(scope, id) {
      const personas = bucket(scope);
      if (!personas.some((persona) => persona.id === id)) return;
      await write(scope, personas.filter((persona) => persona.id !== id));
    },
  };
}
