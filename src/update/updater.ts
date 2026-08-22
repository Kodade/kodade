// Real Tauri wiring for the update store (#98). A build without the updater
// plugin configured (dev/QA package — see tauri.public.conf.json) simply has
// no endpoint: `check()` resolves null or rejects, and checkForUpdate already
// treats both as "nothing to do" when silent.

import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { createUpdateStore } from "./updateStore";

export const updateStore = createUpdateStore({ check, relaunch });

// Fire on launch: non-blocking, silent on failure/offline. Call once from the
// app root effect.
export function checkForUpdateOnLaunch(): void {
  void updateStore.getState().checkForUpdate({ silent: true });
}
