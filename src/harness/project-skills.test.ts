import { describe, expect, it } from "vitest";
import { MockConfig } from "../ipc/mock";
import type { ProjectSkillSourceBundle } from "../ipc/contract";
import type { ScanContext } from "./model";
import {
  buildProjectSkillRequests,
  inspectProjectSkill,
  parseProjectSkillBundle,
  resolveProjectSkillTargets,
} from "./project-skills";

const CTX: ScanContext = {
  home: "/Users/keith",
  platform: "mac",
  projectRoot: "/repo",
  appDataRoaming: null,
  appDataLocal: null,
};

function bundle(files: ProjectSkillSourceBundle["files"] = []): ProjectSkillSourceBundle {
  return {
    root: "/vault/skills/review",
    files: files.length > 0
      ? files
      : [
          {
            path: "SKILL.md",
            contents: "---\nname: code-review\ndescription: Review a branch before shipping.\n---\n\n# Review\n",
          },
          { path: "scripts/check.ts", contents: "export const check = true;\n" },
        ],
  };
}

describe("parseProjectSkillBundle", () => {
  it("validates the manifest and hashes the complete portable source tree", () => {
    const parsed = parseProjectSkillBundle(bundle());

    expect(parsed).toMatchObject({
      id: "code-review",
      description: "Review a branch before shipping.",
      sourceRoot: "/vault/skills/review",
    });
    expect(parsed.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/check.ts",
    ]);
    expect(parsed.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });

  it("rejects a missing manifest and a non-portable skill name", () => {
    expect(() => parseProjectSkillBundle(bundle([
      { path: "README.md", contents: "not a skill" },
    ]))).toThrow(/SKILL\.md/);
    expect(() => parseProjectSkillBundle(bundle([
      {
        path: "SKILL.md",
        contents: "---\nname: Code Review\ndescription: Review.\n---\n",
      },
    ]))).toThrow(/portable skill name/);
  });

  it("accepts the folded descriptions used by standard skill frontmatter", () => {
    const parsed = parseProjectSkillBundle(bundle([
      {
        path: "SKILL.md",
        contents:
          "---\nname: project-review\ndescription: >-\n  Review a project before shipping.\n  Keep the report concise.\n---\n",
      },
    ]));

    expect(parsed.description).toBe(
      "Review a project before shipping. Keep the report concise.",
    );
  });
});

describe("project skill targets", () => {
  it("uses recognized project roots and shows every compatible agent", () => {
    expect(resolveProjectSkillTargets(CTX, true)).toEqual([
      {
        id: "claude",
        cli: "claude",
        clis: ["claude", "grok", "opencode"],
        path: "/repo/.claude/skills",
      },
      {
        id: "agents",
        cli: "codex",
        clis: ["codex", "opencode", "kodade-local"],
        path: "/repo/.agents/skills",
      },
    ]);
    expect(resolveProjectSkillTargets(CTX, false).map((target) => target.id)).toEqual([
      "claude",
    ]);
  });

  it("allows a product-owned free skill to target Claude and Codex explicitly", () => {
    expect(
      resolveProjectSkillTargets(CTX, false, ["claude", "codex"]).map(
        (target) => target.cli,
      ),
    ).toEqual(["claude", "codex"]);
  });

  it("inspects missing targets as ready and plans one guarded change per target", async () => {
    const config = new MockConfig();
    const model = await inspectProjectSkill(config, bundle(), CTX, true);

    expect(model.cells.map((cell) => `${cell.targetId}:${cell.status}`)).toEqual([
      "claude:ready",
      "agents:ready",
    ]);

    const requests = buildProjectSkillRequests(
      model,
      "install",
      ["claude", "agents"],
      "/repo",
      true,
    );
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.request.payload)).toEqual([
      expect.objectContaining({
        targetPath: "/repo/.claude/skills/code-review",
        operation: "install",
      }),
      expect.objectContaining({
        targetPath: "/repo/.agents/skills/code-review",
        operation: "install",
      }),
    ]);
    expect(
      requests.every((request) =>
        (request.request.payload as { files: { path: string }[] }).files.some(
          (file) => file.path === ".kodade-skill.json",
        )
      ),
    ).toBe(true);
  });

  it("will not stage the Pro agents target after an entitlement downgrade", async () => {
    const model = await inspectProjectSkill(new MockConfig(), bundle(), CTX, true);

    expect(buildProjectSkillRequests(
      model,
      "install",
      ["agents"],
      "/repo",
      false,
    )).toEqual([]);
  });

  it("removes only a clean Kodade-managed project copy", async () => {
    const config = new MockConfig();
    const parsed = parseProjectSkillBundle(bundle());
    const skillPath = "/repo/.claude/skills/code-review";
    const markerPath = `${skillPath}/.kodade-skill.json`;
    config.scans.set("/repo/.claude/skills", {
      status: "listing",
      root: "/repo/.claude/skills",
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
        skillId: parsed.id,
        sourceHash: parsed.sourceHash,
        files: parsed.files.map(({ path, sha256 }) => ({ path, sha256 })),
      }),
    });
    const snapshot = [
      { path: ".kodade-skill.json", sha256: "marker" },
      ...parsed.files.map(({ path, sha256 }) => ({ path, sha256 })),
    ];
    config.dirSnapshots.set(skillPath, { status: "snapshot", path: skillPath, files: snapshot });

    const clean = await inspectProjectSkill(config, bundle(), CTX, false);
    expect(clean.cells[0]).toMatchObject({ status: "installed", eligible: true });
    expect(buildProjectSkillRequests(clean, "uninstall", ["claude"], "/repo", false))
      .toEqual([
        expect.objectContaining({
          request: expect.objectContaining({
            action: "remove-skill",
            payload: expect.objectContaining({ expectedFiles: snapshot }),
          }),
        }),
      ]);

    config.dirSnapshots.set(skillPath, {
      status: "snapshot",
      path: skillPath,
      files: snapshot.map((file) =>
        file.path === "SKILL.md" ? { ...file, sha256: "modified" } : file
      ),
    });
    const modified = await inspectProjectSkill(config, bundle(), CTX, false);
    expect(modified.cells[0]).toMatchObject({ status: "modified", eligible: false });
    expect(buildProjectSkillRequests(modified, "uninstall", ["claude"], "/repo", false))
      .toEqual([]);
  });
});
