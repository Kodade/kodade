import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { mergeMcpServer } from "../harness/merge";
import {
  buildDelegateMcpSetup,
  claudeDelegateMcpSnippet,
  codexDelegateMcpSnippet,
} from "./delegate-mcp-config";

describe("KödLocal delegate MCP registration", () => {
  it("builds a safe node bundle spec only for entitled registered workspaces", () => {
    expect(
      buildDelegateMcpSetup({
        workspaceId: "ws_12345678",
        workspaceRoot: "/repo",
        bundlePath: "/Applications/Ködade/kodade-local.mjs",
        entitled: false,
      }),
    ).toEqual({ state: "entitlement-required" });

    const setup = buildDelegateMcpSetup({
      workspaceId: "ws_12345678",
      workspaceRoot: "/repo with spaces",
      bundlePath: "/Applications/Ködade Tools/kodade-local.mjs",
      entitled: true,
    });
    expect(setup.state).toBe("ready");
    if (setup.state !== "ready") throw new Error("expected ready setup");
    expect(setup.spec("claude")).toEqual({
      name: "kodade-local-delegate",
      config: {
        command: "node",
        args: [
          "/Applications/Ködade Tools/kodade-local.mjs",
          "delegate",
          "--project",
          "/repo with spaces",
          "--delegating-agent",
          "claude",
        ],
      },
    });
    expect(setup.spec("codex").name).toBe(
      "kodade-local-delegate-ws_12345678",
    );
  });

  it("feeds both client specs through the format-preserving merge path", () => {
    const setup = buildDelegateMcpSetup({
      workspaceId: "01HZX3WQ9F0E8R6V5B4A2C1D0E",
      workspaceRoot: "/repo",
      bundlePath: "/app/kodade-local.mjs",
      entitled: true,
    });
    if (setup.state !== "ready") throw new Error("expected ready setup");

    const claudeBefore =
      '{\n  // user-owned neighbor\n  "mcpServers": { "github": { "command": "gh-mcp" } }\n}\n';
    const claude = mergeMcpServer(
      claudeBefore,
      "jsonc",
      "mcpServers",
      setup.spec("claude"),
    );
    expect(claude.after).toContain("// user-owned neighbor");
    expect(claude.touchedKey).toBe("mcpServers.kodade-local-delegate");

    const codex = mergeMcpServer(
      '[mcp_servers.github]\ncommand = "gh-mcp"\n',
      "toml",
      "mcp_servers",
      setup.spec("codex"),
    );
    expect(codex.after).toContain('[mcp_servers.github]\ncommand = "gh-mcp"');
    expect(
      (parseToml(codex.after) as { mcp_servers: Record<string, unknown> })
        .mcp_servers["kodade-local-delegate-01HZX3WQ9F0E8R6V5B4A2C1D0E"],
    ).toBeDefined();
    expect(claudeDelegateMcpSnippet(setup)).toContain('"delegate"');
    expect(codexDelegateMcpSnippet(setup)).toContain('"delegate"');
  });
});
