// The curated connections catalog (#64, Phase 4 slice 4). Every entry below was
// verified against vendor documentation on 2026-08-20: the endpoint or command,
// the transport, the auth requirement, and the provenance. Nothing here is
// invented — a server with no trustworthy official implementation is left out
// rather than guessed at (see the PR body for the deliberate gaps: fal has no
// official execution server, and Gmail's official server is preview-gated while
// the community one was archived).
//
// These are DISPLAY entries. Adding one mints an AgentConnection the user can
// then install into a CLI's own MCP config through the guarded KödHarness review
// flow. Ködade never stores a credential — `authNote` only tells the user what
// to set up in their own CLI config or keychain (BYOK).

import type { ConnectionTransport } from "./connection";

// Provenance of a catalog entry — either the vendor's own server or a Model
// Context Protocol reference implementation. Rendered next to each entry so the
// user can judge trust before installing.
export type ConnectionProvenance = "official vendor" | "MCP reference implementation";

export type ConnectionCatalogEntry = {
  // Stable ASCII id (also the key the connection is minted against).
  id: string;
  // Vendor/display name.
  name: string;
  // The ASCII server key written into a CLI's MCP config on install. Bare key —
  // no dots or whitespace — so it is a legal name in JSON and TOML alike.
  serverName: string;
  // One-line description of what the server does.
  summary: string;
  // Available transports, primary first. An entry may offer a remote endpoint, a
  // local stdio command, or both.
  transports: ConnectionTransport[];
  // Display-only auth requirement (env var names, OAuth notes). BYOK — Ködade
  // never collects the credential itself.
  authNote: string;
  provenance: ConnectionProvenance;
  // The vendor/reference documentation this entry was verified against.
  docsUrl: string;
  // Optional caveats surfaced as badges (e.g. a developer-preview warning).
  badges?: string[];
};

export const CONNECTIONS_CATALOG: ConnectionCatalogEntry[] = [
  {
    id: "vidiq",
    name: "vidIQ",
    serverName: "vidiq",
    summary: "Read-only YouTube channel research and analytics from your vidIQ account.",
    transports: [{ kind: "http", url: "https://mcp.vidiq.com/mcp" }],
    authNote:
      "OAuth 2.0 browser flow, or an API key from your vidIQ account settings " +
      "(app.vidiq.com/account/settings/mcp). Plan/credit-dependent.",
    provenance: "official vendor",
    docsUrl: "https://vidiq.com/mcp/",
  },
  {
    id: "fal-docs",
    name: "fal Docs",
    serverName: "fal-docs",
    summary: "Search fal.ai documentation. Docs search only — not a model-execution server.",
    transports: [{ kind: "http", url: "https://fal.ai/docs/mcp" }],
    authNote: "No authentication — documentation search only.",
    provenance: "official vendor",
    docsUrl: "https://fal.ai/docs/mcp",
  },
  {
    id: "gmail",
    name: "Gmail",
    serverName: "gmail",
    summary: "Google's official Gmail MCP server.",
    transports: [{ kind: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" }],
    authNote:
      "Bring your own GCP OAuth client. Ködade never handles the credential; " +
      "you enroll and configure it yourself.",
    provenance: "official vendor",
    docsUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
    badges: [
      "Google Workspace Developer Preview — requires enrollment and your own GCP OAuth client",
    ],
  },
  {
    id: "github",
    name: "GitHub",
    serverName: "github",
    summary: "GitHub's official MCP server for repositories, issues, and pull requests.",
    transports: [{ kind: "http", url: "https://api.githubcopilot.com/mcp/" }],
    authNote:
      "OAuth, or a personal access token (GITHUB_PERSONAL_ACCESS_TOKEN) you set " +
      "in your own CLI config.",
    provenance: "official vendor",
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "notion",
    name: "Notion",
    serverName: "notion",
    summary: "Notion's official MCP server for pages, databases, and search.",
    transports: [
      { kind: "http", url: "https://mcp.notion.com/mcp" },
      { kind: "stdio", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] },
    ],
    authNote:
      "OAuth on the remote endpoint; a NOTION_TOKEN (set in your own environment) " +
      "for the local stdio server.",
    provenance: "official vendor",
    docsUrl: "https://github.com/makenotion/notion-mcp-server",
  },
  {
    id: "context7",
    name: "Context7",
    serverName: "context7",
    summary: "Up-to-date library and framework documentation for coding tasks.",
    transports: [
      { kind: "http", url: "https://mcp.context7.com/mcp" },
      { kind: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    ],
    authNote: "Optional API key; works keyless with rate limits.",
    provenance: "official vendor",
    docsUrl: "https://github.com/upstash/context7",
  },
  {
    id: "playwright",
    name: "Playwright",
    serverName: "playwright",
    summary: "Microsoft's Playwright MCP server for browser automation.",
    transports: [{ kind: "stdio", command: "npx", args: ["@playwright/mcp@latest"] }],
    authNote: "No authentication.",
    provenance: "official vendor",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    serverName: "filesystem",
    summary: "Read and write files under directories you explicitly allow.",
    transports: [
      { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
    ],
    authNote:
      "No authentication. Access is scoped by the directory arguments — append " +
      "one or more directory paths before use, or it exposes nothing.",
    provenance: "MCP reference implementation",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "fetch",
    name: "Fetch",
    serverName: "fetch",
    summary: "Fetch a URL and return its content as text for the model to read.",
    transports: [{ kind: "stdio", command: "uvx", args: ["mcp-server-fetch"] }],
    authNote: "No authentication.",
    provenance: "MCP reference implementation",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
];

// Look up a catalog entry by id, or undefined when it isn't one Ködade ships.
export function catalogEntry(id: string): ConnectionCatalogEntry | undefined {
  return CONNECTIONS_CATALOG.find((entry) => entry.id === id);
}
