// Desktop IPC boundary. Ködade is a native Tauri application; feature code
// imports these typed groups instead of calling Tauri directly.

import {
  tauriAgent,
  tauriBrowser,
  tauriConfig,
  tauriExternalUrls,
  tauriFiles,
  tauriKodwork,
  tauriForeground,
  tauriGit,
  tauriGithub,
  tauriIpc,
  tauriLocal,
  tauriPlatform,
  tauriProvider,
  tauriSsh,
  tauriStorage,
  tauriVox,
} from "./tauri";
import { tauriMemory } from "./memory";
import type { ExternalUrlIpc } from "./contract";
import { guardDevelopmentIpc, unavailableFeatureError } from "../release/guard";
import { RELEASE_MANIFEST } from "../release/manifest";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const ipc = tauriIpc;
export const agent = tauriAgent;
export const storage = tauriStorage;
export const platform = tauriPlatform;
export const provider = tauriProvider;
export const foreground = tauriForeground;
export const files = tauriFiles;
export const kodwork = guardDevelopmentIpc("work", tauriKodwork);
export const config = tauriConfig;
export const externalUrls: ExternalUrlIpc = {
  openUrl: (url) => tauriExternalUrls.openUrl(url),
  openMicrophonePrivacySettings: () =>
    RELEASE_MANIFEST.features.voice
      ? tauriExternalUrls.openMicrophonePrivacySettings()
      : Promise.reject(unavailableFeatureError("voice")),
};
export const github = tauriGithub;
export const git = tauriGit;
// Archived embedded browser (#62). The native commands stay registered so the
// pane can be revived; the TypeScript surface is what a public build loses.
export const browser = guardDevelopmentIpc("browser", tauriBrowser);
export const memory = tauriMemory;
export const memoryMcpBinaryPath = () => tauriMemory.mcpBinaryPath();
export const ssh = guardDevelopmentIpc("ssh", tauriSsh);
export const vox = guardDevelopmentIpc("voice", tauriVox);
export const local = guardDevelopmentIpc("local", tauriLocal);
