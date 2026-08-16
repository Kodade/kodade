// Headless scan tests: replay raw config listings (ConfigScan/FileRead) through
// the pure scanners and assert the resulting HarnessInventory. No Tauri, no
// React — exactly the M10a "done" bar.

import { describe, expect, it } from "vitest";
import type { ConfigDirEntry, ConfigScan, FileRead } from "../ipc/contract";
import type { ArtifactLocation } from "./contract";
import {
  buildInventory,
  scanInstruction,
  scanMcp,
  scanSkills,
  scanSubagents,
} from "./scan";

// --- fixtures ---

const ROOT = "/Users/keith/proj";

function skillsLoc(): ArtifactLocation {
  return {
    cli: "claude",
    scope: "project",
    kind: "skill",
    container: "dir",
    path: `${ROOT}/.claude/skills`,
  };
}

function dirEntry(partial: Partial<ConfigDirEntry> & { name: string; path: string }): ConfigDirEntry {
  return {
    isDir: true,
    isSymlink: false,
    target: null,
    orphaned: false,
    children: null,
    ...partial,
  };
}

function manifest(dir: string): ConfigDirEntry[] {
  return [dirEntry({ name: "SKILL.md", path: `${dir}/SKILL.md`, isDir: false })];
}

describe("scanSkills", () => {
  it("models real, symlinked, orphaned, and disabled skills from one listing", () => {
    const loc = skillsLoc();
    const base = loc.path;
    const listing: ConfigScan = {
      status: "listing",
      root: base,
      entries: [
        dirEntry({ name: "code-review", path: `${base}/code-review`, children: manifest(`${base}/code-review`) }),
        dirEntry({
          name: "x-post.disabled",
          path: `${base}/x-post.disabled`,
          children: manifest(`${base}/x-post.disabled`),
        }),
        // A dotfiles-symlinked skill dir: source is the link, target resolved.
        dirEntry({
          name: "orchestration",
          path: `${base}/orchestration`,
          isSymlink: true,
          target: "/Users/keith/dotfiles/skills/orchestration",
          children: manifest("/Users/keith/dotfiles/skills/orchestration"),
        }),
        // A broken dotfiles link: target gone, so it resolves to a non-dir.
        dirEntry({
          name: "stale",
          path: `${base}/stale`,
          isDir: false,
          isSymlink: true,
          target: "/Users/keith/dotfiles/skills/stale",
          orphaned: true,
        }),
        // Editor cruft is skipped, never surfaced as a skill.
        dirEntry({ name: ".DS_Store", path: `${base}/.DS_Store`, isDir: false }),
      ],
    };

    const { artifacts, error } = scanSkills(loc, listing);
    expect(error).toBeNull();
    expect(artifacts.map((a) => a.name)).toEqual(["code-review", "x-post", "orchestration", "stale"]);

    const byName = Object.fromEntries(artifacts.map((a) => [a.name, a]));

    // Real, enabled skill with a resolved manifest.
    expect(byName["code-review"]).toMatchObject({
      id: "claude:project:skill:code-review",
      enabled: true,
      status: "ok",
      source: { via: "dir" },
      detail: { kind: "skill", manifestPath: `${base}/code-review/SKILL.md` },
    });

    // `.disabled` suffix → enabled:false, display name stripped, id uses the
    // stripped name (so re-enabling keeps a stable identity).
    expect(byName["x-post"]).toMatchObject({
      id: "claude:project:skill:x-post",
      enabled: false,
      status: "ok",
      path: `${base}/x-post.disabled`,
    });

    // Symlinked skill: first-class source with the resolved dotfiles target.
    expect(byName["orchestration"].source).toEqual({
      via: "symlink",
      target: "/Users/keith/dotfiles/skills/orchestration",
    });
    expect(byName["orchestration"].status).toBe("ok");

    // Orphaned symlink: explicit status, never a silent empty row.
    expect(byName["stale"]).toMatchObject({
      status: "orphaned-symlink",
      source: { via: "symlink", target: "/Users/keith/dotfiles/skills/stale" },
      detail: { kind: "skill", manifestPath: null },
    });
  });

  it("returns a per-location error for an unreadable dir, never throwing", () => {
    const loc = skillsLoc();
    const { artifacts, error } = scanSkills(loc, {
      status: "unreadable",
      root: loc.path,
      error: "permission denied",
    });
    expect(artifacts).toEqual([]);
    expect(error).toEqual({
      cli: "claude",
      scope: "project",
      kind: "skill",
      path: loc.path,
      message: "permission denied",
    });
  });

  it("treats a missing skills dir as empty (absence is normal)", () => {
    const loc = skillsLoc();
    expect(scanSkills(loc, { status: "missing", root: loc.path })).toEqual({
      artifacts: [],
      error: null,
    });
  });
});

describe("scanSubagents", () => {
  it("models flat markdown subagents with disabled and orphaned handling", () => {
    const loc: ArtifactLocation = {
      cli: "claude",
      scope: "global",
      kind: "subagent",
      container: "dir",
      path: "/Users/keith/.claude/agents",
    };
    const base = loc.path;
    const { artifacts, error } = scanSubagents(loc, {
      status: "listing",
      root: base,
      entries: [
        dirEntry({ name: "Explore.md", path: `${base}/Explore.md`, isDir: false }),
        dirEntry({ name: "Planner.md.disabled", path: `${base}/Planner.md.disabled`, isDir: false }),
        dirEntry({
          name: "Linked.md",
          path: `${base}/Linked.md`,
          isDir: false,
          isSymlink: true,
          target: "/Users/keith/dotfiles/agents/Linked.md",
          orphaned: true,
        }),
        // A nested directory is not a subagent.
        dirEntry({ name: "helpers", path: `${base}/helpers` }),
      ],
    });
    expect(error).toBeNull();
    expect(artifacts.map((a) => a.name)).toEqual(["Explore", "Planner", "Linked"]);
    expect(artifacts[0]).toMatchObject({ id: "claude:global:subagent:Explore", enabled: true, status: "ok" });
    expect(artifacts[1].enabled).toBe(false);
    expect(artifacts[2]).toMatchObject({
      status: "orphaned-symlink",
      source: { via: "symlink", target: "/Users/keith/dotfiles/agents/Linked.md" },
    });
  });

  it("models Codex TOML profiles without treating TOML as a universal subagent format", () => {
    const codexLoc: ArtifactLocation = {
      cli: "codex",
      scope: "global",
      kind: "subagent",
      container: "dir",
      path: "/home/tester/.codex/agents",
    };
    const entries = [
      dirEntry({ name: "worker.toml", path: `${codexLoc.path}/worker.toml`, isDir: false }),
      dirEntry({ name: "reviewer.toml.disabled", path: `${codexLoc.path}/reviewer.toml.disabled`, isDir: false }),
    ];

    const codex = scanSubagents(codexLoc, {
      status: "listing",
      root: codexLoc.path,
      entries,
    });
    expect(codex.artifacts.map((artifact) => artifact.name)).toEqual(["worker", "reviewer"]);
    expect(codex.artifacts[1]).toMatchObject({ enabled: false, path: `${codexLoc.path}/reviewer.toml.disabled` });

    const claude = scanSubagents({ ...codexLoc, cli: "claude" }, {
      status: "listing",
      root: codexLoc.path,
      entries,
    });
    expect(claude.artifacts).toEqual([]);
  });
});

describe("scanInstruction", () => {
  const loc: ArtifactLocation = {
    cli: "claude",
    scope: "project",
    kind: "instruction",
    container: "file",
    path: `${ROOT}/CLAUDE.md`,
    format: "markdown",
  };

  it("counts lines for a text instruction file", () => {
    const read: FileRead = { kind: "text", content: "one\ntwo\nthree\n" };
    const { artifacts } = scanInstruction(loc, read);
    expect(artifacts[0]).toMatchObject({
      id: "claude:project:instruction:CLAUDE.md",
      name: "CLAUDE.md",
      status: "ok",
      detail: { kind: "instruction", lines: 3 },
    });
  });

  it("flags a binary instruction file as malformed", () => {
    const { artifacts } = scanInstruction(loc, { kind: "binary", bytes: 12 });
    expect(artifacts[0]).toMatchObject({ status: "malformed", detail: { kind: "instruction", lines: null } });
  });
});

describe("scanMcp", () => {
  it("reads servers out of a .mcp.json (json) file", () => {
    const loc: ArtifactLocation = {
      cli: "claude",
      scope: "project",
      kind: "mcp-server",
      container: "file",
      path: `${ROOT}/.mcp.json`,
      format: "json",
      mcpKeyPath: "mcpServers",
    };
    const content = JSON.stringify({
      mcpServers: {
        bridgememory: { command: "kodade-mcp", args: ["serve"] },
        remote: { url: "https://example.com/mcp", type: "http" },
      },
    });
    const { artifacts } = scanMcp(loc, { kind: "text", content });
    expect(artifacts.map((a) => a.name)).toEqual(["bridgememory", "remote"]);
    expect(artifacts[0]).toMatchObject({
      id: "claude:project:mcp-server:bridgememory",
      detail: { kind: "mcp-server", server: "bridgememory", transport: "stdio", command: "kodade-mcp" },
    });
    expect(artifacts[1].detail).toMatchObject({ transport: "http", command: "https://example.com/mcp" });
  });

  it("enumerates codex config.toml servers by table header", () => {
    const loc: ArtifactLocation = {
      cli: "codex",
      scope: "global",
      kind: "mcp-server",
      container: "file",
      path: "/Users/keith/.codex/config.toml",
      format: "toml",
      mcpKeyPath: "mcp_servers",
    };
    const content = [
      "model = \"gpt-5.6\"",
      "",
      "[mcp_servers.bridgememory]",
      "command = \"kodade-mcp\"",
      "",
      '[mcp_servers."scoped-name"]',
      "command = \"other\"",
    ].join("\n");
    const { artifacts } = scanMcp(loc, { kind: "text", content });
    expect(artifacts.map((a) => a.name)).toEqual(["bridgememory", "scoped-name"]);
    expect(artifacts[0]).toMatchObject({ id: "codex:global:mcp-server:bridgememory", status: "ok" });
  });

  it("surfaces an unparseable json config as one malformed row", () => {
    const loc: ArtifactLocation = {
      cli: "claude",
      scope: "project",
      kind: "mcp-server",
      container: "file",
      path: `${ROOT}/.mcp.json`,
      format: "json",
      mcpKeyPath: "mcpServers",
    };
    const { artifacts } = scanMcp(loc, { kind: "text", content: "{ not valid json" });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ status: "malformed", name: ".mcp.json" });
  });
});

describe("buildInventory", () => {
  it("flattens artifacts and collects per-location errors under one envelope", () => {
    const loc = skillsLoc();
    const ok = scanSkills(loc, {
      status: "listing",
      root: loc.path,
      entries: [dirEntry({ name: "code-review", path: `${loc.path}/code-review`, children: manifest(`${loc.path}/code-review`) })],
    });
    const globalSkills: ArtifactLocation = { ...loc, scope: "global", path: "/Users/keith/.claude/skills" };
    const failed = scanSkills(globalSkills, {
      status: "unreadable",
      root: globalSkills.path,
      error: "permission denied",
    });

    const inventory = buildInventory(1234, [ok, failed]);
    expect(inventory.scannedAt).toBe(1234);
    expect(inventory.artifacts.map((a) => a.id)).toEqual(["claude:project:skill:code-review"]);
    expect(inventory.errors).toHaveLength(1);
    expect(inventory.errors[0].message).toBe("permission denied");
  });
});
