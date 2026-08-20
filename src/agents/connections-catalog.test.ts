// Catalog integrity (#64, slice 4). Every entry must carry provenance, a docs
// URL, a valid transport shape, and an auth note — and the set of ids must be
// EXACTLY the verified research list, so no unvetted server can slip in.

import { describe, expect, it } from "vitest";
import { CONNECTIONS_CATALOG, catalogEntry } from "./connections-catalog";
import { isValidTransport } from "./connection";

// The only permitted catalog, enumerated. A new entry must be added here first,
// which forces a human to justify its provenance.
const ALLOWED_IDS = [
  "vidiq",
  "fal-docs",
  "gmail",
  "github",
  "notion",
  "context7",
  "playwright",
  "fetch",
] as const;

describe("connections catalog", () => {
  it("contains exactly the verified research ids", () => {
    expect(CONNECTIONS_CATALOG.map((e) => e.id).sort()).toStrictEqual([...ALLOWED_IDS].sort());
  });

  it("has unique ids and unique server keys", () => {
    const ids = CONNECTIONS_CATALOG.map((e) => e.id);
    const servers = CONNECTIONS_CATALOG.map((e) => e.serverName);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(servers).size).toBe(servers.length);
  });

  it("every entry carries provenance, an https docs URL, an auth note, and a bare server key", () => {
    for (const entry of CONNECTIONS_CATALOG) {
      expect(entry.provenance === "official vendor" || entry.provenance === "MCP reference implementation").toBe(true);
      expect(entry.docsUrl).toMatch(/^https:\/\//);
      expect(entry.authNote.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
      // The server key must be a legal bare JSON/TOML key.
      expect(entry.serverName).toMatch(/^[a-z0-9_-]+$/);
    }
  });

  it("every entry has at least one valid transport", () => {
    for (const entry of CONNECTIONS_CATALOG) {
      expect(entry.transports.length).toBeGreaterThan(0);
      for (const transport of entry.transports) {
        expect(isValidTransport(transport)).toBe(true);
      }
    }
  });

  it("keeps the exact verified endpoints and commands", () => {
    expect(catalogEntry("vidiq")?.transports).toStrictEqual([
      { kind: "http", url: "https://mcp.vidiq.com/mcp" },
    ]);
    expect(catalogEntry("gmail")?.transports).toStrictEqual([
      { kind: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" },
    ]);
    expect(catalogEntry("github")?.transports).toStrictEqual([
      { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
    ]);
    expect(catalogEntry("playwright")?.transports).toStrictEqual([
      { kind: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
    ]);
    expect(catalogEntry("fetch")?.transports).toStrictEqual([
      { kind: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    ]);
    // Notion and Context7 offer both a remote endpoint and a stdio command.
    expect(catalogEntry("notion")?.transports).toStrictEqual([
      { kind: "http", url: "https://mcp.notion.com/mcp" },
      { kind: "stdio", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
    ]);
    expect(catalogEntry("context7")?.transports).toStrictEqual([
      { kind: "http", url: "https://mcp.context7.com/mcp" },
      { kind: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    ]);
  });

  it("flags Gmail as preview-gated with a badge", () => {
    const gmail = catalogEntry("gmail");
    expect(gmail?.badges?.some((b) => /Developer Preview/i.test(b))).toBe(true);
  });

  it("names the fal entry as docs-only, not an execution server", () => {
    const fal = catalogEntry("fal-docs");
    expect(fal?.name).toBe("fal Docs");
    expect(fal?.transports).toStrictEqual([{ kind: "http", url: "https://fal.ai/docs/mcp" }]);
  });
});
