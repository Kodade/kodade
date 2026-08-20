// Connection → CLI config mapping (#64, slice 4): dialect detection, the
// per-dialect server-config shape, honest refusal of remote under a stdio-only
// dialect, server-name resolution, and inventory probe extraction.

import { describe, expect, it } from "vitest";
import { createConnection, type AgentConnection } from "./connection";
import {
  connectionServerName,
  dialectForTarget,
  mapConnectionToTarget,
  probesFromInventory,
} from "./connection-install";
import type { HarnessInventory } from "../harness/model";

const claudeTarget = { format: "json" as const, keyPath: "mcpServers" };
const opencodeTarget = { format: "json" as const, keyPath: "mcp" };
const codexTarget = { format: "toml" as const, keyPath: "mcp_servers" };

function http(): AgentConnection {
  return createConnection("h", 1, {
    source: "catalog",
    catalogId: "github",
    name: "GitHub",
    transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
  });
}
function stdio(): AgentConnection {
  return createConnection("s", 1, {
    source: "custom",
    name: "Fetch",
    transport: { kind: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
  });
}

describe("dialectForTarget", () => {
  it("maps format+keyPath to a known dialect, else null", () => {
    expect(dialectForTarget(claudeTarget)).toBe("claude-json");
    expect(dialectForTarget(opencodeTarget)).toBe("opencode-json");
    expect(dialectForTarget(codexTarget)).toBe("toml-stdio");
    expect(dialectForTarget({ format: "json", keyPath: "weird" })).toBeNull();
  });
});

describe("connectionServerName", () => {
  it("uses the catalog serverName for a catalog connection", () => {
    expect(connectionServerName(http())).toBe("github");
  });
  it("sanitizes a custom name to a bare key", () => {
    const c = createConnection("c", 1, {
      source: "custom",
      name: "My  Cool Server!!",
      transport: { kind: "http", url: "https://x" },
    });
    expect(connectionServerName(c)).toBe("my-cool-server");
  });
});

describe("mapConnectionToTarget", () => {
  it("claude-json: http → {type:http,url}, stdio → command/args", () => {
    expect(mapConnectionToTarget(http(), claudeTarget)).toStrictEqual({
      ok: true,
      spec: { name: "github", config: { type: "http", url: "https://api.githubcopilot.com/mcp/" } },
    });
    expect(mapConnectionToTarget(stdio(), claudeTarget)).toStrictEqual({
      ok: true,
      spec: { name: "fetch", config: { command: "uvx", args: ["mcp-server-fetch"] } },
    });
  });

  it("opencode-json: remote/local wrappers with enabled:true", () => {
    expect(mapConnectionToTarget(http(), opencodeTarget)).toStrictEqual({
      ok: true,
      spec: {
        name: "github",
        config: { type: "remote", url: "https://api.githubcopilot.com/mcp/", enabled: true },
      },
    });
    expect(mapConnectionToTarget(stdio(), opencodeTarget)).toStrictEqual({
      ok: true,
      spec: {
        name: "fetch",
        config: { type: "local", command: ["uvx", "mcp-server-fetch"], enabled: true },
      },
    });
  });

  it("toml-stdio: stdio works, remote is honestly refused", () => {
    expect(mapConnectionToTarget(stdio(), codexTarget)).toStrictEqual({
      ok: true,
      spec: { name: "fetch", config: { command: "uvx", args: ["mcp-server-fetch"] } },
    });
    const refusal = mapConnectionToTarget(http(), codexTarget);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.reason).toMatch(/remote/i);
  });

  it("omits an empty args array in the command shapes", () => {
    const bare = createConnection("b", 1, {
      source: "custom",
      name: "bare",
      transport: { kind: "stdio", command: "kodade-mcp", args: [] },
    });
    expect(mapConnectionToTarget(bare, claudeTarget)).toStrictEqual({
      ok: true,
      spec: { name: "bare", config: { command: "kodade-mcp" } },
    });
  });
});

describe("probesFromInventory", () => {
  it("extracts ok mcp-server artifacts, skipping others", () => {
    const inventory: HarnessInventory = {
      scannedAt: 0,
      artifacts: [
        {
          id: "a", cli: "claude", scope: "project", kind: "mcp-server", name: "github",
          path: "/repo/.mcp.json", source: { via: "file" }, enabled: true, status: "ok",
          detail: { kind: "mcp-server", server: "github", configPath: "/repo/.mcp.json", format: "json", transport: "http", command: null },
        },
        {
          id: "b", cli: "claude", scope: "project", kind: "mcp-server", name: "broken",
          path: "/repo/.mcp.json", source: { via: "file" }, enabled: true, status: "malformed",
          detail: { kind: "mcp-server", server: "broken", configPath: "/repo/.mcp.json", format: "json", transport: null, command: null },
        },
        {
          id: "c", cli: "claude", scope: "project", kind: "instruction", name: "CLAUDE.md",
          path: "/repo/CLAUDE.md", source: { via: "file" }, enabled: true, status: "ok",
        },
      ],
      errors: [],
    };
    expect(probesFromInventory(inventory)).toStrictEqual([
      { cli: "claude", server: "github", path: "/repo/.mcp.json" },
    ]);
    expect(probesFromInventory(null)).toStrictEqual([]);
  });
});
