import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { callBrowserBridge } from "./browserBridge";

async function descriptorDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kodade-browser-"));
  const path = join(directory, "kodade-browser.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      port: 43117,
      token: "a".repeat(64),
      pid: 42,
    }),
  );
  if (process.platform !== "win32") await chmod(path, 0o600);
  return directory;
}

describe("KödLocal browser bridge", () => {
  it("sends the requesting project and bearer capability to loopback", async () => {
    const dataDir = await descriptorDir();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { title: "Kodade" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      callBrowserBridge(
        "/work/app",
        { action: "snapshot" },
        { dataDir, fetchImpl },
      ),
    ).resolves.toEqual({ title: "Kodade" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:43117/command",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: `Bearer ${"a".repeat(64)}`,
        }),
        body: JSON.stringify({
          action: "snapshot",
          project_root: "/work/app",
        }),
      }),
    );
  });

  it("fails closed when Kodade is not running", async () => {
    await expect(
      callBrowserBridge("/work/app", { action: "snapshot" }, {
        dataDir: join(tmpdir(), "kodade-browser-missing"),
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow("internal browser is unavailable");
  });
});
