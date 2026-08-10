import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  buildMemoryMcpSetup,
  codexMcpSnippet,
  claudeMcpSnippet,
  memoryMcpConfigMatches,
} from "./mcp-config";

describe("KödMCP client configuration", () => {
  it("generates Claude JSON and Codex TOML with spaced paths safely quoted", () => {
    const setup = buildMemoryMcpSetup({
      workspaceId: "01HZX3WQ9F0E8R6V5B4A2C1D0E",
      workspaceRoot: "/Users/Keith/Projects/Ködade Space",
      binaryPath: "/Applications/Ködade Tools/kodade-mcp",
      readOnly: false,
    });

    expect(setup.state).toBe("ready");
    if (setup.state !== "ready") throw new Error("expected ready setup");

    expect(claudeMcpSnippet(setup, "claude")).toBe(`{
  "mcpServers": {
    "kodade-mem": {
      "command": "/Applications/Ködade Tools/kodade-mcp",
      "args": [
        "--workspace",
        "/Users/Keith/Projects/Ködade Space",
        "--client",
        "claude"
      ]
    }
  }
}`);
    expect(codexMcpSnippet(setup)).toBe(` [mcp_servers.kodade-mem-01HZX3WQ9F0E8R6V5B4A2C1D0E]
command = "/Applications/Ködade Tools/kodade-mcp"
args = [ "--workspace", "/Users/Keith/Projects/Ködade Space", "--client", "codex" ]`.trimStart());
  });

  it("uses a distinct stable Codex name per workspace while Claude stays project-local", () => {
    const first = buildMemoryMcpSetup({
      workspaceId: "01HZX3WQ9F0E8R6V5B4A2C1D0E",
      workspaceRoot: "/work/one",
      binaryPath: "/Applications/Kodade/kodade-mcp",
      readOnly: false,
    });
    const second = buildMemoryMcpSetup({
      workspaceId: "02JAY4XR8G1F7S5W4C3B2A1D0E",
      workspaceRoot: "/work/two",
      binaryPath: "/Applications/Kodade/kodade-mcp",
      readOnly: false,
    });

    expect(first.state).toBe("ready");
    expect(second.state).toBe("ready");
    if (first.state !== "ready" || second.state !== "ready") throw new Error("expected ready setup");

    expect(first.spec("codex").name).toBe("kodade-mem-01HZX3WQ9F0E8R6V5B4A2C1D0E");
    expect(second.spec("codex").name).toBe("kodade-mem-02JAY4XR8G1F7S5W4C3B2A1D0E");
    expect(first.spec("claude").name).toBe("kodade-mem");
    expect(second.spec("claude").name).toBe("kodade-mem");
  });

  it("adds and removes the read-only flag in every client spec", () => {
    const writable = buildMemoryMcpSetup({
      workspaceId: "01HZX3WQ9F0E8R6V5B4A2C1D0E",
      workspaceRoot: "C:\\Work\\Ködade",
      binaryPath: "C:\\Program Files\\Ködade\\kodade-mcp.exe",
      readOnly: false,
    });
    const readOnly = buildMemoryMcpSetup({
      workspaceId: "01HZX3WQ9F0E8R6V5B4A2C1D0E",
      workspaceRoot: "C:\\Work\\Ködade",
      binaryPath: "C:\\Program Files\\Ködade\\kodade-mcp.exe",
      readOnly: true,
    });

    expect(writable.state).toBe("ready");
    expect(readOnly.state).toBe("ready");
    if (writable.state !== "ready" || readOnly.state !== "ready") {
      throw new Error("expected ready setup");
    }

    expect(writable.spec("claude").config.args).not.toContain("--read-only");
    expect(readOnly.spec("claude").config.args).toContain("--read-only");
    expect(readOnly.spec("codex").config.args).toEqual([
      "--workspace",
      "C:\\Work\\Ködade",
      "--client",
      "codex",
      "--read-only",
    ]);
  });

  it("round-trips paths with spaces and double quotes through Claude JSON and Codex TOML", () => {
    const setup = buildMemoryMcpSetup({
      workspaceId: "01HZX3WQ9F0E8R6V5B4A2C1D0E",
      workspaceRoot: 'C:\\Work Space\\Ködade "quoted"',
      binaryPath: 'C:\\Program Files\\Ködade "Tools"\\kodade-mcp.exe',
      readOnly: true,
    });

    expect(setup.state).toBe("ready");
    if (setup.state !== "ready") throw new Error("expected ready setup");

    const claude = JSON.parse(claudeMcpSnippet(setup)) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const codex = parseToml(codexMcpSnippet(setup)) as {
      mcp_servers: Record<string, { command: string; args: string[] }>;
    };
    const expectedArgs = [
      "--workspace",
      'C:\\Work Space\\Ködade "quoted"',
      "--client",
      "claude",
      "--read-only",
    ];

    expect(claude.mcpServers["kodade-mem"]).toEqual({
      command: 'C:\\Program Files\\Ködade "Tools"\\kodade-mcp.exe',
      args: expectedArgs,
    });
    expect(codex.mcp_servers["kodade-mem-01HZX3WQ9F0E8R6V5B4A2C1D0E"]).toEqual({
      command: 'C:\\Program Files\\Ködade "Tools"\\kodade-mcp.exe',
      args: [...expectedArgs.slice(0, 3), "codex", "--read-only"],
    });
  });

  it("does not offer config when the workspace is unregistered or the binary is missing", () => {
    expect(
      buildMemoryMcpSetup({ workspaceId: null, workspaceRoot: null, binaryPath: "/Applications/Kodade/kodade-mcp", readOnly: false }),
    ).toEqual({ state: "workspace-required" });
    expect(
      buildMemoryMcpSetup({ workspaceId: "ws_123456", workspaceRoot: "/repo", binaryPath: null, readOnly: false }),
    ).toEqual({ state: "binary-required" });
  });

  it("reports connected only when the full Claude command and arguments match", () => {
    const setup = buildMemoryMcpSetup({
      workspaceId: "01HZX3WQ9F0E8R6V5B4A2C1D0E",
      workspaceRoot: "/work/current",
      binaryPath: "/Applications/Ködade/kodade-mcp",
      readOnly: true,
    });
    expect(setup.state).toBe("ready");
    if (setup.state !== "ready") throw new Error("expected ready setup");
    const expected = setup.spec("claude");

    expect(
      memoryMcpConfigMatches(
        `{
          // Claude accepts JSONC here.
          "mcpServers": {
            "kodade-mem": {
              "command": "/Applications/Ködade/kodade-mcp",
              "args": ["--workspace", "/work/current", "--client", "claude", "--read-only"],
            },
          },
        }`,
        "jsonc",
        "mcpServers",
        expected,
      ),
    ).toBe(true);
    expect(
      memoryMcpConfigMatches(
        JSON.stringify({
          mcpServers: {
            "kodade-mem": {
              ...expected.config,
              args: [
                "--workspace",
                "/work/moved-away",
                "--client",
                "claude",
                "--read-only",
              ],
            },
          },
        }),
        "json",
        "mcpServers",
        expected,
      ),
    ).toBe(false);
    expect(
      memoryMcpConfigMatches(
        JSON.stringify({
          mcpServers: {
            "kodade-mem": {
              command: expected.config.command,
              args: ["--workspace", "/work/current", "--client", "claude"],
            },
          },
        }),
        "json",
        "mcpServers",
        expected,
      ),
    ).toBe(false);
    expect(
      memoryMcpConfigMatches(
        JSON.stringify({
          mcpServers: {
            "kodade-mem": {
              ...expected.config,
              env: { KODADE_DATA_DIR: "/tmp/other-memory" },
            },
          },
        }),
        "json",
        "mcpServers",
        expected,
      ),
    ).toBe(false);
  });

  it("detects stale Codex client arguments and malformed config", () => {
    const setup = buildMemoryMcpSetup({
      workspaceId: "01HZX3WQ9F0E8R6V5B4A2C1D0E",
      workspaceRoot: "/work/current",
      binaryPath: "/Applications/Ködade/kodade-mcp",
      readOnly: false,
    });
    expect(setup.state).toBe("ready");
    if (setup.state !== "ready") throw new Error("expected ready setup");
    const expected = setup.spec("codex");

    expect(
      memoryMcpConfigMatches(
        codexMcpSnippet(setup),
        "toml",
        "mcp_servers",
        expected,
      ),
    ).toBe(true);
    expect(
      memoryMcpConfigMatches(
        codexMcpSnippet(setup).replace('"codex"', '"claude"'),
        "toml",
        "mcp_servers",
        expected,
      ),
    ).toBe(false);
    expect(
      memoryMcpConfigMatches(
        "{ not valid",
        "jsonc",
        "mcpServers",
        expected,
      ),
    ).toBe(false);
  });
});
