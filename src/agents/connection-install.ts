// Mapping a connection onto a CLI's MCP config (#64, Phase 4 slice 4). This is
// the ONLY place a connection turns into an McpServerSpec, and it never writes:
// it produces the spec (or an honest reason a target can't express the
// transport) and hands off to the store's existing prepareAddMcpServer review
// flow. Enabling a connection is always the guarded, user-confirmed config-change
// path — no bytes are written here or at spawn time.
//
// Each CLI stores remote and stdio servers differently, so we map by DIALECT,
// derived from a target's (format, keyPath) pair — the same pair the KödHarness
// scan already carries. Every dialect maps a transport only to a config shape
// verified against the CLI's docs; a dialect that couldn't express a transport
// would disable install for its targets with a clear reason rather than
// fabricate a shape that silently doesn't work.

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
//   • toml         → codex/grok config.toml [mcp_servers.*]: stdio command/args, or
//                    a remote streamable-HTTP server as a bare `url` key.
export type McpDialect = "claude-json" | "opencode-json" | "toml";

// Identify a target's dialect from its format and server-map key. Unknown
// combinations return null so install is honestly refused rather than guessed.
export function dialectForTarget(target: Pick<McpTarget, "format" | "keyPath">): McpDialect | null {
  const key = typeof target.keyPath === "string" ? target.keyPath : target.keyPath.join(".");
  if (target.format === "json" && key === "mcpServers") return "claude-json";
  if (target.format === "json" && key === "mcp") return "opencode-json";
  if (target.format === "toml" && key === "mcp_servers") return "toml";
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
// dialect has no representation for that transport. (Every dialect Ködade
// currently knows can express both transports; null is kept for a future dialect
// that can't.)
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
    case "toml":
      // Codex/Grok config.toml [mcp_servers.<name>] supports a remote streamable
      // HTTP server via a bare `url` key — verified 2026-08-20 against official
      // docs: Codex CLI (learn.chatgpt.com/docs/config-file/config-reference,
      // `mcp_servers.<id>.url` = "Endpoint for an MCP streamable HTTP server",
      // shipped since rust-v0.44.0, whose companion PR openai/codex#4689
      // removed the earlier experimental_use_rmcp_client gate — any Codex that
      // reads `url` at all reads it ungated) and Grok Build CLI
      // (docs.x.ai/build/features/mcp-servers, `[mcp_servers.<name>] url = "…"`).
      // BYOK: write ONLY `url` — never http_headers/headers/bearer_token_env_var
      // or any auth field. Credentials and headers stay in the user's own CLI
      // config, exactly as with a stdio server.
      if (transport.kind === "http") return { url: transport.url };
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
    // Unreachable for the dialects Ködade ships today (each maps both stdio and
    // http). Kept as an honest fallback for a future dialect that can't express
    // a transport — the reason stays generic so it never claims something false.
    return {
      ok: false,
      reason:
        "This CLI's config can't express this connection's transport — install " +
        "it with the CLI's own tooling instead.",
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
