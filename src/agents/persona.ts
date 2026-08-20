// Agent personas (#64, Phase 4 slice 1): a reusable "who runs this" — a name, a
// system prompt, the provider it speaks through, and opaque references to
// KödSkills skill ids and connection ids. Personas are additive metadata; this
// slice touches no run engine and no UI. Parsing mirrors src/kodwork/model.ts:
// bounds are constants, parsing never throws, and unknown fields are dropped so
// a hand-edited or forward-versioned document degrades instead of breaking.

// The document version. Bumped only alongside a real migration.
export const KODAGENT_DOC_VERSION = 1;

// The named side document personas live in — same confined app-data surface the
// KödChat transcripts and KödWork tasks use.
export const personaDocName = "agents/personas.json";

export type AgentPersona = {
  id: string;
  name: string;
  // The system prompt the persona injects for its runs.
  prompt: string;
  // Same provider id space a KödWork task's providerId uses (e.g. "claude").
  providerId: string;
  // KödSkills skill ids (see src/harness/skill-identity.ts for the id shape).
  // Stored as opaque ids only — no validation against installed packs here.
  skills: string[];
  // Connection ids. The connection registry arrives in a later slice; these are
  // opaque strings until then.
  connections: string[];
  createdAt: number;
  updatedAt: number;
};

// Bounds: a persona document must not grow without limit, whether from a bug or
// a hand edit. Everything clamps or truncates on parse — never throws.
export const MAX_PERSONAS = 200; // per scope (app, or one project)
export const MAX_NAME_CHARS = 120;
export const MAX_PROMPT_CHARS = 20_000;
export const MAX_SKILL_REFS = 50;
export const MAX_CONNECTION_REFS = 50;

export const DEFAULT_PERSONA_NAME = "New persona";

// The on-disk shape: a version plus app-scoped personas and per-project
// personas keyed by projectId.
export type PersistedPersonaDoc = {
  version: number;
  app: AgentPersona[];
  projects: Record<string, AgentPersona[]>;
};

// What a caller supplies to mint a persona; ids and timestamps are stamped by
// createPersona so the store owns id/clock injection (mirrors newTask).
export type PersonaInput = {
  name?: string;
  prompt?: string;
  providerId: string;
  skills?: string[];
  connections?: string[];
};

// An empty, valid document — the bootstrap state when nothing is saved.
export function emptyPersonaDoc(): PersistedPersonaDoc {
  return { version: KODAGENT_DOC_VERSION, app: [], projects: {} };
}

// Mint a persona from caller input. The id and clock come from the store, the
// same way newTask takes an id and `now` — so tests stay deterministic.
export function createPersona(
  id: string,
  now: number,
  input: PersonaInput,
): AgentPersona {
  return {
    id,
    name: clampName(input.name ?? DEFAULT_PERSONA_NAME),
    prompt: clampPrompt(input.prompt ?? ""),
    providerId: input.providerId,
    skills: clampRefs(input.skills ?? [], MAX_SKILL_REFS),
    connections: clampRefs(input.connections ?? [], MAX_CONNECTION_REFS),
    createdAt: now,
    updatedAt: now,
  };
}

// Apply a partial edit to an existing persona, clamping each changed field and
// stamping updatedAt. Undefined fields are left untouched (a PATCH, not a PUT).
export type PersonaUpdate = Partial<PersonaInput>;

export function updatePersona(
  existing: AgentPersona,
  changes: PersonaUpdate,
  now: number,
): AgentPersona {
  return {
    ...existing,
    name: changes.name !== undefined ? clampName(changes.name) : existing.name,
    prompt: changes.prompt !== undefined ? clampPrompt(changes.prompt) : existing.prompt,
    providerId: changes.providerId ?? existing.providerId,
    skills:
      changes.skills !== undefined
        ? clampRefs(changes.skills, MAX_SKILL_REFS)
        : existing.skills,
    connections:
      changes.connections !== undefined
        ? clampRefs(changes.connections, MAX_CONNECTION_REFS)
        : existing.connections,
    updatedAt: now,
  };
}

function clampName(name: string): string {
  const trimmed = name.trim() || DEFAULT_PERSONA_NAME;
  return trimmed.length > MAX_NAME_CHARS ? trimmed.slice(0, MAX_NAME_CHARS) : trimmed;
}

function clampPrompt(prompt: string): string {
  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
}

// Keep only string refs, drop blanks, dedupe (first wins), and cap the count.
function clampRefs(value: string[], max: number): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const ref = entry.trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
    if (refs.length >= max) break;
  }
  return refs;
}

// Parse a persona document defensively. A non-object, a wrong version, or any
// malformed entry degrades to as-much-as-can-be-salvaged, never a throw:
// non-object → empty doc; bad entries skipped; unknown fields dropped; ids
// deduped (first wins); every scope bounded.
export function parsePersistedPersonaDoc(raw: unknown): PersistedPersonaDoc {
  if (typeof raw !== "object" || raw === null) return emptyPersonaDoc();
  const doc = raw as Record<string, unknown>;
  return {
    version: KODAGENT_DOC_VERSION,
    app: parsePersonaList(doc.app),
    projects: parseProjects(doc.projects),
  };
}

function parseProjects(value: unknown): Record<string, AgentPersona[]> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, AgentPersona[]> = {};
  for (const [projectId, list] of Object.entries(value as Record<string, unknown>)) {
    if (!projectId) continue;
    const personas = parsePersonaList(list);
    // Skip a project key that salvaged nothing — keeps the doc tidy.
    if (personas.length > 0) out[projectId] = personas;
  }
  return out;
}

// Parse one scope's persona array: skip malformed entries, dedupe by id (first
// wins), cap at MAX_PERSONAS.
function parsePersonaList(value: unknown): AgentPersona[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const personas: AgentPersona[] = [];
  for (const entry of value) {
    const persona = parsePersona(entry);
    if (!persona || seen.has(persona.id)) continue;
    seen.add(persona.id);
    personas.push(persona);
    if (personas.length >= MAX_PERSONAS) break;
  }
  return personas;
}

function parsePersona(value: unknown): AgentPersona | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id) return null;
  if (typeof item.providerId !== "string" || !item.providerId) return null;
  return {
    id: item.id,
    name: clampName(typeof item.name === "string" ? item.name : DEFAULT_PERSONA_NAME),
    prompt: clampPrompt(typeof item.prompt === "string" ? item.prompt : ""),
    providerId: item.providerId,
    skills: clampRefs(asStringArray(item.skills), MAX_SKILL_REFS),
    connections: clampRefs(asStringArray(item.connections), MAX_CONNECTION_REFS),
    createdAt: asTime(item.createdAt),
    updatedAt: asTime(item.updatedAt),
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
