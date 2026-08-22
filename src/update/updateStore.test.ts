// Update store logic against injected fakes (#98) — no Tauri runtime, no
// network. Pins the silent-launch-check contract, the manual-check feedback
// contract, download progress accumulation, and the restart gate.

import { describe, expect, it, vi } from "vitest";
import { createUpdateStore, type DownloadEvent, type PendingUpdate } from "./updateStore";

function makePendingUpdate(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    version: "2.1.0",
    body: "release notes",
    downloadAndInstall: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("checkForUpdate", () => {
  it("silent + no update available resolves to idle (never surfaces anything)", async () => {
    const store = createUpdateStore({ check: async () => null, relaunch: async () => {} });
    await store.getState().checkForUpdate({ silent: true });
    expect(store.getState().status).toEqual({ phase: "idle" });
  });

  it("silent + check throws (offline) resolves to idle, not an error state", async () => {
    const store = createUpdateStore({
      check: async () => {
        throw new Error("network down");
      },
      relaunch: async () => {},
    });
    await store.getState().checkForUpdate({ silent: true });
    expect(store.getState().status).toEqual({ phase: "idle" });
  });

  it("manual + no update available surfaces up-to-date", async () => {
    const store = createUpdateStore({ check: async () => null, relaunch: async () => {} });
    await store.getState().checkForUpdate();
    expect(store.getState().status).toEqual({ phase: "up-to-date" });
  });

  it("manual + check throws surfaces an error with the message", async () => {
    const store = createUpdateStore({
      check: async () => {
        throw new Error("rate limited");
      },
      relaunch: async () => {},
    });
    await store.getState().checkForUpdate();
    expect(store.getState().status).toEqual({ phase: "error", message: "rate limited" });
  });

  it("an update found (silent or not) surfaces available with version + notes", async () => {
    const store = createUpdateStore({
      check: async () => makePendingUpdate({ version: "3.0.0", body: "big release" }),
      relaunch: async () => {},
    });
    await store.getState().checkForUpdate({ silent: true });
    expect(store.getState().status).toEqual({
      phase: "available",
      info: { version: "3.0.0", notes: "big release" },
    });
  });

  it("a second check is ignored while one is already checking or downloading", async () => {
    let resolveCheck: (u: PendingUpdate | null) => void = () => {};
    const check = vi.fn(
      () => new Promise<PendingUpdate | null>((resolve) => (resolveCheck = resolve)),
    );
    const store = createUpdateStore({ check, relaunch: async () => {} });

    const first = store.getState().checkForUpdate();
    const second = store.getState().checkForUpdate();
    resolveCheck(null);
    await Promise.all([first, second]);

    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("install", () => {
  it("does nothing when no update is available", async () => {
    const store = createUpdateStore({ check: async () => null, relaunch: async () => {} });
    await store.getState().install();
    expect(store.getState().status).toEqual({ phase: "idle" });
  });

  it("tracks download progress and lands on ready", async () => {
    const events: DownloadEvent[] = [
      { event: "Started", data: { contentLength: 200 } },
      { event: "Progress", data: { chunkLength: 100 } },
      { event: "Progress", data: { chunkLength: 100 } },
      { event: "Finished" },
    ];
    const downloadAndInstall = vi.fn(async (onEvent?: (e: DownloadEvent) => void) => {
      for (const event of events) onEvent?.(event);
    });
    const store = createUpdateStore({
      check: async () => makePendingUpdate({ version: "3.0.0", downloadAndInstall }),
      relaunch: async () => {},
    });

    await store.getState().checkForUpdate({ silent: true });
    await store.getState().install();

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toEqual({
      phase: "ready",
      info: { version: "3.0.0", notes: "release notes" },
    });
  });

  it("a failed download surfaces an error instead of ready", async () => {
    const downloadAndInstall = vi.fn(async () => {
      throw new Error("disk full");
    });
    const store = createUpdateStore({
      check: async () => makePendingUpdate({ downloadAndInstall }),
      relaunch: async () => {},
    });
    await store.getState().checkForUpdate({ silent: true });
    await store.getState().install();
    expect(store.getState().status).toEqual({ phase: "error", message: "disk full" });
  });
});

describe("restart", () => {
  it("only relaunches once the update is ready", async () => {
    const relaunch = vi.fn(async () => {});
    const store = createUpdateStore({
      check: async () => makePendingUpdate(),
      relaunch,
    });

    await store.getState().restart();
    expect(relaunch).not.toHaveBeenCalled();

    await store.getState().checkForUpdate({ silent: true });
    await store.getState().install();
    await store.getState().restart();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("dismiss", () => {
  it("resets to idle and clears the pending update", async () => {
    const store = createUpdateStore({
      check: async () => makePendingUpdate(),
      relaunch: async () => {},
    });
    await store.getState().checkForUpdate({ silent: true });
    store.getState().dismiss();
    expect(store.getState().status).toEqual({ phase: "idle" });
    // install() should now be a no-op since the pending handle is gone.
    await store.getState().install();
    expect(store.getState().status).toEqual({ phase: "idle" });
  });
});
