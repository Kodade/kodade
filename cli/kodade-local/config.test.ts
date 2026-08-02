/// <reference types="node" />

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectToolConfig, saveProjectToolConfig } from "./config";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("KödLocal per-project tool config", () => {
  it("defaults to confirm-each and persists only the write_file allowlist", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kodade-local-config-"));
    roots.push(dataDir);
    await expect(loadProjectToolConfig(dataDir, "/repo/a")).resolves.toEqual({
      autoApproveWrite: false,
    });
    await saveProjectToolConfig(dataDir, "/repo/a", { autoApproveWrite: true });
    await expect(loadProjectToolConfig(dataDir, "/repo/a")).resolves.toEqual({
      autoApproveWrite: true,
    });
    await expect(loadProjectToolConfig(dataDir, "/repo/b")).resolves.toEqual({
      autoApproveWrite: false,
    });
    await saveProjectToolConfig(dataDir, "/repo/a", { autoApproveWrite: false });
    await expect(loadProjectToolConfig(dataDir, "/repo/a")).resolves.toEqual({
      autoApproveWrite: false,
    });
  });

  it("fails closed on malformed project maps", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kodade-local-config-"));
    roots.push(dataDir);
    await writeFile(join(dataDir, "kodade-local.json"), '{"version":1,"projects":[]}\n', "utf8");
    await expect(loadProjectToolConfig(dataDir, "/repo")).resolves.toEqual({
      autoApproveWrite: false,
    });
  });
});
