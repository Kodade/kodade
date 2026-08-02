import { describe, expect, it } from "vitest";
import type { ConfigIpc, KodSkillsPackBundle } from "../ipc/contract";
import { MockConfig } from "../ipc/mock";
import type { ScanContext } from "./model";
import {
  buildKodSkillsRequests,
  inspectKodSkills,
  parseKodSkillsBundle,
  resolveKodSkillsTargets,
} from "./kodskills";

const PINNED_SHA = "000087d6fc70e92fc91eb40b89b0c62a67ebc78a";

function bundle(version = "1.0.0"): KodSkillsPackBundle {
  const skill = "---\ndescription: Review a branch diff.\n---\n";
  const agent = "interface:\n  display_name: Code Review\n";
  return {
    manifest: JSON.stringify({
      name: "KödSkills engineering pack",
      id: "kodskills-engineering",
      version,
      description: "A curated engineering workflow.",
      source: "https://github.com/ContractorKeith/skills",
      tag: "v1.0.0",
      sha: PINNED_SHA,
      skills: [
        {
          id: "code-review",
          dir: "code-review",
          description: "Review a branch diff.",
          files: [
            {
              path: "SKILL.md",
              sha256: "dabf81ba0fa2b523fb9e007377786b316c5a3d0ac7df47d1f489e7b956aad542",
            },
            {
              path: "agents/openai.yaml",
              sha256: "6676d79ab8f6475f6a0f7cb34415c9636a96abd9d7789fb9854f9d76cfedd47b",
            },
          ],
        },
      ],
    }),
    files: [
      { path: "skills/code-review/SKILL.md", contents: skill },
      { path: "skills/code-review/agents/openai.yaml", contents: agent },
    ],
  };
}

const CTX: ScanContext = {
  home: "/Users/keith",
  projectRoot: "/repo",
  platform: "mac",
};

describe("KödSkills manifest", () => {
  it("parses the pinned pack and verifies every declared file hash", () => {
    const pack = parseKodSkillsBundle(bundle());

    expect(pack.version).toBe("1.0.0");
    expect(pack.skills).toEqual([
      expect.objectContaining({
        id: "code-review",
        description: "Review a branch diff.",
        files: [
          expect.objectContaining({ path: "SKILL.md" }),
          expect.objectContaining({ path: "agents/openai.yaml" }),
        ],
      }),
    ]);
  });

  it("rejects a missing or hash-mismatched vendored file", () => {
    const missing = bundle();
    missing.files.pop();
    expect(() => parseKodSkillsBundle(missing)).toThrow(/missing vendored file/i);

    const changed = bundle();
    changed.files[0].contents = "tampered";
    expect(() => parseKodSkillsBundle(changed)).toThrow(/hash mismatch/i);
  });
});

describe("KödSkills targets", () => {
  it("gives Free only Claude Code and Pro the deduplicated full skills matrix", () => {
    expect(resolveKodSkillsTargets(CTX, false)).toEqual([
      {
        id: "claude",
        cli: "claude",
        clis: ["claude", "grok", "opencode"],
        path: "/Users/keith/.claude/skills",
      },
    ]);

    expect(resolveKodSkillsTargets(CTX, true)).toEqual([
      {
        id: "claude",
        cli: "claude",
        clis: ["claude", "grok", "opencode"],
        path: "/Users/keith/.claude/skills",
      },
      {
        id: "agents",
        cli: "codex",
        clis: ["codex", "grok", "opencode", "kodade-local"],
        path: "/Users/keith/.agents/skills",
      },
    ]);
  });
});

describe("KödSkills install inspection", () => {
  it("skips enabled and disabled name conflicts", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = bundle();
    config.scans.set("/Users/keith/.claude/skills", {
      status: "listing",
      root: "/Users/keith/.claude/skills",
      rootIsSymlink: false,
      entries: [
        {
          name: "code-review.disabled",
          path: "/Users/keith/.claude/skills/code-review.disabled",
          isDir: true,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: [],
        },
      ],
    });

    const model = await inspectKodSkills(config, CTX, false);
    expect(model.cells[0].status).toBe("conflict");
    expect(model.cells[0].reason).toMatch(/already installed|conflicts/i);
  });

  it("reports an existing skill symlink as externally managed, not a pack conflict", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = bundle();
    config.scans.set("/Users/keith/.claude/skills", {
      status: "listing",
      root: "/Users/keith/.claude/skills",
      rootIsSymlink: false,
      entries: [
        {
          name: "code-review",
          path: "/Users/keith/.claude/skills/code-review",
          isDir: true,
          isSymlink: true,
          target: "/Users/keith/projects/skills/skills/engineering/code-review",
          orphaned: false,
          children: [],
        },
      ],
    });

    const model = await inspectKodSkills(config, CTX, false);

    expect(model.cells[0]).toMatchObject({
      status: "external",
      eligible: false,
      reason: "existing symlink — managed externally",
    });
  });

  it("skips a target whose skills directory is itself symlinked", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = bundle();
    config.scans.set("/Users/keith/.claude/skills", {
      status: "listing",
      root: "/Users/keith/.claude/skills",
      rootIsSymlink: true,
      entries: [],
    });

    const model = await inspectKodSkills(config as ConfigIpc, CTX, false);
    expect(model.cells[0]).toMatchObject({ status: "external", eligible: false });
    expect(model.cells[0].reason).toContain("skills dir is symlinked");
  });

  it("offers update and uninstall only while known installed provenance still matches", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = bundle("1.0.0");
    const skillPath = "/Users/keith/.claude/skills/code-review";
    const markerPath = `${skillPath}/.kodskills.json`;
    config.scans.set("/Users/keith/.claude/skills", {
      status: "listing",
      root: "/Users/keith/.claude/skills",
      rootIsSymlink: false,
      entries: [
        {
          name: "code-review",
          path: skillPath,
          isDir: true,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: [
            {
              name: ".kodskills.json",
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
        pack: "kodskills-engineering",
        packVersion: "0.9.0",
        skillId: "code-review",
        files: [
          {
            path: "SKILL.md",
            sha256: "dabf81ba0fa2b523fb9e007377786b316c5a3d0ac7df47d1f489e7b956aad542",
          },
          {
            path: "agents/openai.yaml",
            sha256: "6676d79ab8f6475f6a0f7cb34415c9636a96abd9d7789fb9854f9d76cfedd47b",
          },
        ],
      }),
    });
    config.dirSnapshots.set(skillPath, {
      status: "snapshot",
      path: skillPath,
      files: [
        {
          path: ".kodskills.json",
          sha256: "marker",
        },
        {
          path: "SKILL.md",
          sha256: "dabf81ba0fa2b523fb9e007377786b316c5a3d0ac7df47d1f489e7b956aad542",
        },
        {
          path: "agents/openai.yaml",
          sha256: "6676d79ab8f6475f6a0f7cb34415c9636a96abd9d7789fb9854f9d76cfedd47b",
        },
      ],
    });

    const clean = await inspectKodSkills(config, CTX, false);
    expect(clean.cells[0].status).toBe("update");
    expect(buildKodSkillsRequests(clean, "update", ["code-review"], ["claude"], "/repo", true))
      .toHaveLength(1);
    expect(buildKodSkillsRequests(clean, "uninstall", ["code-review"], ["claude"], "/repo", false))
      .toHaveLength(1);

    config.dirSnapshots.set(skillPath, {
      status: "snapshot",
      path: skillPath,
      files: [
        { path: ".kodskills.json", sha256: "marker" },
        { path: "SKILL.md", sha256: "locally-modified" },
        {
          path: "agents/openai.yaml",
          sha256: "6676d79ab8f6475f6a0f7cb34415c9636a96abd9d7789fb9854f9d76cfedd47b",
        },
      ],
    });
    const modified = await inspectKodSkills(config, CTX, false);
    expect(modified.cells[0].status).toBe("modified");
    expect(buildKodSkillsRequests(modified, "uninstall", ["code-review"], ["claude"], "/repo", false))
      .toEqual([]);
  });

  it("treats a self-consistent marker with foreign hashes as a name conflict", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = bundle();
    const skillPath = "/Users/keith/.claude/skills/code-review";
    const markerPath = `${skillPath}/.kodskills.json`;
    config.scans.set("/Users/keith/.claude/skills", {
      status: "listing",
      root: "/Users/keith/.claude/skills",
      rootIsSymlink: false,
      entries: [
        {
          name: "code-review",
          path: skillPath,
          isDir: true,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: [
            {
              name: ".kodskills.json",
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
        pack: "kodskills-engineering",
        packVersion: "1.0.0",
        skillId: "code-review",
        files: [{ path: "SKILL.md", sha256: "crafted-foreign-hash" }],
      }),
    });
    config.dirSnapshots.set(skillPath, {
      status: "snapshot",
      path: skillPath,
      files: [
        { path: ".kodskills.json", sha256: "marker" },
        { path: "SKILL.md", sha256: "crafted-foreign-hash" },
      ],
    });

    const model = await inspectKodSkills(config, CTX, false);

    expect(model.cells[0]).toMatchObject({ status: "conflict", eligible: false });
    expect(buildKodSkillsRequests(model, "update", ["code-review"], ["claude"], "/repo", true))
      .toEqual([]);
    expect(buildKodSkillsRequests(model, "uninstall", ["code-review"], ["claude"], "/repo", true))
      .toEqual([]);
  });
});
