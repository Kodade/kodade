// Adapter tests: detect() resolves the right absolute locations for mac AND
// windows path shapes, and scan() drives a fixture ConfigIpc through the pure
// scanners. Uses the MockConfig stub, exercising the same seam the real app uses.

import { describe, expect, it } from "vitest";
import { MockConfig } from "../../ipc/mock";
import type { ConfigScan, FileRead } from "../../ipc/contract";
import type { ConfigDirEntry } from "../../ipc/contract";
import type { HarnessArtifact, ScanContext } from "../model";
import { scanInventory } from "../scan";
import { createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { createGrokAdapter } from "./grok";
import { createOpencodeAdapter } from "./opencode";

const MAC: ScanContext = {
  home: "/Users/keith",
  platform: "mac",
  projectRoot: "/Users/keith/proj",
};

const WINDOWS: ScanContext = {
  home: "C:\\Users\\Keith",
  platform: "windows",
  projectRoot: "C:\\Users\\Keith\\proj",
  appDataRoaming: "C:\\Users\\Keith\\AppData\\Roaming",
  appDataLocal: "C:\\Users\\Keith\\AppData\\Local",
};

// A non-ASCII Windows username fixture (M10g): the harness must resolve
// paths built from whatever the real home/AppData roots are, never assume
// ASCII — nativeJoin and the template resolution are string-only, so a
// unicode username exercises the same code path as a plain one.
const WINDOWS_NON_ASCII: ScanContext = {
  home: "C:\\Users\\Keïth",
  platform: "windows",
  projectRoot: "C:\\Users\\Keïth\\proj",
  appDataRoaming: "C:\\Users\\Keïth\\AppData\\Roaming",
  appDataLocal: "C:\\Users\\Keïth\\AppData\\Local",
};

describe("claude adapter detect()", () => {
  it("resolves mac paths for the project scope", async () => {
    const adapter = createClaudeAdapter(new MockConfig());
    const locations = await adapter.detect("project", MAC);
    const byKind = Object.fromEntries(locations.map((l) => [`${l.kind}:${l.path}`, l]));

    expect(locations.map((l) => l.path)).toEqual([
      "/Users/keith/proj/CLAUDE.md",
      "/Users/keith/proj/.claude/skills",
      "/Users/keith/proj/.claude/agents",
      "/Users/keith/proj/.mcp.json",
    ]);
    expect(byKind["mcp-server:/Users/keith/proj/.mcp.json"]).toMatchObject({
      container: "file",
      format: "json",
      mcpKeyPath: "mcpServers",
    });
  });

  it("resolves windows paths with backslash separators", async () => {
    const adapter = createClaudeAdapter(new MockConfig());
    const project = await adapter.detect("project", WINDOWS);
    expect(project.map((l) => l.path)).toEqual([
      "C:\\Users\\Keith\\proj\\CLAUDE.md",
      "C:\\Users\\Keith\\proj\\.claude\\skills",
      "C:\\Users\\Keith\\proj\\.claude\\agents",
      "C:\\Users\\Keith\\proj\\.mcp.json",
    ]);

    const global = await adapter.detect("global", WINDOWS);
    expect(global.map((l) => l.path)).toEqual([
      "C:\\Users\\Keith\\.claude\\CLAUDE.md",
      "C:\\Users\\Keith\\.claude\\skills",
      "C:\\Users\\Keith\\.claude\\agents",
      "C:\\Users\\Keith\\.claude.json",
    ]);
  });
});

describe("codex adapter detect()", () => {
  it("resolves AGENTS.md instructions and the global config.toml mcp location", async () => {
    const adapter = createCodexAdapter(new MockConfig());
    const project = await adapter.detect("project", MAC);
    expect(project.map((l) => `${l.kind}:${l.path}`)).toEqual([
      "instruction:/Users/keith/proj/AGENTS.md",
      "skill:/Users/keith/proj/.agents/skills",
    ]);

    const global = await adapter.detect("global", MAC);
    expect(global.map((l) => `${l.kind}:${l.path}`)).toEqual([
      "instruction:/Users/keith/.codex/AGENTS.md",
      "skill:/Users/keith/.agents/skills",
      "skill:/Users/keith/.codex/skills",
      "mcp-server:/Users/keith/.codex/config.toml",
    ]);
  });

  it("stays home-relative on Windows — Codex CLI does not use %APPDATA% (M10g)", async () => {
    // Unlike opencode, Codex CLI is documented as using %USERPROFILE%\.codex
    // (home-relative) on Windows too, so this adapter's templates carry no
    // `windows` override — confirm that holds and %APPDATA% is never consulted.
    const adapter = createCodexAdapter(new MockConfig());
    const global = await adapter.detect("global", WINDOWS);
    expect(global.map((l) => l.path)).toEqual([
      "C:\\Users\\Keith\\.codex\\AGENTS.md",
      "C:\\Users\\Keith\\.agents\\skills",
      "C:\\Users\\Keith\\.codex\\skills",
      "C:\\Users\\Keith\\.codex\\config.toml",
    ]);
  });
});

describe("grok adapter detect()", () => {
  it("resolves shared project instructions and Grok Build compatible skill roots (mac)", async () => {
    const adapter = createGrokAdapter(new MockConfig());
    const project = await adapter.detect("project", MAC);
    expect(project.map((l) => `${l.kind}:${l.path}`)).toEqual([
      "instruction:/Users/keith/proj/AGENTS.md",
      "instruction:/Users/keith/proj/GROK.md",
      "skill:/Users/keith/proj/.grok/skills",
      "skill:/Users/keith/proj/.claude/skills",
    ]);

    const global = await adapter.detect("global", MAC);
    expect(global.map((l) => `${l.kind}:${l.path}`)).toEqual([
      "instruction:/Users/keith/.grok/GROK.md",
      "skill:/Users/keith/.grok/skills",
      "skill:/Users/keith/.claude/skills",
      "skill:/Users/keith/.agents/skills",
      "mcp-server:/Users/keith/.grok/config.toml",
    ]);
  });

  it("resolves windows paths with backslash separators", async () => {
    const adapter = createGrokAdapter(new MockConfig());
    const global = await adapter.detect("global", WINDOWS);
    expect(global.map((l) => l.path)).toEqual([
      "C:\\Users\\Keith\\.grok\\GROK.md",
      "C:\\Users\\Keith\\.grok\\skills",
      "C:\\Users\\Keith\\.claude\\skills",
      "C:\\Users\\Keith\\.agents\\skills",
      "C:\\Users\\Keith\\.grok\\config.toml",
    ]);
  });

  it("scans a present GROK.md into an instruction artifact", async () => {
    const config = new MockConfig();
    config.reads.set("/Users/keith/proj/GROK.md", { kind: "text", content: "hi\n" });
    const adapter = createGrokAdapter(config);
    const inventory = await scanInventory([adapter], "project", MAC, () => 1);
    expect(inventory.artifacts).toEqual([
      expect.objectContaining({ cli: "grok", kind: "instruction", name: "GROK.md" }),
    ]);
  });
});

describe("opencode adapter detect()", () => {
  it("resolves AGENTS.md + opencode.json mcp locations (mac)", async () => {
    const adapter = createOpencodeAdapter(new MockConfig());
    const project = await adapter.detect("project", MAC);
    expect(project.map((l) => `${l.kind}:${l.path}`)).toEqual([
      "instruction:/Users/keith/proj/AGENTS.md",
      "skill:/Users/keith/proj/.opencode/skills",
      "skill:/Users/keith/proj/.claude/skills",
      "skill:/Users/keith/proj/.agents/skills",
      "mcp-server:/Users/keith/proj/opencode.json",
    ]);

    const global = await adapter.detect("global", MAC);
    expect(global.map((l) => `${l.kind}:${l.path}`)).toEqual([
      "instruction:/Users/keith/.config/opencode/AGENTS.md",
      "skill:/Users/keith/.config/opencode/skills",
      "skill:/Users/keith/.claude/skills",
      "skill:/Users/keith/.agents/skills",
      "mcp-server:/Users/keith/.config/opencode/opencode.json",
    ]);
  });

  it("stays home-relative on Windows — opencode's config is ~/.config, not %APPDATA% (M10g)", async () => {
    // opencode resolves its global config root via `xdg-basedir@5.1.0`'s
    // `xdgConfig` (`XDG_CONFIG_HOME || os.homedir()/.config`) — no win32
    // branch — so on Windows it lands at `%USERPROFILE%\.config\opencode`,
    // home-relative like every other CLI. %APPDATA% is never consulted.
    const adapter = createOpencodeAdapter(new MockConfig());
    const global = await adapter.detect("global", WINDOWS);
    expect(global.map((l) => l.path)).toEqual([
      "C:\\Users\\Keith\\.config\\opencode\\AGENTS.md",
      "C:\\Users\\Keith\\.config\\opencode\\skills",
      "C:\\Users\\Keith\\.claude\\skills",
      "C:\\Users\\Keith\\.agents\\skills",
      "C:\\Users\\Keith\\.config\\opencode\\opencode.json",
    ]);
  });

  it("resolves the Windows global config for a non-ASCII username (M10g)", async () => {
    const adapter = createOpencodeAdapter(new MockConfig());
    const global = await adapter.detect("global", WINDOWS_NON_ASCII);
    expect(global.map((l) => l.path)).toEqual([
      "C:\\Users\\Keïth\\.config\\opencode\\AGENTS.md",
      "C:\\Users\\Keïth\\.config\\opencode\\skills",
      "C:\\Users\\Keïth\\.claude\\skills",
      "C:\\Users\\Keïth\\.agents\\skills",
      "C:\\Users\\Keïth\\.config\\opencode\\opencode.json",
    ]);
  });

  it("project scope stays project-relative on Windows", async () => {
    const adapter = createOpencodeAdapter(new MockConfig());
    const project = await adapter.detect("project", WINDOWS);
    expect(project.map((l) => l.path)).toEqual([
      "C:\\Users\\Keith\\proj\\AGENTS.md",
      "C:\\Users\\Keith\\proj\\.opencode\\skills",
      "C:\\Users\\Keith\\proj\\.claude\\skills",
      "C:\\Users\\Keith\\proj\\.agents\\skills",
      "C:\\Users\\Keith\\proj\\opencode.json",
    ]);
  });

  it("scans the 'mcp' key out of opencode.json", async () => {
    const config = new MockConfig();
    config.reads.set(
      "/Users/keith/proj/opencode.json",
      { kind: "text", content: JSON.stringify({ mcp: { bridgememory: { command: "kodade-mcp" } } }) },
    );
    const adapter = createOpencodeAdapter(config);
    const inventory = await scanInventory([adapter], "project", MAC, () => 1);
    expect(inventory.artifacts).toEqual([
      expect.objectContaining({ cli: "opencode", kind: "mcp-server", name: "bridgememory" }),
    ]);
  });

  it("a shared project AGENTS.md is read by both codex and opencode", async () => {
    const config = new MockConfig();
    config.reads.set("/Users/keith/proj/AGENTS.md", { kind: "text", content: "shared\n" });
    const codex = createCodexAdapter(config);
    const opencode = createOpencodeAdapter(config);
    const inventory = await scanInventory([codex, opencode], "project", MAC, () => 1);
    expect(inventory.artifacts.map((a) => `${a.cli}:${a.path}`)).toEqual([
      "codex:/Users/keith/proj/AGENTS.md",
      "opencode:/Users/keith/proj/AGENTS.md",
    ]);
  });
});

describe("adapter scan() over a fixture ConfigIpc", () => {
  it("links managed copies through their provenance marker", async () => {
    const config = new MockConfig();
    const markerPath = "/Users/keith/proj/.claude/skills/code-review/.kodade-skill.json";
    config.scans.set("/Users/keith/proj/.claude/skills", {
      status: "listing",
      root: "/Users/keith/proj/.claude/skills",
      entries: [
        {
          name: "code-review",
          path: "/Users/keith/proj/.claude/skills/code-review",
          isDir: true,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: [
            {
              name: "SKILL.md",
              path: "/Users/keith/proj/.claude/skills/code-review/SKILL.md",
              isDir: false,
              isSymlink: false,
              target: null,
              orphaned: false,
              children: null,
            },
            {
              name: ".kodade-skill.json",
              path: markerPath,
              isDir: false,
              isSymlink: false,
              target: null,
              orphaned: false,
              children: null,
            },
          ],
        },
      ],
    });
    config.reads.set(markerPath, {
      kind: "text",
      content: JSON.stringify({
        schemaVersion: 1,
        managedBy: "kodade",
        skillId: "code-review",
        sourceHash: "abc123",
        files: [{ path: "SKILL.md", sha256: "aaa" }],
      }),
    });

    const inventory = await scanInventory(
      [createClaudeAdapter(config)],
      "project",
      MAC,
      () => 1,
    );

    expect(inventory.artifacts).toEqual([
      expect.objectContaining({ canonicalGroupId: "project-skill:code-review:abc123" }),
    ]);
  });

  it("produces a full inventory across instructions, skills, and mcp", async () => {
    const config = new MockConfig();

    // Project CLAUDE.md present; project skills dir with one real + one disabled;
    // .mcp.json with one server. Global skills dir is unreadable (permission).
    config.reads.set("/Users/keith/proj/CLAUDE.md", {
      kind: "text",
      content: "line one\nline two\n",
    } satisfies FileRead);

    const projectSkills: ConfigScan = {
      status: "listing",
      root: "/Users/keith/proj/.claude/skills",
      entries: [
        {
          name: "code-review",
          path: "/Users/keith/proj/.claude/skills/code-review",
          isDir: true,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: [
            {
              name: "SKILL.md",
              path: "/Users/keith/proj/.claude/skills/code-review/SKILL.md",
              isDir: false,
              isSymlink: false,
              target: null,
              orphaned: false,
              children: null,
            },
          ],
        },
        {
          name: "wip.disabled",
          path: "/Users/keith/proj/.claude/skills/wip.disabled",
          isDir: true,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: null,
        },
      ],
    };
    config.scans.set("/Users/keith/proj/.claude/skills", projectSkills);

    config.reads.set("/Users/keith/proj/.mcp.json", {
      kind: "text",
      content: JSON.stringify({ mcpServers: { bridgememory: { command: "kodade-mcp" } } }),
    } satisfies FileRead);

    // Global-scope claude locations for a second detect pass — mark the global
    // skills dir unreadable to assert the error reaches the inventory.
    config.scans.set("/Users/keith/.claude/skills", {
      status: "unreadable",
      root: "/Users/keith/.claude/skills",
      error: "permission denied",
    });

    const claude = createClaudeAdapter(config);
    const inventory = await scanInventory([claude], "project", MAC, () => 999);

    expect(inventory.scannedAt).toBe(999);
    const names = inventory.artifacts.map((a) => `${a.kind}:${a.name}:${a.enabled}`);
    expect(names).toEqual([
      "instruction:CLAUDE.md:true",
      "skill:code-review:true",
      "skill:wip:false",
      "mcp-server:bridgememory:true",
    ]);
    // No project-scope errors; the AGENTS.md-less project just yields no codex rows.
    expect(inventory.errors).toEqual([]);

    // A global pass surfaces the unreadable skills dir as an inventory error.
    const globalInventory = await scanInventory([claude], "global", MAC, () => 1000);
    expect(globalInventory.errors).toEqual([
      {
        cli: "claude",
        scope: "global",
        kind: "skill",
        path: "/Users/keith/.claude/skills",
        message: "permission denied",
      },
    ]);
  });

  it("treats missing files and dirs as empty without erroring", async () => {
    const config = new MockConfig(); // everything missing by default
    const claude = createClaudeAdapter(config);
    const inventory = await scanInventory([claude], "project", MAC, () => 0);
    expect(inventory.artifacts).toEqual([]);
    expect(inventory.errors).toEqual([]);
  });
});

// --- M10d: skills/subagents enable-disable mutation path ---

describe("adapter mutation (M10d skills enable/disable)", () => {
  const ROOT = "/Users/keith/proj";
  const SKILLS = "/Users/keith/proj/.claude/skills";

  function dirEntry(name: string, children: ConfigDirEntry[] = []): ConfigDirEntry {
    return {
      name,
      path: `${SKILLS}/${name}`,
      isDir: true,
      isSymlink: false,
      target: null,
      orphaned: false,
      children,
    };
  }

  function skillArtifact(overrides: Partial<HarnessArtifact> = {}): HarnessArtifact {
    return {
      id: "claude:project:skill:code-review",
      cli: "claude",
      scope: "project",
      kind: "skill",
      name: "code-review",
      path: `${SKILLS}/code-review`,
      source: { via: "dir" },
      enabled: true,
      status: "ok",
      detail: { kind: "skill", manifestPath: `${SKILLS}/code-review/SKILL.md` },
      ...overrides,
    };
  }

  it("plan → apply → verify → restore round-trips a dir skill disable", async () => {
    const config = new MockConfig();
    config.scans.set(SKILLS, {
      status: "listing",
      root: SKILLS,
      entries: [dirEntry("code-review")],
    });
    const adapter = createClaudeAdapter(config);
    const artifact = skillArtifact();

    const change = await adapter.plan({
      artifactId: artifact.id,
      action: "disable",
      projectRoot: ROOT,
      artifact,
    });
    expect(change).toMatchObject({
      format: "dir-rename",
      before: `${SKILLS}/code-review`,
      after: `${SKILLS}/code-review.disabled`,
      backupPath: "",
      projectRoot: ROOT,
    });

    const receipt = await adapter.apply(change);
    expect(config.renameCalls).toEqual([
      { path: `${SKILLS}/code-review`, newPath: `${SKILLS}/code-review.disabled`, projectRoot: ROOT },
    ]);
    expect(receipt.hash).toBe(""); // a directory carries no byte fingerprint

    expect(await adapter.verify(receipt)).toEqual({ ok: true });

    await adapter.restore(receipt);
    expect(config.renameCalls[1]).toEqual({
      path: `${SKILLS}/code-review.disabled`,
      newPath: `${SKILLS}/code-review`,
      projectRoot: ROOT,
    });
  });

  it("verifies a single-file skill by content fingerprint, failing on tamper", async () => {
    const config = new MockConfig();
    const path = `${SKILLS}/solo.md`;
    config.scans.set(SKILLS, {
      status: "listing",
      root: SKILLS,
      entries: [
        { name: "solo.md", path, isDir: false, isSymlink: false, target: null, orphaned: false, children: null },
      ],
    });
    config.reads.set(path, { kind: "text", content: "# solo skill\n" });
    const adapter = createClaudeAdapter(config);
    const artifact = skillArtifact({
      id: "claude:project:skill:solo",
      name: "solo",
      path,
      source: { via: "file" },
      detail: { kind: "skill", manifestPath: path },
    });

    const change = await adapter.plan({
      artifactId: artifact.id,
      action: "disable",
      projectRoot: ROOT,
      artifact,
    });
    const receipt = await adapter.apply(change);
    expect(receipt.hash).not.toBe(""); // a file carries a byte fingerprint
    expect(await adapter.verify(receipt)).toEqual({ ok: true });

    // Tamper the renamed file's bytes: the fingerprint no longer matches.
    config.reads.set(`${path}.disabled`, { kind: "text", content: "tampered" });
    const tampered = await adapter.verify(receipt);
    expect(tampered.ok).toBe(false);
  });

  it("toggles a symlinked skill via the LINK path, never the target", async () => {
    const config = new MockConfig();
    const link = `${SKILLS}/x-post`;
    config.scans.set(SKILLS, {
      status: "listing",
      root: SKILLS,
      entries: [
        {
          name: "x-post",
          path: link,
          isDir: true,
          isSymlink: true,
          target: "/dotfiles/skills/x-post",
          orphaned: false,
          children: [],
        },
      ],
    });
    const adapter = createClaudeAdapter(config);
    const artifact = skillArtifact({
      id: "claude:project:skill:x-post",
      name: "x-post",
      path: link,
      source: { via: "symlink", target: "/dotfiles/skills/x-post" },
    });

    const change = await adapter.plan({
      artifactId: artifact.id,
      action: "disable",
      projectRoot: ROOT,
      artifact,
    });
    expect(change.before).toBe(link); // the link entry, not the dotfiles target
    const receipt = await adapter.apply(change);
    expect(config.renameCalls[0]).toEqual({
      path: link,
      newPath: `${link}.disabled`,
      projectRoot: ROOT,
    });
    expect(await adapter.verify(receipt)).toEqual({ ok: true });
  });

  it("verify fails when the rescan doesn't show the rename landing", async () => {
    const config = new MockConfig();
    // The scan reports an empty skills dir, so the renamed entry is never found.
    config.scans.set(SKILLS, { status: "listing", root: SKILLS, entries: [] });
    const adapter = createClaudeAdapter(config);
    const artifact = skillArtifact();

    const change = await adapter.plan({
      artifactId: artifact.id,
      action: "disable",
      projectRoot: ROOT,
      artifact,
    });
    const receipt = await adapter.apply(change);
    const result = await adapter.verify(receipt);
    expect(result.ok).toBe(false);
  });

  it("plan refuses toggling a non-skill kind, and structured actions need a payload", async () => {
    const adapter = createClaudeAdapter(new MockConfig());
    const instruction = skillArtifact({ kind: "instruction", name: "CLAUDE.md" });
    await expect(
      adapter.plan({ artifactId: instruction.id, action: "disable", projectRoot: ROOT, artifact: instruction }),
    ).rejects.toThrow(/only skills and subagents/);
    // M10e structured actions are implemented now — with no payload they reject
    // on the missing input, not on "not implemented".
    await expect(
      adapter.plan({ artifactId: "x", action: "add-mcp-server", projectRoot: ROOT }),
    ).rejects.toThrow(/payload/);
    await expect(
      adapter.plan({ artifactId: "x", action: "edit", projectRoot: ROOT }),
    ).rejects.toThrow(/payload/);
  });
});

// --- M10e: instruction editing + MCP safe merge through the adapter ---

describe("adapter mutation (M10e MCP safe merge)", () => {
  const ROOT = "/Users/keith/proj";
  const MCP = `${ROOT}/.mcp.json`;

  it("plan → apply → verify → restore round-trips an add into an existing config", async () => {
    const config = new MockConfig();
    const before = '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n';
    config.reads.set(MCP, { kind: "text", content: before });
    const adapter = createClaudeAdapter(config);

    const change = await adapter.plan({
      artifactId: "claude:add-mcp:bridgememory",
      action: "add-mcp-server",
      projectRoot: ROOT,
      payload: {
        path: MCP,
        format: "json",
        keyPath: "mcpServers",
        server: { name: "bridgememory", config: { command: "kodade-mcp" } },
      },
    });

    expect(change.format).toBe("json");
    expect(change.touchedKeys).toEqual(["mcpServers.bridgememory"]);
    expect(change.isNewFile).toBe(false);
    expect(change.expectedHash).toMatch(/^[0-9a-f]{64}$/); // sha-256 of prior bytes
    expect(change.after).toContain('"github": { "command": "gh-mcp" }'); // neighbor kept

    const receipt = await adapter.apply(change);
    expect(config.writeCalls[0]).toMatchObject({
      path: MCP,
      contents: change.after,
      expectedHash: change.expectedHash,
      projectRoot: ROOT,
    });
    expect(receipt.backupPath).not.toBe("");

    expect(await adapter.verify(receipt)).toEqual({ ok: true });

    await adapter.restore(receipt);
    expect(config.restoreCalls[0]).toMatchObject({ path: MCP, projectRoot: ROOT });
  });

  it("creates a new config file and removes its exact bytes on rollback", async () => {
    const config = new MockConfig(); // MCP absent → new file
    const adapter = createClaudeAdapter(config);

    const change = await adapter.plan({
      artifactId: "claude:add-mcp:bridgememory",
      action: "add-mcp-server",
      projectRoot: ROOT,
      payload: {
        path: MCP,
        format: "json",
        keyPath: "mcpServers",
        server: { name: "bridgememory", config: { command: "kodade-mcp" } },
      },
    });
    expect(change.isNewFile).toBe(true);
    expect(change.expectedHash).toBe("");

    const receipt = await adapter.apply(change);
    expect(receipt.backupPath).toBe(""); // nothing to back up
    expect(await adapter.verify(receipt)).toEqual({ ok: true });
    await adapter.restore(receipt);
    expect(config.removeFileCalls).toEqual([
      expect.objectContaining({ path: MCP, projectRoot: ROOT }),
    ]);
    expect(config.reads.has(MCP)).toBe(false);
  });

  it("plan surfaces a corrupt-config abort before any write", async () => {
    const config = new MockConfig();
    config.reads.set(MCP, { kind: "text", content: '{ "mcpServers": { "x": } }' });
    const adapter = createClaudeAdapter(config);
    await expect(
      adapter.plan({
        artifactId: "claude:add-mcp:new",
        action: "add-mcp-server",
        projectRoot: ROOT,
        payload: {
          path: MCP,
          format: "jsonc",
          keyPath: "mcpServers",
          server: { name: "new", config: { command: "x" } },
        },
      }),
    ).rejects.toThrow(/not valid/);
    expect(config.writeCalls).toEqual([]); // plan never writes
  });

  it("verify fails when the written bytes don't match, so the store can restore", async () => {
    const config = new MockConfig();
    config.reads.set(MCP, { kind: "text", content: '{ "mcpServers": {} }' });
    const adapter = createClaudeAdapter(config);
    const change = await adapter.plan({
      artifactId: "claude:add-mcp:svc",
      action: "add-mcp-server",
      projectRoot: ROOT,
      payload: {
        path: MCP,
        format: "json",
        keyPath: "mcpServers",
        server: { name: "svc", config: { command: "svc-mcp" } },
      },
    });
    const receipt = await adapter.apply(change);
    // Something else clobbers the file after the write.
    config.reads.set(MCP, { kind: "text", content: "tampered" });
    const result = await adapter.verify(receipt);
    expect(result.ok).toBe(false);
  });
});

describe("adapter mutation (M10e instruction editing)", () => {
  const ROOT = "/Users/keith/proj";
  const CLAUDE = `${ROOT}/CLAUDE.md`;

  function instructionArtifact(): HarnessArtifact {
    return {
      id: "claude:project:instruction:CLAUDE.md",
      cli: "claude",
      scope: "project",
      kind: "instruction",
      name: "CLAUDE.md",
      path: CLAUDE,
      source: { via: "file" },
      enabled: true,
      status: "ok",
      detail: { kind: "instruction", lines: 1, bytes: 6 },
    };
  }

  it("plan → apply → verify writes the new text with an optimistic hash", async () => {
    const config = new MockConfig();
    config.reads.set(CLAUDE, { kind: "text", content: "old\n" });
    const adapter = createClaudeAdapter(config);
    const artifact = instructionArtifact();

    const change = await adapter.plan({
      artifactId: artifact.id,
      action: "edit",
      projectRoot: ROOT,
      artifact,
      payload: { path: CLAUDE, newText: "new content\n" },
    });
    expect(change.format).toBe("markdown");
    expect(change.before).toBe("old\n");
    expect(change.after).toBe("new content\n");
    expect(change.expectedHash).toMatch(/^[0-9a-f]{64}$/);

    const receipt = await adapter.apply(change);
    expect(config.writeCalls[0]).toMatchObject({ path: CLAUDE, contents: "new content\n" });
    expect(await adapter.verify(receipt)).toEqual({ ok: true });
  });

  it("refuses a no-op edit", async () => {
    const config = new MockConfig();
    config.reads.set(CLAUDE, { kind: "text", content: "same\n" });
    const adapter = createClaudeAdapter(config);
    await expect(
      adapter.plan({
        artifactId: "claude:project:instruction:CLAUDE.md",
        action: "edit",
        projectRoot: ROOT,
        payload: { path: CLAUDE, newText: "same\n" },
      }),
    ).rejects.toThrow(/no changes/);
  });
});

describe("adapter mutation (M15 KödSkills directories)", () => {
  const ROOT = "/Users/keith/proj";
  const TARGET = "/Users/keith/.claude/skills/code-review";
  const files = [
    { path: "SKILL.md", contents: "review", sha256: "skill-hash" },
    { path: ".kodskills.json", contents: "{}", sha256: "marker-hash" },
  ];

  it("plan → apply → verify → restore round-trips install and uninstall", async () => {
    const config = new MockConfig();
    const adapter = createClaudeAdapter(config);
    const install = await adapter.plan({
      artifactId: "claude:global:skill:code-review",
      action: "install-skill",
      projectRoot: ROOT,
      payload: {
        skillId: "code-review",
        targetPath: TARGET,
        operation: "install",
        files,
        expectedFiles: null,
      },
    });
    expect(install).toMatchObject({ format: "skill-dir", skillOperation: "install" });
    const installReceipt = await adapter.apply(install);
    expect(await adapter.verify(installReceipt)).toEqual({ ok: true });
    await adapter.restore(installReceipt);
    expect(config.removeDirCalls[0]).toMatchObject({ path: TARGET, keepBackup: false });
    expect((await config.dirSnapshot(TARGET, ROOT)).status).toBe("missing");

    const expectedFiles = files.map(({ path, sha256 }) => ({ path, sha256 }));
    config.dirSnapshots.set(TARGET, { status: "snapshot", path: TARGET, files: expectedFiles });
    const remove = await adapter.plan({
      artifactId: "claude:global:skill:code-review",
      action: "remove-skill",
      projectRoot: ROOT,
      payload: {
        skillId: "code-review",
        targetPath: TARGET,
        operation: "remove",
        expectedFiles,
      },
    });
    const removeReceipt = await adapter.apply(remove);
    expect(await adapter.verify(removeReceipt)).toEqual({ ok: true });
    await adapter.restore(removeReceipt);
    expect(config.restoreDirCalls[0]).toMatchObject({
      path: TARGET,
      backupPath: `${TARGET}.kodade-bak-mock`,
      expectedFiles: null,
      projectRoot: ROOT,
    });
    expect((await config.dirSnapshot(TARGET, ROOT)).status).toBe("snapshot");
  });
});
