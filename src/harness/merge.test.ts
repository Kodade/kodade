// The MCP safe-merge engine, tested headless. The invariant that matters:
// adding one server changes exactly one key and leaves every other byte of the
// file untouched — comments, ordering, and hand-tuned formatting survive — and a
// config we can't fully parse aborts the merge before any write.

import { describe, expect, it } from "vitest";
import { mergeMcpServer, parseByFormat } from "./merge";

describe("mergeMcpServer — codex config.toml (append-only, format-preserving)", () => {
  // A config.toml "full of third-party servers" with comments and blank lines —
  // exactly the hand-tuned file the plan's Done scenario protects.
  const TOML = `# my codex config
model = "gpt-5.6-terra"

[mcp_servers.github]
command = "gh-mcp"
args = ["serve"]

# bridge to notes
[mcp_servers.notion]
command = "notion-mcp"
`;

  it("adds one table and leaves every other line byte-identical", () => {
    const merge = mergeMcpServer(TOML, "toml", "mcp_servers", {
      name: "bridgememory",
      config: { command: "kodade-mcp" },
    });

    expect(merge.touchedKey).toBe("mcp_servers.bridgememory");
    // The append-only strategy guarantees the strongest possible claim: the new
    // file literally STARTS WITH the old one (every prior byte is preserved).
    expect(merge.after.startsWith(TOML.replace(/\s*$/, ""))).toBe(true);
    // Every original line is still present, in order, byte-for-byte.
    for (const line of TOML.split("\n")) {
      expect(merge.after).toContain(line);
    }
    // The new table is present with its command.
    expect(merge.after).toContain("[mcp_servers.bridgememory]");
    expect(merge.after).toContain('command = "kodade-mcp"');

    // Re-parsing proves exactly one server was added and the neighbors survived.
    const parsed = parseByFormat(merge.after, "toml") as {
      mcp_servers: Record<string, unknown>;
      model: string;
    };
    expect(Object.keys(parsed.mcp_servers).sort()).toEqual(["bridgememory", "github", "notion"]);
    expect(parsed.mcp_servers.github).toEqual({ command: "gh-mcp", args: ["serve"] });
    expect(parsed.model).toBe("gpt-5.6-terra"); // config outside the map untouched
  });

  it("the diff is additions only (no removed lines)", () => {
    const merge = mergeMcpServer(TOML, "toml", "mcp_servers", {
      name: "bridgememory",
      config: { command: "kodade-mcp" },
    });
    expect(merge.diff).toHaveLength(1);
    expect(merge.diff[0].before).toBe(""); // nothing removed
    expect(merge.diff[0].after).toContain("[mcp_servers.bridgememory]");
  });

  it("serializes args and env into the appended table", () => {
    const merge = mergeMcpServer(TOML, "toml", "mcp_servers", {
      name: "svc",
      config: { command: "svc-mcp", args: ["--port", "1234"], env: { TOKEN: "abc" } },
    });
    const parsed = parseByFormat(merge.after, "toml") as { mcp_servers: Record<string, unknown> };
    expect(parsed.mcp_servers.svc).toEqual({
      command: "svc-mcp",
      args: ["--port", "1234"],
      env: { TOKEN: "abc" },
    });
  });

  it("has no trailing newline in the source: still glues a clean blank-line-separated hunk", () => {
    const before = '[mcp_servers.github]\ncommand = "gh-mcp"'; // no trailing "\n"
    const merge = mergeMcpServer(before, "toml", "mcp_servers", {
      name: "svc",
      config: { command: "svc-mcp" },
    });
    expect(merge.after).toBe('[mcp_servers.github]\ncommand = "gh-mcp"\n\n[mcp_servers.svc]\ncommand = "svc-mcp"\n');
  });

  it("matches the file's CRLF line endings instead of mixing EOL styles", () => {
    const before = '[mcp_servers.github]\r\ncommand = "gh-mcp"\r\n';
    const merge = mergeMcpServer(before, "toml", "mcp_servers", {
      name: "svc",
      config: { command: "svc-mcp" },
    });
    // Every prior byte survives AND the appended hunk uses the same "\r\n" —
    // no bare "\n" introduced into an otherwise all-CRLF file.
    expect(merge.after.startsWith(before)).toBe(true);
    expect(merge.after).not.toMatch(/[^\r]\n/); // every \n is preceded by \r
  });

  it("updates a same-name Ködade-owned server when its scoped args change", () => {
    const before = `[mcp_servers.kodade-mem-01HZX3WQ]
command = "/Applications/Kodade/kodade-mcp"
args = [ "--workspace", "/old/root", "--client", "codex" ]
`;
    const merge = mergeMcpServer(before, "toml", "mcp_servers", {
      name: "kodade-mem-01HZX3WQ",
      config: {
        command: "/Applications/Kodade/kodade-mcp",
        args: ["--workspace", "/new/root", "--client", "codex", "--read-only"],
      },
    });

    expect(merge.touchedKey).toBe("mcp_servers.kodade-mem-01HZX3WQ");
    expect(parseByFormat(merge.after, "toml")).toEqual({
      mcp_servers: {
        "kodade-mem-01HZX3WQ": {
          command: "/Applications/Kodade/kodade-mcp",
          args: ["--workspace", "/new/root", "--client", "codex", "--read-only"],
        },
      },
    });
  });

  it("a leading UTF-8 BOM (Windows editors) does not abort the merge", () => {
    const before = '﻿[mcp_servers.github]\ncommand = "gh-mcp"\n';
    const merge = mergeMcpServer(before, "toml", "mcp_servers", {
      name: "svc",
      config: { command: "svc-mcp" },
    });
    expect(merge.after.startsWith(before.replace(/\s*$/, ""))).toBe(true);
    expect(merge.after.charCodeAt(0)).toBe(0xfeff); // BOM byte preserved verbatim
  });
});

describe("mergeMcpServer — .mcp.json / jsonc (localized edit, comments survive)", () => {
  const JSONC = `{
  // servers my project uses
  "mcpServers": {
    "github": { "command": "gh-mcp" }
  }
}
`;

  it("inserts one key and preserves the comment and the neighbor", () => {
    const merge = mergeMcpServer(JSONC, "jsonc", "mcpServers", {
      name: "bridgememory",
      config: { command: "kodade-mcp" },
    });
    expect(merge.touchedKey).toBe("mcpServers.bridgememory");
    expect(merge.after).toContain("// servers my project uses"); // comment survives
    expect(merge.after).toContain('"github": { "command": "gh-mcp" }'); // neighbor byte-identical

    const parsed = parseByFormat(merge.after, "jsonc") as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["bridgememory", "github"]);
    expect(parsed.mcpServers.github).toEqual({ command: "gh-mcp" });
    expect(parsed.mcpServers.bridgememory).toEqual({ command: "kodade-mcp" });
  });

  it("round-trips a remote (url) server config", () => {
    const merge = mergeMcpServer(JSONC, "jsonc", "mcpServers", {
      name: "remote",
      config: { type: "http", url: "https://example.com/mcp" },
    });
    const parsed = parseByFormat(merge.after, "jsonc") as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.remote).toEqual({ type: "http", url: "https://example.com/mcp" });
  });

  it("updates a same-name Ködade-owned Claude server instead of refusing it", () => {
    const before = `{
  "mcpServers": {
    "kodade-mem": {
      "command": "/Applications/Kodade/kodade-mcp",
      "args": ["--workspace", "/old/root", "--client", "claude"]
    }
  }
}`;
    const merge = mergeMcpServer(before, "json", "mcpServers", {
      name: "kodade-mem",
      config: {
        command: "/Applications/Kodade/kodade-mcp",
        args: ["--workspace", "/new/root", "--client", "claude", "--read-only"],
      },
    });

    expect(parseByFormat(merge.after, "json")).toEqual({
      mcpServers: {
        "kodade-mem": {
          command: "/Applications/Kodade/kodade-mcp",
          args: ["--workspace", "/new/root", "--client", "claude", "--read-only"],
        },
      },
    });
  });

  it("updates the Ködade-owned OpenCode browser server command array", () => {
    const before = JSON.stringify({
      mcp: {
        "kodade-browser": {
          type: "local",
          command: ["/Applications/Kodade/kodade-mcp", "browser", "--old"],
          enabled: true,
        },
      },
    });
    const merge = mergeMcpServer(before, "json", "mcp", {
      name: "kodade-browser",
      config: {
        type: "local",
        command: ["/Applications/Kodade/kodade-mcp", "browser"],
        enabled: true,
      },
    });

    expect(parseByFormat(merge.after, "json")).toEqual({
      mcp: {
        "kodade-browser": {
          type: "local",
          command: ["/Applications/Kodade/kodade-mcp", "browser"],
          enabled: true,
        },
      },
    });
  });

  it("a leading UTF-8 BOM (Windows editors) does not abort the merge", () => {
    const before = `﻿${JSONC}`;
    const merge = mergeMcpServer(before, "jsonc", "mcpServers", {
      name: "bridgememory",
      config: { command: "kodade-mcp" },
    });
    // The BOM byte survives verbatim; the rest of the merge behaves identically.
    expect(merge.after.charCodeAt(0)).toBe(0xfeff);
    const parsed = parseByFormat(merge.after, "jsonc") as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["bridgememory", "github"]);
  });

  it("survives CRLF line endings and unicode/escaped server names", () => {
    const crlf = JSONC.replace(/\n/g, "\r\n");
    const withUnicode = mergeMcpServer(crlf, "jsonc", "mcpServers", {
      name: "服务号-🚀",
      config: { command: "x" },
    });
    const parsedUnicode = parseByFormat(withUnicode.after, "jsonc") as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsedUnicode.mcpServers)).toContain("服务号-🚀");

    const withEscaping = mergeMcpServer(JSONC, "jsonc", "mcpServers", {
      name: 'weird"name\\here',
      config: { command: "x" },
    });
    const parsedEscaped = parseByFormat(withEscaping.after, "jsonc") as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsedEscaped.mcpServers)).toContain('weird"name\\here');
  });
});

describe("mergeMcpServer — brand-new file", () => {
  it("authors a minimal well-formed json document", () => {
    const merge = mergeMcpServer("", "json", "mcpServers", {
      name: "bridgememory",
      config: { command: "kodade-mcp" },
    });
    expect(merge.isNewFile).toBe(true);
    const parsed = parseByFormat(merge.after, "json") as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers).toEqual({ bridgememory: { command: "kodade-mcp" } });
  });

  it("authors a minimal well-formed toml document", () => {
    const merge = mergeMcpServer("   \n", "toml", "mcp_servers", {
      name: "svc",
      config: { command: "svc-mcp" },
    });
    expect(merge.isNewFile).toBe(true);
    expect(merge.after).toContain("[mcp_servers.svc]");
    const parsed = parseByFormat(merge.after, "toml") as { mcp_servers: Record<string, unknown> };
    expect(parsed.mcp_servers.svc).toEqual({ command: "svc-mcp" });
  });
});

describe("mergeMcpServer — refusals (the safety gate)", () => {
  it("aborts on a corrupt TOML source before producing any output", () => {
    const corrupt = "[mcp_servers.github]\ncommand = \n"; // missing value
    expect(() =>
      mergeMcpServer(corrupt, "toml", "mcp_servers", { name: "x", config: { command: "x" } }),
    ).toThrow(/not valid TOML/);
  });

  it("aborts on a corrupt JSON source before producing any output", () => {
    const corrupt = '{ "mcpServers": { "github": { "command": } } }';
    expect(() =>
      mergeMcpServer(corrupt, "jsonc", "mcpServers", { name: "x", config: { command: "x" } }),
    ).toThrow(/not valid JSONC/);
  });

  it("refuses a duplicate server name", () => {
    const json = '{ "mcpServers": { "github": { "command": "gh-mcp" } } }';
    expect(() =>
      mergeMcpServer(json, "json", "mcpServers", { name: "github", config: { command: "x" } }),
    ).toThrow(/already exists/);
  });

  it("refuses a same-command duplicate that was not named by Ködade", () => {
    const json = '{ "mcpServers": { "other": { "command": "kodade-mcp" } } }';
    expect(() =>
      mergeMcpServer(json, "json", "mcpServers", { name: "other", config: { command: "kodade-mcp" } }),
    ).toThrow(/already exists/);
  });

  it("refuses an empty server name", () => {
    expect(() =>
      mergeMcpServer("{}", "json", "mcpServers", { name: "  ", config: { command: "x" } }),
    ).toThrow(/server name is required/);
  });

  it("aborts when mcp_servers is already defined as a non-table TOML value", () => {
    // M10g: this now aborts BEFORE attempting the merge at all, with a
    // friendlier message naming the real cause (previously it built an
    // invalid TOML document and only failed on re-parse with a raw error).
    const before = 'mcp_servers = "oops"\n';
    expect(() =>
      mergeMcpServer(before, "toml", "mcp_servers", { name: "x", config: { command: "x" } }),
    ).toThrow(/is not an object in this TOML config/);
  });

  // --- M10g regressions: defects found by the fuzz corpus (merge.fuzz.test.ts) ---

  it("aborts cleanly when mcp_servers is an array (JSONC) instead of crashing jsonc-parser", () => {
    // Before this fix, jsonc-parser's `modify` threw a raw, unwrapped internal
    // error ("Can not add index to parent of type array") for this input.
    const before = '{ "mcpServers": [1, 2, 3] }';
    expect(() =>
      mergeMcpServer(before, "jsonc", "mcpServers", { name: "x", config: { command: "x" } }),
    ).toThrow(/is not an object in this JSONC config/);
  });

  it("aborts cleanly when mcp_servers is a number (json)", () => {
    const before = '{ "mcpServers": 42 }';
    expect(() =>
      mergeMcpServer(before, "json", "mcpServers", { name: "x", config: { command: "x" } }),
    ).toThrow(/is not an object in this JSON config/);
  });

  it("gives a clear, actionable message when mcp_servers is an inline TOML table", () => {
    // An inline table is frozen by the TOML spec: appending a
    // `[mcp_servers.name]` header to "extend" it is invalid TOML. Before this
    // fix the merge produced that invalid document and only failed on
    // re-parse with a confusing raw parser error; no bytes are ever written
    // either way (the throw happens before mergeMcpServer returns).
    const before = 'mcp_servers = { github = { command = "gh-mcp" } }\n';
    expect(() =>
      mergeMcpServer(before, "toml", "mcp_servers", { name: "svc", config: { command: "x" } }),
    ).toThrow(/inline TOML table/);
  });
});
