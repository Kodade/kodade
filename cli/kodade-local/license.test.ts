/// <reference types="node" />

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signLicense } from "../../src/license/__fixtures__/dev-keypair";
import { readHeadlessLicense, SHARED_LICENSE_FILE } from "./license";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("headless KödLocal license", () => {
  it("reads and verifies the desktop app's shared token file", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kodade-license-"));
    roots.push(dataDir);
    const now = Date.parse("2026-07-19T12:00:00Z");
    const token = signLicense({
      id: "m14e-test-only",
      tier: "pro",
      issuedAt: "2026-07-18T12:00:00Z",
      expiry: "2026-07-20T12:00:00Z",
      features: ["local.agent", "local.tools", "local.orchestrate"],
    });
    await writeFile(join(dataDir, SHARED_LICENSE_FILE), token, "utf8");

    await expect(readHeadlessLicense({ dataDir, now })).resolves.toMatchObject({
      status: "valid",
      hasAgent: true,
      hasTools: true,
      hasOrchestrate: true,
    });
  });

  it("treats absent and invalid tokens as free", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kodade-license-"));
    roots.push(dataDir);
    await expect(readHeadlessLicense({ dataDir })).resolves.toMatchObject({
      status: "none",
      hasAgent: false,
      hasTools: false,
    });
    await writeFile(join(dataDir, SHARED_LICENSE_FILE), "forged.token", "utf8");
    await expect(readHeadlessLicense({ dataDir })).resolves.toMatchObject({
      status: "invalid-signature",
      hasAgent: false,
      hasTools: false,
    });

    await writeFile(join(dataDir, SHARED_LICENSE_FILE), "x".repeat(16 * 1024 + 1), "utf8");
    await expect(readHeadlessLicense({ dataDir })).resolves.toMatchObject({
      status: "malformed",
      hasAgent: false,
      hasTools: false,
    });
  });

  it.skipIf(process.platform === "win32")("rejects a symlink at the shared token path", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "kodade-license-"));
    roots.push(dataDir);
    const target = join(dataDir, "real-token");
    await writeFile(target, "forged.token", "utf8");
    await symlink(target, join(dataDir, SHARED_LICENSE_FILE));

    await expect(readHeadlessLicense({ dataDir })).resolves.toMatchObject({
      status: "malformed",
      hasAgent: false,
      hasTools: false,
    });
  });
});
