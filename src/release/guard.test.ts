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

  it("passes supported KödWork calls through in public builds", async () => {
    const implementation = { begin: vi.fn(async () => "started") };
    const guarded = guardDevelopmentIpc(
      "work",
      implementation,
      releaseManifestFor("public"),
    );

    await expect(guarded.begin()).resolves.toBe("started");
    expect(implementation.begin).toHaveBeenCalledOnce();
  });
});
