import { describe, expect, it } from "vitest";
import type { ConfigScan, FileRead } from "../ipc/contract";
import type { HarnessReadFs } from "../harness/adapters/read";
import type { ScanContext } from "../harness/model";
import { assembleLocalHarness, createLocalHarnessAdapter } from "./harness";

const CONTEXT: ScanContext = {
  home: "/Users/tester",
  projectRoot: "/work/project",
  platform: "mac",
};

class FakeFs implements HarnessReadFs {
  reads = new Map<string, FileRead>();
  scans = new Map<string, ConfigScan>();

  async read(path: string): Promise<FileRead> {
    const value = this.reads.get(path);
    if (!value) throw new Error("missing");
    return value;
  }

  async scan(root: string): Promise<ConfigScan> {
    return this.scans.get(root) ?? { status: "missing", root };
  }
}

describe("KödLocal harness assembly", () => {
  it("uses shared AGENTS.md locations, project-over-global order, and enabled skill briefs", async () => {
    const fs = new FakeFs();
    fs.reads.set("/Users/tester/.codex/AGENTS.md", {
      kind: "text",
      content: "Global rule: be concise.",
    });
    fs.reads.set("/work/project/AGENTS.md", {
      kind: "text",
      content: "Project rule: use pnpm.",
    });
    fs.reads.set("/Users/tester/.codex/skills/review/SKILL.md", {
      kind: "text",
      content: "---\nname: review\ndescription: Review a branch against its spec.\n---\n",
    });
    fs.scans.set("/Users/tester/.codex/skills", {
      status: "listing",
      root: "/Users/tester/.codex/skills",
      entries: [
        {
          name: "review",
          path: "/Users/tester/.codex/skills/review",
          isDir: true,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: [
            {
              name: "SKILL.md",
              path: "/Users/tester/.codex/skills/review/SKILL.md",
              isDir: false,
              isSymlink: false,
              target: null,
              orphaned: false,
              children: null,
            },
          ],
        },
        {
          name: "ignored.disabled",
          path: "/Users/tester/.codex/skills/ignored.disabled",
          isDir: true,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: [],
        },
      ],
    });

    const harness = await assembleLocalHarness(fs, CONTEXT);

    expect(harness.systemPrompt).toContain("Global rule: be concise.");
    expect(harness.systemPrompt).toContain("Project rule: use pnpm.");
    expect(harness.systemPrompt.indexOf("Global rule")).toBeLessThan(
      harness.systemPrompt.indexOf("Project rule"),
    );
    expect(harness.systemPrompt).toContain("review: Review a branch against its spec.");
    expect(harness.systemPrompt).not.toContain("ignored");
    expect(harness.sources.map((source) => source.path)).toEqual([
      "/Users/tester/.codex/AGENTS.md",
      "/work/project/AGENTS.md",
      "/Users/tester/.codex/skills/review/SKILL.md",
    ]);
  });

  it("exposes a read-only adapter for the KödHarness matrix", async () => {
    const adapter = createLocalHarnessAdapter(new FakeFs());
    const locations = await adapter.detect("project", CONTEXT);
    expect(locations).toEqual([
      expect.objectContaining({ cli: "kodade-local", kind: "instruction", path: "/work/project/AGENTS.md" }),
      expect.objectContaining({
        cli: "kodade-local",
        kind: "skill",
        path: "/work/project/.agents/skills",
      }),
    ]);
    await expect(
      adapter.plan({ artifactId: "x", action: "edit", projectRoot: CONTEXT.projectRoot }),
    ).rejects.toThrow("read-only");
  });
});
