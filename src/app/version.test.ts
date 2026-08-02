import { describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";

const { getVersion } = vi.hoisted(() => ({ getVersion: vi.fn() }));

vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

import { FALLBACK_APP_VERSION, loadAppVersion } from "./version";

describe("loadAppVersion", () => {
  it("uses the Tauri app version when available", async () => {
    getVersion.mockResolvedValueOnce("1.2.3");

    await expect(loadAppVersion()).resolves.toBe("1.2.3");
  });

  it("falls back for browser previews", async () => {
    getVersion.mockRejectedValueOnce(new Error("not running in Tauri"));

    await expect(loadAppVersion()).resolves.toBe(packageJson.version);
    expect(FALLBACK_APP_VERSION).toBe(packageJson.version);
  });
});
