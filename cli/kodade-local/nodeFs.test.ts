/// <reference types="node" />

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeHarnessFs } from "./nodeFs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Node harness fs provider", () => {
  it("supplies the same shallow scan and capped read shapes as ConfigIpc", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodade-harness-fs-"));
    roots.push(root);
    const skill = join(root, "review");
    await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), "review instructions", "utf8");
    await symlink(skill, join(root, "review-link"));

    const fs = createNodeHarnessFs();
    const scan = await fs.scan(root, root);
    expect(scan).toMatchObject({ status: "listing", root });
    if (scan.status !== "listing") throw new Error("expected listing");
    expect(scan.entries.find((entry) => entry.name === "review")?.children).toEqual([
      expect.objectContaining({ name: "SKILL.md", isDir: false }),
    ]);
    expect(scan.entries.find((entry) => entry.name === "review-link")).toMatchObject({
      isSymlink: true,
      isDir: true,
      orphaned: false,
    });
    await expect(fs.read(join(skill, "SKILL.md"), root)).resolves.toEqual({
      kind: "text",
      content: "review instructions",
    });
  });
});
