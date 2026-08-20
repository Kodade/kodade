// Agent connections (#64, Phase 4 slice 4): a registered "what this agent can
// reach" — an MCP server the user has chosen to keep on hand, either from the
// curated catalog (connections-catalog.ts) or a custom spec they typed in. A
// connection is display + intent metadata only. It never holds a credential and
// never reaches a CLI on its own: enabling it means installing its server into
// the CLI's own MCP config through the guarded KödHarness review flow, exactly
// like a KödWork task's MCP setup would. Personas reference connections by id.
//
// Parsing mirrors src/agents/persona.ts exactly: bounds are constants, a
// malformed ENTRY is skipped (unknown fields dropped, everything clamped), and
// a DOCUMENT that cannot be understood as a whole — not an object, or a version
// this build does not know — returns null so the store refuses to overwrite it
// (a downgrade must never destroy a newer document).

// The document version. Bumped only alongside a real migration.
export const KODCONNECTION_DOC_VERSION = 1;

// The named side document connections live in — the same confined app-data
// surface personas, KödChat transcripts, and KödWork tasks use.
export const connectionDocName = "agents/connections.json";

// Where a connection came from: the curated catalog, or a hand-entered spec.
export type ConnectionSource = "catalog" | "custom";

// How the MCP server is reached. `stdio` launches a local command; `http` points
// at a remote streamable-HTTP endpoint. These mirror the two shapes the KödWork
// "add MCP server" form already accepts, and the two shapes the catalog carries.
export type ConnectionTransport =
  | { kind: "stdio"; command: string; args: string[] }
  | { kind: "http"; url: string };

export type AgentConnection = {
  id: string;
  // Display name. For a catalog connection this is the vendor's name; for a
  // custom one it is whatever the user typed.
  name: string;
  source: ConnectionSource;
  // The catalog entry id this connection was minted from (catalog source only).
  // Absent for a custom connection.
  catalogId?: string;
  // The resolved MCP transport this connection installs.
  transport: ConnectionTransport;
  // A display-only reminder of the auth the server needs (env var names, OAuth
  // notes). Ködade never collects or stores the credential itself — this string
  // just tells the user what to set up in their own CLI config or keychain.
  authNote: string;
  createdAt: number;
  updatedAt: number;
};

// Bounds: a connection document must not grow without limit, whether from a bug
// or a hand edit. Everything clamps or truncates on parse — never throws.
export const MAX_CONNECTIONS = 200; // per scope (app, or one project)
export const MAX_NAME_CHARS = 120;
export const MAX_AUTH_NOTE_CHARS = 1_000;
export const MAX_CATALOG_ID_CHARS = 120;
export const MAX_COMMAND_CHARS = 500;
export const MAX_ARGS = 50;
export const MAX_ARG_CHARS = 500;
export const MAX_URL_CHARS = 2_000;

export const DEFAULT_CONNECTION_NAME = "New connection";

// The on-disk shape: a version plus app-scoped connections and per-project
// connections keyed by projectId.
export type PersistedConnectionDoc = {
  version: number;
  app: AgentConnection[];
  projects: Record<string, AgentConnection[]>;
};

// What a caller supplies to mint a connection; ids and timestamps are stamped by
// createConnection so the store owns id/clock injection (mirrors createPersona).
export type ConnectionInput = {
  name?: string;
  source: ConnectionSource;
  catalogId?: string;
  transport: ConnectionTransport;
  authNote?: string;
};

// An empty, valid document — the bootstrap state when nothing is saved.
export function emptyConnectionDoc(): PersistedConnectionDoc {
  return { version: KODCONNECTION_DOC_VERSION, app: [], projects: {} };
}

// A transport must survive a reload: a stdio server needs a non-blank command,
// an http server a non-blank url. An invalid one would mint a connection that
// parseConnection drops on the next load, so the write path rejects it up front.
export function isValidTransport(value: unknown): value is ConnectionTransport {
  return normalizeTransport(value) !== null;
}

// Mint a connection from caller input. Id and clock come from the store, the
// same way createPersona takes an id and `now` — so tests stay deterministic.
// An invalid transport throws: the store validates first, but this keeps the
// invariant even if createConnection is called directly.
export function createConnection(
  id: string,
  now: number,
  input: ConnectionInput,
): AgentConnection {
  const transport = normalizeTransport(input.transport);
  if (!transport) {
    throw new Error("A connection requires a stdio command or an http url.");
  }
  const connection: AgentConnection = {
    id,
    name: clampName(input.name ?? DEFAULT_CONNECTION_NAME),
    source: input.source === "custom" ? "custom" : "catalog",
    transport,
    authNote: clampAuthNote(input.authNote ?? ""),
    createdAt: now,
    updatedAt: now,
  };
  // A catalogId is meaningful only for a catalog connection; a custom one drops
  // it so a stray id can't masquerade as a catalog reference.
  if (connection.source === "catalog" && input.catalogId) {
    connection.catalogId = clampCatalogId(input.catalogId);
  }
  return connection;
}

// Apply a partial edit to an existing connection, clamping each changed field
// and stamping updatedAt. Undefined fields are left untouched (a PATCH, not a
// PUT). Source is immutable — a connection does not switch provenance.
export type ConnectionUpdate = {
  name?: string;
  transport?: ConnectionTransport;
  authNote?: string;
};

export function updateConnection(
  existing: AgentConnection,
  changes: ConnectionUpdate,
  now: number,
): AgentConnection {
  let transport = existing.transport;
  if (changes.transport !== undefined) {
    const next = normalizeTransport(changes.transport);
    if (!next) {
      throw new Error("A connection requires a stdio command or an http url.");
    }
    transport = next;
  }
  return {
    ...existing,
    name: changes.name !== undefined ? clampName(changes.name) : existing.name,
    transport,
    authNote:
      changes.authNote !== undefined ? clampAuthNote(changes.authNote) : existing.authNote,
    updatedAt: now,
  };
}

// --- clamps ---

function clampName(name: string): string {
  const trimmed = name.trim() || DEFAULT_CONNECTION_NAME;
  return trimmed.length > MAX_NAME_CHARS ? trimmed.slice(0, MAX_NAME_CHARS) : trimmed;
}

function clampAuthNote(note: string): string {
  return note.length > MAX_AUTH_NOTE_CHARS ? note.slice(0, MAX_AUTH_NOTE_CHARS) : note;
}

function clampCatalogId(id: string): string {
  const trimmed = id.trim();
  return trimmed.length > MAX_CATALOG_ID_CHARS ? trimmed.slice(0, MAX_CATALOG_ID_CHARS) : trimmed;
}

function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

// Validate and normalize an unknown transport into a clean, bounded shape, or
// null when it is neither a usable stdio command nor a usable http url. Used by
// both the write path (isValidTransport) and the parse path (parseConnection),
// so the on-disk and in-memory invariants can never drift apart.
function normalizeTransport(value: unknown): ConnectionTransport | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (t.kind === "stdio") {
    if (typeof t.command !== "string") return null;
    const command = clampText(t.command.trim(), MAX_COMMAND_CHARS);
    if (!command) return null;
    return { kind: "stdio", command, args: clampArgs(t.args) };
  }
  if (t.kind === "http") {
    if (typeof t.url !== "string") return null;
    const url = clampText(t.url.trim(), MAX_URL_CHARS);
    if (!url) return null;
    return { kind: "http", url };
  }
  return null;
}

// Keep only string args, trim/clamp each, drop empties, cap the count. Argument
// ORDER matters (unlike skill refs), so duplicates are preserved.
function clampArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const args: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const arg = clampText(entry, MAX_ARG_CHARS);
    args.push(arg);
    if (args.length >= MAX_ARGS) break;
  }
  return args;
}

// Prototype-polluting keys a JSON.parse'd object can carry as own properties;
// a project bucket under any of these names is dropped (same as persona.ts).
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Parse a connection document. A malformed ENTRY is salvaged-around (skipped,
// with unknown fields dropped and every scope bounded). A DOCUMENT that cannot
// be understood at all returns null: not an object, or a version this build
// does not know. Null means "do not overwrite" — the store refuses writes so a
// downgrade cannot destroy a newer document.
export function parsePersistedConnectionDoc(raw: unknown): PersistedConnectionDoc | null {
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.version !== KODCONNECTION_DOC_VERSION) return null;
  return {
    version: KODCONNECTION_DOC_VERSION,
    app: parseConnectionList(doc.app),
    projects: parseProjects(doc.projects),
  };
}

function parseProjects(value: unknown): Record<string, AgentConnection[]> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, AgentConnection[]> = {};
  for (const [projectId, list] of Object.entries(value as Record<string, unknown>)) {
    if (!projectId || UNSAFE_KEYS.has(projectId)) continue;
    const connections = parseConnectionList(list);
    if (connections.length > 0) out[projectId] = connections;
  }
  return out;
}

// Parse one scope's connection array: skip malformed entries, dedupe by id
// (first wins), cap at MAX_CONNECTIONS.
function parseConnectionList(value: unknown): AgentConnection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const connections: AgentConnection[] = [];
  for (const entry of value) {
    const connection = parseConnection(entry);
    if (!connection || seen.has(connection.id)) continue;
    seen.add(connection.id);
    connections.push(connection);
    if (connections.length >= MAX_CONNECTIONS) break;
  }
  return connections;
}

function parseConnection(value: unknown): AgentConnection | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id) return null;
  const transport = normalizeTransport(item.transport);
  if (!transport) return null;
  const source: ConnectionSource = item.source === "custom" ? "custom" : "catalog";
  const connection: AgentConnection = {
    id: item.id,
    name: clampName(typeof item.name === "string" ? item.name : DEFAULT_CONNECTION_NAME),
    source,
    transport,
    authNote: clampAuthNote(typeof item.authNote === "string" ? item.authNote : ""),
    createdAt: asTime(item.createdAt),
    updatedAt: asTime(item.updatedAt),
  };
  if (source === "catalog" && typeof item.catalogId === "string" && item.catalogId) {
    connection.catalogId = clampCatalogId(item.catalogId);
  }
  return connection;
}

function asTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
