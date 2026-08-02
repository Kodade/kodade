// The pure scan engine: raw config listings (from ConfigIpc) → HarnessInventory.
// No Tauri, no React — every function here takes plain data and returns plain
// data, so the whole thing is replayed headless in scan.test.ts. Adapters wire
// ConfigIpc to these functions; the store (M10b) wires adapters to the UI.

import { nativeBasename } from "../platform/native-path";
import type { ConfigDirEntry, ConfigScan, FileRead } from "../ipc/contract";
import type { ArtifactLocation, LocationScan } from "./contract";
import {
  artifactId,
  type ArtifactSource,
  type HarnessArtifact,
  type HarnessInventory,
  type HarnessScanError,
  type McpServerDetail,
} from "./model";

const DISABLED_SUFFIX = ".disabled";

// Infix marking a KödHarness backup sibling (config_backup / config_write write
// `<name>.kodade-bak-<iso>`). Backups are readable/restorable through the guard
// but must NEVER surface as a harness artifact, so the scanners skip them.
const BACKUP_INFIX = ".kodade-bak-";

function isBackupName(name: string): boolean {
  return name.includes(BACKUP_INFIX);
}

// Dir entries that are never artifacts (editor cruft, VCS metadata). Skills and
// subagents are the user's own content, so we only skip obvious noise.
const IGNORED_ENTRY_NAMES = new Set([".DS_Store", ".git", ".gitkeep"]);

const EMPTY: LocationScan = { artifacts: [], error: null };

// A location's presence but reversible-disabled state and display name. The
// `.disabled` suffix is KödHarness's own portable disable mechanic (no CLI
// ships one), so a disabled entry is still a real, listed artifact.
function splitDisabled(name: string): { display: string; enabled: boolean } {
  if (name.endsWith(DISABLED_SUFFIX)) {
    return { display: name.slice(0, -DISABLED_SUFFIX.length), enabled: false };
  }
  return { display: name, enabled: true };
}

// Strip a single trailing extension (e.g. "Explore.md" → "Explore"). Used for
// file-backed artifacts whose name is the stem, not the filename.
function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// The source discriminant for one entry: a symlink carries its resolved target;
// everything else is a plain file or dir.
function sourceFor(entry: ConfigDirEntry): ArtifactSource {
  if (entry.isSymlink) return { via: "symlink", target: entry.target ?? "" };
  return entry.isDir ? { via: "dir" } : { via: "file" };
}

// A per-location error, never a throw. Callers surface it as an inline banner.
function scanError(loc: ArtifactLocation, message: string): HarnessScanError {
  return { cli: loc.cli, scope: loc.scope, kind: loc.kind, path: loc.path, message };
}

// --- Instruction files (CLAUDE.md / AGENTS.md) ---

// One instruction file that was found and read. Missing files never reach here
// (the adapter skips them); a binary file is malformed, a too-large file is
// present-but-uncountable.
export function scanInstruction(loc: ArtifactLocation, read: FileRead): LocationScan {
  const name = nativeBasename(loc.path);
  const base: Omit<HarnessArtifact, "status" | "detail"> = {
    id: artifactId(loc.cli, loc.scope, "instruction", name),
    cli: loc.cli,
    scope: loc.scope,
    kind: "instruction",
    name,
    path: loc.path,
    source: { via: "file" },
    enabled: true,
  };

  if (read.kind === "text") {
    const lines = read.content ? read.content.replace(/\n$/, "").split("\n").length : 0;
    return {
      artifacts: [
        {
          ...base,
          status: "ok",
          detail: { kind: "instruction", lines, bytes: read.content.length },
        },
      ],
      error: null,
    };
  }
  if (read.kind === "tooLarge") {
    // Present and valid, just too big to count/preview cheaply.
    return {
      artifacts: [
        { ...base, status: "ok", detail: { kind: "instruction", lines: null, bytes: read.bytes } },
      ],
      error: null,
    };
  }
  // Binary content in a Markdown instruction file is malformed.
  return {
    artifacts: [
      {
        ...base,
        status: "malformed",
        detail: { kind: "instruction", lines: null, bytes: read.bytes ?? null },
      },
    ],
    error: null,
  };
}

// --- Skills directories ---

// Turn one skills-dir listing into skill artifacts. Handles symlinked entries
// (source: symlink + resolved target), orphaned symlinks (status
// "orphaned-symlink"), `.disabled` entries (enabled:false), and unreadable or
// missing directories.
export function scanSkills(loc: ArtifactLocation, scan: ConfigScan): LocationScan {
  if (scan.status === "missing") return EMPTY;
  if (scan.status === "unreadable") {
    return { artifacts: [], error: scanError(loc, scan.error) };
  }

  const artifacts: HarnessArtifact[] = [];
  for (const entry of scan.entries) {
    if (IGNORED_ENTRY_NAMES.has(entry.name)) continue;
    if (isBackupName(entry.name)) continue; // a backup sibling is never a skill
    // A skill is a directory (with a SKILL.md) or a single-file `.md` skill.
    // Non-markdown files at the top level (READMEs, images) are not skills — but
    // an orphaned symlink always surfaces (its target is gone, so we can't tell
    // what it was), never a silent empty row.
    const isFileSkill = !entry.isDir && /\.md(\.disabled)?$/i.test(entry.name);
    if (!entry.isDir && !isFileSkill && !entry.orphaned) continue;

    const { display, enabled } = splitDisabled(entry.name);
    const name = entry.isDir ? display : stripExtension(display);
    // A directory skill's manifest is its SKILL.md; a single-file skill is its
    // own manifest; an orphaned link has none to resolve.
    const manifestPath = entry.orphaned ? null : entry.isDir ? findManifest(entry) : entry.path;

    artifacts.push({
      id: artifactId(loc.cli, loc.scope, "skill", name),
      cli: loc.cli,
      scope: loc.scope,
      kind: "skill",
      name,
      path: entry.path,
      source: sourceFor(entry),
      enabled,
      status: entry.orphaned ? "orphaned-symlink" : "ok",
      detail: { kind: "skill", manifestPath },
    });
  }
  return { artifacts, error: null };
}

// The SKILL.md inside a skill directory, from the one-level recurse. Null when
// the dir has no manifest (or is an orphaned symlink with no children).
function findManifest(entry: ConfigDirEntry): string | null {
  const manifest = entry.children?.find((child) => child.name.toLowerCase() === "skill.md");
  return manifest?.path ?? null;
}

// --- Subagent directories ---

// Subagents are flat `.md` files (one per agent). Same symlink/orphan/disabled
// handling as skills, but the artifact name is the file stem.
export function scanSubagents(loc: ArtifactLocation, scan: ConfigScan): LocationScan {
  if (scan.status === "missing") return EMPTY;
  if (scan.status === "unreadable") {
    return { artifacts: [], error: scanError(loc, scan.error) };
  }

  const artifacts: HarnessArtifact[] = [];
  for (const entry of scan.entries) {
    if (IGNORED_ENTRY_NAMES.has(entry.name)) continue;
    if (isBackupName(entry.name)) continue; // a backup sibling is never a subagent
    // Subagents are markdown files; a symlink pointing at a `.md` counts too.
    if (entry.isDir) continue;
    if (!/\.md(\.disabled)?$/i.test(entry.name)) continue;

    const { display, enabled } = splitDisabled(entry.name);
    const name = stripExtension(display);

    artifacts.push({
      id: artifactId(loc.cli, loc.scope, "subagent", name),
      cli: loc.cli,
      scope: loc.scope,
      kind: "subagent",
      name,
      path: entry.path,
      source: sourceFor(entry),
      enabled,
      status: entry.orphaned ? "orphaned-symlink" : "ok",
    });
  }
  return { artifacts, error: null };
}

// --- MCP config files ---

// Turn one MCP config file into per-server artifacts. JSON is parsed properly;
// TOML is scanned for `[key.name]` table headers (a dependency-free minimum for
// M10a — full parse-tree detail and the safe merge are M10e). A present but
// unparseable config becomes a single malformed artifact, shown read-only.
export function scanMcp(loc: ArtifactLocation, read: FileRead): LocationScan {
  const format = loc.format === "toml" ? "toml" : loc.format === "jsonc" ? "jsonc" : "json";
  const key = loc.mcpKeyPath ?? "mcpServers";

  if (read.kind !== "text") {
    // A binary or oversized MCP config can't be trusted — surface it as one
    // malformed row rather than silently dropping it.
    return { artifacts: [malformedMcp(loc, format)], error: null };
  }

  let servers: ParsedServer[];
  if (format === "toml") {
    servers = parseTomlServers(read.content, key);
  } else {
    try {
      servers = parseJsonServers(read.content, key);
    } catch {
      return { artifacts: [malformedMcp(loc, format)], error: null };
    }
  }

  const artifacts = servers.map((server) => {
    const detail: McpServerDetail = {
      kind: "mcp-server",
      server: server.name,
      configPath: loc.path,
      format,
      transport: server.transport,
      command: server.command,
    };
    return {
      id: artifactId(loc.cli, loc.scope, "mcp-server", server.name),
      cli: loc.cli,
      scope: loc.scope,
      kind: "mcp-server" as const,
      name: server.name,
      path: loc.path,
      source: { via: "file" as const },
      enabled: true,
      status: "ok" as const,
      detail,
    };
  });
  return { artifacts, error: null };
}

type ParsedServer = { name: string; transport: string | null; command: string | null };

function malformedMcp(
  loc: ArtifactLocation,
  format: McpServerDetail["format"],
): HarnessArtifact {
  const name = nativeBasename(loc.path);
  return {
    id: artifactId(loc.cli, loc.scope, "mcp-server", name),
    cli: loc.cli,
    scope: loc.scope,
    kind: "mcp-server",
    name,
    path: loc.path,
    source: { via: "file" },
    enabled: true,
    status: "malformed",
    detail: { kind: "mcp-server", server: "", configPath: loc.path, format, transport: null, command: null },
  };
}

// Read the server map out of a parsed JSON/JSONC object. Each server's transport
// and command are inferred cheaply (stdio when a command is present, http/sse
// when a url is). Unknown shapes yield nulls, not errors.
function parseJsonServers(content: string, key: string): ParsedServer[] {
  const root = JSON.parse(content) as Record<string, unknown>;
  const map = root?.[key];
  if (!map || typeof map !== "object") return [];
  const servers: ParsedServer[] = [];
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    const def = (raw ?? {}) as Record<string, unknown>;
    const command = typeof def.command === "string" ? def.command : null;
    const url = typeof def.url === "string" ? def.url : null;
    const transport =
      typeof def.type === "string" ? def.type : command ? "stdio" : url ? "http" : null;
    servers.push({ name, transport, command: command ?? url });
  }
  return servers;
}

// Minimal TOML server enumeration: match `[key.name]` table headers. Honest and
// dependency-free for M10a — it surfaces which servers exist without pretending
// to fully parse TOML. Transport/command are left null until M10e.
function parseTomlServers(content: string, key: string): ParsedServer[] {
  const header = new RegExp(`^\\s*\\[\\s*${escapeRegExp(key)}\\.([^\\]]+?)\\s*\\]\\s*$`);
  const servers: ParsedServer[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = header.exec(line);
    if (!match) continue;
    // Strip optional quotes around a bare or quoted TOML key name.
    const name = match[1].trim().replace(/^["']|["']$/g, "");
    if (name && !seen.has(name)) {
      seen.add(name);
      servers.push({ name, transport: null, command: null });
    }
  }
  return servers;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Inventory assembly ---

// Flatten per-location scans into one inventory, stamped with the scan time.
export function buildInventory(scannedAt: number, scans: LocationScan[]): HarnessInventory {
  const artifacts: HarnessArtifact[] = [];
  const errors: HarnessScanError[] = [];
  for (const scan of scans) {
    artifacts.push(...scan.artifacts);
    if (scan.error) errors.push(scan.error);
  }
  return { scannedAt, artifacts, errors };
}

// Drive a full inventory scan across adapters for one scope. Adapters are
// injected (each already wired to ConfigIpc), so this stays free of Tauri; the
// store passes its adapters and a clock. Import type kept local to avoid a cycle
// with contract.ts's HarnessAdapter at module init.
export async function scanInventory(
  adapters: readonly {
    detect: (scope: HScope, ctx: SCtx) => Promise<ArtifactLocation[]>;
    scan: (loc: ArtifactLocation, ctx: SCtx) => Promise<LocationScan>;
  }[],
  scope: HScope,
  ctx: SCtx,
  now: () => number = Date.now,
): Promise<HarnessInventory> {
  const scans: LocationScan[] = [];
  for (const adapter of adapters) {
    const locations = await adapter.detect(scope, ctx);
    for (const loc of locations) {
      scans.push(await adapter.scan(loc, ctx));
    }
  }
  return buildInventory(now(), scans);
}

// Local aliases so scanInventory's signature reads without pulling model types
// into every import site.
type HScope = HarnessArtifact["scope"];
type SCtx = import("./model").ScanContext;
