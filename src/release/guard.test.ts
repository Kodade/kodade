import { describe, expect, it, vi } from "vitest";
import { guardDevelopmentIpc } from "./guard";
import { releaseManifestFor } from "./manifest";

describe("development feature IPC guard", () => {
  it("rejects public calls without reaching the implementation", async () => {
    const status = vi.fn(async () => "ready");
    const guarded = guardDevelopmentIpc(
      "local",
      { status },
      releaseManifestFor("public"),
    );

    await expect(guarded.status()).rejects.toThrow(
      "KödLocal is unavailable in the public release",
    );
    expect(status).not.toHaveBeenCalled();
  });

  it("passes development calls through unchanged", async () => {
    const implementation = { status: vi.fn(async () => "ready") };
    const guarded = guardDevelopmentIpc(
      "local",
      implementation,
      releaseManifestFor("development"),
    );

    await expect(guarded.status()).resolves.toBe("ready");
    expect(implementation.status).toHaveBeenCalledOnce();
  });
});
