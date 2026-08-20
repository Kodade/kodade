// Mapping a connection onto a CLI's MCP config (#64, Phase 4 slice 4). This is
// the ONLY place a connection turns into an McpServerSpec, and it never writes:
// it produces the spec (or an honest reason a target can't express the
// transport) and hands off to the store's existing prepareAddMcpServer review
// flow. Enabling a connection is always the guarded, user-confirmed config-change
// path — no bytes are written here or at spawn time.
//
// Each CLI stores remote and stdio servers differently, so we map by DIALECT,
// derived from a target's (format, keyPath) pair — the same pair the KödHarness
// scan already carries. A dialect that has no verified remote representation
// disables remote install for its targets with a clear reason, rather than
// fabricating a config shape that would silently not work.

import type { McpServerSpec } from "../harness/merge";
import type { HarnessInventory, McpServerDetail } from "../harness/model";
import type { McpTarget } from "../store/harness";
import { catalogEntry } from "./connections-catalog";
import type { AgentConnection, ConnectionTransport } from "./connection";

// The config dialects Ködade knows how to write a server into. Derived from a
// target's format + server-map key, not the CLI id, so a new CLI that reuses one
// of these shapes works without a code change here.
//   • claude-json  → .mcp.json "mcpServers": { command/args | { type:"http", url } }
//   • opencode-json→ opencode.json "mcp": { type:"local"/"remote", … , enabled }
//   • toml-stdio   → codex/grok config.toml [mcp_servers.*]: command/args (stdio only)
export type McpDialect = "claude-json" | "opencode-json" | "toml-stdio";

// Identify a target's dialect from its format and server-map key. Unknown
// combinations return null so install is honestly refused rather than guessed.
export function dialectForTarget(target: Pick<McpTarget, "format" | "keyPath">): McpDialect | null {
  const key = typeof target.keyPath === "string" ? target.keyPath : target.keyPath.join(".");
  if (target.format === "json" && key === "mcpServers") return "claude-json";
  if (target.format === "json" && key === "mcp") return "opencode-json";
  if (target.format === "toml" && key === "mcp_servers") return "toml-stdio";
  return null;
}

// The ASCII server key a connection installs under. A catalog connection uses
// its entry's vetted `serverName`; a custom one sanitizes its display name to a
// bare key (letters, digits, dash, underscore), falling back to "mcp-server".
export function connectionServerName(connection: AgentConnection): string {
  if (connection.source === "catalog" && connection.catalogId) {
    const entry = catalogEntry(connection.catalogId);
    if (entry) return entry.serverName;
  }
  const sanitized = connection.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "mcp-server";
}

// The result of mapping one connection onto one target: either a ready-to-review
// server spec, or the reason the target's dialect cannot express the transport.
export type ConnectionMapping =
  | { ok: true; spec: McpServerSpec }
  | { ok: false; reason: string };

// Build the config object for a transport under a dialect, or null when the
// dialect has no representation for that transport (remote under toml-stdio).
function configFor(
  transport: ConnectionTransport,
  dialect: McpDialect,
): Record<string, unknown> | null {
  switch (dialect) {
    case "claude-json":
      if (transport.kind === "http") return { type: "http", url: transport.url };
      return transport.args.length > 0
        ? { command: transport.command, args: transport.args }
        : { command: transport.command };
    case "opencode-json":
      if (transport.kind === "http") {
        return { type: "remote", url: transport.url, enabled: true };
      }
      return {
        type: "local",
        command: [transport.command, ...transport.args],
        enabled: true,
      };
    case "toml-stdio":
      // Codex/Grok config.toml has no verified remote MCP transport for this CLI
      // — only a stdio [mcp_servers.*] with command/args. Refuse remote honestly.
      if (transport.kind === "http") return null;
      return transport.args.length > 0
        ? { command: transport.command, args: transport.args }
        : { command: transport.command };
  }
}

// Map a connection onto a target. Returns the spec to review, or an honest
// refusal a UI can render as a disabled "install" with a reason.
export function mapConnectionToTarget(
  connection: AgentConnection,
  target: Pick<McpTarget, "format" | "keyPath">,
): ConnectionMapping {
  const dialect = dialectForTarget(target);
  if (!dialect) {
    return { ok: false, reason: "Ködade doesn't know this config's MCP format." };
  }
  const config = configFor(connection.transport, dialect);
  if (!config) {
    return {
      ok: false,
      reason:
        "No verified remote MCP transport for this CLI — install a stdio " +
        "connection, or configure the remote server with the CLI's own tooling.",
    };
  }
  return { ok: true, spec: { name: connectionServerName(connection), config } };
}

// A read-only fingerprint of one MCP server already present in a scanned config
// file: which CLI, the server key, and the file it lives in. Derived from the
// KödHarness inventory — never a second scan.
export type InstalledProbe = {
  cli: string;
  server: string;
  path: string;
};

// Pull the installed MCP servers out of a harness inventory as probes. Only
// mcp-server artifacts with a readable server key contribute — a malformed or
// unreadable row is skipped rather than reported as installed.
export function probesFromInventory(inventory: HarnessInventory | null): InstalledProbe[] {
  if (!inventory) return [];
  const probes: InstalledProbe[] = [];
  for (const artifact of inventory.artifacts) {
    if (artifact.kind !== "mcp-server" || artifact.status !== "ok") continue;
    const detail = artifact.detail as McpServerDetail | undefined;
    if (!detail || detail.kind !== "mcp-server" || !detail.server) continue;
    probes.push({ cli: artifact.cli, server: detail.server, path: detail.configPath });
  }
  return probes;
}
