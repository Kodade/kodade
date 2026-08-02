import { describe, expect, it } from "vitest";
import { MockConfig } from "../ipc/mock";
import { parseByFormat } from "../harness/merge";
import {
  browserMcpSpec,
  ensureBrowserAgentSetup,
  ensureManagedBrowserRule,
  KODADE_BROWSER_RULE,
} from "./agent-setup";

describe("browserMcpSpec", () => {
  it("uses the bundled stdio adapter for Codex, Claude Code, and Grok", () => {
    for (const cli of ["codex", "claude", "grok"]) {
      expect(browserMcpSpec(cli, "/Applications/kodade/kodade-mcp")).toEqual({
        name: "kodade-browser",
        config: {
          command: "/Applications/kodade/kodade-mcp",
          args: ["browser"],
        },
      });
    }
  });

  it("uses OpenCode's local MCP command-array shape", () => {
    expect(browserMcpSpec("opencode", "C:\\Program Files\\kodade-mcp.exe")).toEqual({
      name: "kodade-browser",
      config: {
        type: "local",
        command: ["C:\\Program Files\\kodade-mcp.exe", "browser"],
        enabled: true,
      },
    });
  });
});

describe("ensureManagedBrowserRule", () => {
  it("adds the routing rule without changing existing instructions", () => {
    const existing = "# My instructions\n\nKeep replies concise.\n";
    const result = ensureManagedBrowserRule(existing);

    expect(result).toBe(`${existing}\n${KODADE_BROWSER_RULE}\n`);
  });

  it("is idempotent when the current managed rule is already present", () => {
    const current = `# My instructions\n\n${KODADE_BROWSER_RULE}\n`;
    expect(ensureManagedBrowserRule(current)).toBe(current);
  });

  it("updates only a stale managed rule block", () => {
    const stale = `before
<!-- kodade:browser:start -->
Use Chrome.
<!-- kodade:browser:end -->
after
`;
    expect(ensureManagedBrowserRule(stale)).toBe(`before
${KODADE_BROWSER_RULE}
after
`);
  });

  it("refuses malformed marker pairs instead of replacing user text", () => {
    expect(() =>
      ensureManagedBrowserRule("before\n<!-- kodade:browser:start -->\nno end\n"),
    ).toThrow("managed browser rule markers are incomplete");
  });
});

describe("ensureBrowserAgentSetup", () => {
  it("installs Codex browser tools and routing once, then becomes a no-op", async () => {
    const config = new MockConfig();

    const first = await ensureBrowserAgentSetup({
      config,
      binaryPath: "/Applications/kodade/kodade-mcp",
      installedClis: ["codex"],
    });

    expect(first).toEqual({ configured: ["codex"], errors: [] });
    expect(config.reads.get("/Users/keith/.codex/AGENTS.md")).toEqual({
      kind: "text",
      content: `\n${KODADE_BROWSER_RULE}\n`,
    });
    const codexConfig = config.reads.get("/Users/keith/.codex/config.toml");
    if (codexConfig?.kind !== "text") throw new Error("Codex config was not written");
    expect(parseByFormat(codexConfig.content, "toml")).toEqual({
      mcp_servers: {
        "kodade-browser": {
          command: "/Applications/kodade/kodade-mcp",
          args: ["browser"],
        },
      },
    });

    const writes = config.writeCalls.length;
    const second = await ensureBrowserAgentSetup({
      config,
      binaryPath: "/Applications/kodade/kodade-mcp",
      installedClis: ["codex"],
    });
    expect(second).toEqual({ configured: [], errors: [] });
    expect(config.writeCalls).toHaveLength(writes);
  });

  it("writes OpenCode's MCP shape without replacing existing instructions", async () => {
    const config = new MockConfig();
    config.reads.set("/Users/keith/.config/opencode/AGENTS.md", {
      kind: "text",
      content: "# Existing\n",
    });

    const result = await ensureBrowserAgentSetup({
      config,
      binaryPath: "/Applications/kodade/kodade-mcp",
      installedClis: ["opencode"],
    });

    expect(result).toEqual({ configured: ["opencode"], errors: [] });
    expect(config.reads.get("/Users/keith/.config/opencode/AGENTS.md")).toEqual({
      kind: "text",
      content: `# Existing\n\n${KODADE_BROWSER_RULE}\n`,
    });
    const opencodeConfig = config.reads.get("/Users/keith/.config/opencode/opencode.json");
    if (opencodeConfig?.kind !== "text") throw new Error("OpenCode config was not written");
    expect(parseByFormat(opencodeConfig.content, "json")).toEqual({
      mcp: {
        "kodade-browser": {
          type: "local",
          command: ["/Applications/kodade/kodade-mcp", "browser"],
          enabled: true,
        },
      },
    });
  });

  it("auto-configures Claude Code and Grok at their user-scope locations", async () => {
    const config = new MockConfig();

    const result = await ensureBrowserAgentSetup({
      config,
      binaryPath: "/Applications/kodade/kodade-mcp",
      installedClis: ["claude", "grok"],
    });

    expect(result).toEqual({
      configured: ["claude", "grok"],
      errors: [],
    });
    const claude = config.reads.get("/Users/keith/.claude.json");
    if (claude?.kind !== "text") throw new Error("Claude config was not written");
    expect(parseByFormat(claude.content, "json")).toMatchObject({
      mcpServers: {
        "kodade-browser": {
          command: "/Applications/kodade/kodade-mcp",
          args: ["browser"],
        },
      },
    });
    const grok = config.reads.get("/Users/keith/.grok/config.toml");
    if (grok?.kind !== "text") throw new Error("Grok config was not written");
    expect(parseByFormat(grok.content, "toml")).toMatchObject({
      mcp_servers: {
        "kodade-browser": {
          command: "/Applications/kodade/kodade-mcp",
          args: ["browser"],
        },
      },
    });
    expect(config.reads.get("/Users/keith/.claude/CLAUDE.md")).toEqual({
      kind: "text",
      content: `\n${KODADE_BROWSER_RULE}\n`,
    });
    expect(config.reads.get("/Users/keith/.grok/GROK.md")).toEqual({
      kind: "text",
      content: `\n${KODADE_BROWSER_RULE}\n`,
    });
  });

  it("reports a conflicting user-owned server without overwriting it", async () => {
    const config = new MockConfig();
    const path = "/Users/keith/.codex/config.toml";
    const existing = '[mcp_servers.kodade-browser]\ncommand = "my-browser"\n';
    config.reads.set(path, { kind: "text", content: existing });

    const result = await ensureBrowserAgentSetup({
      config,
      binaryPath: "/Applications/kodade/kodade-mcp",
      installedClis: ["codex"],
    });

    expect(result.configured).toEqual(["codex"]);
    expect(result.errors).toEqual([
      expect.stringContaining('codex MCP: an MCP server named "kodade-browser" already exists'),
    ]);
    expect(config.reads.get(path)).toEqual({ kind: "text", content: existing });
  });
});
