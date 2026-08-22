// In-app updater state (Zustand vanilla, headless-testable). Owns the
// check -> available -> downloading -> ready-to-restart flow; the actual
// GitHub Releases fetch, download, and relaunch are injected (see
// updater.ts for the real Tauri plugin wiring), so this file's logic runs
// under vitest with no Tauri runtime.
//
// #98: a launch-time check is always silent (offline/rate-limited never
// surfaces anything); a manual "Check for updates…" click also reports
// "up to date" or an error so the click isn't a no-op.

import { createStore } from "zustand/vanilla";

export type UpdateInfo = {
  version: string;
  notes: string | null;
};

export type UpdateStatus =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "available"; info: UpdateInfo }
  | { phase: "downloading"; info: UpdateInfo; progress: number | null }
  | { phase: "ready"; info: UpdateInfo }
  | { phase: "error"; message: string };

// Mirrors @tauri-apps/plugin-updater's DownloadEvent without importing it,
// so this file has zero Tauri dependency.
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

// The slice of `Update` (from @tauri-apps/plugin-updater) this store needs.
export type PendingUpdate = {
  version: string;
  body?: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
};

export type UpdateDeps = {
  check(): Promise<PendingUpdate | null>;
  relaunch(): Promise<void>;
};

export type UpdateState = {
  status: UpdateStatus;
  // silent=true (launch check) never surfaces "up to date" or an error.
  checkForUpdate(options?: { silent?: boolean }): Promise<void>;
  install(): Promise<void>;
  restart(): Promise<void>;
  dismiss(): void;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUpdateStore(deps: UpdateDeps) {
  // Held outside state: the live `Update` resource isn't state, it's a handle
  // install() needs. Cleared whenever the flow resets to idle/up-to-date.
  let pending: PendingUpdate | null = null;

  return createStore<UpdateState>((set, get) => ({
    status: { phase: "idle" },

    async checkForUpdate(options = {}) {
      const silent = options.silent ?? false;
      const phase = get().status.phase;
      // Never stack a second check on an in-flight one.
      if (phase === "checking" || phase === "downloading") return;

      set({ status: { phase: "checking" } });
      try {
        const update = await deps.check();
        if (!update) {
          pending = null;
          set({ status: silent ? { phase: "idle" } : { phase: "up-to-date" } });
          return;
        }
        pending = update;
        set({
          status: {
            phase: "available",
            info: { version: update.version, notes: update.body ?? null },
          },
        });
      } catch (err) {
        pending = null;
        set({
          status: silent
            ? { phase: "idle" }
            : { phase: "error", message: errorMessage(err) },
        });
      }
    },

    async install() {
      const state = get().status;
      if (state.phase !== "available" || !pending) return;
      const { info } = state;
      const update = pending;

      set({ status: { phase: "downloading", info, progress: null } });
      let downloaded = 0;
      let total = 0;
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? 0;
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            const progress =
              total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
            set({ status: { phase: "downloading", info, progress } });
          }
        });
        set({ status: { phase: "ready", info } });
      } catch (err) {
        pending = null;
        set({ status: { phase: "error", message: errorMessage(err) } });
      }
    },

    async restart() {
      if (get().status.phase !== "ready") return;
      await deps.relaunch();
    },

    dismiss() {
      pending = null;
      set({ status: { phase: "idle" } });
    },
  }));
}
