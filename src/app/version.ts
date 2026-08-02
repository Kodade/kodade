import { getVersion } from "@tauri-apps/api/app";

export const FALLBACK_APP_VERSION = __APP_VERSION__;

// Browser previews do not expose Tauri's app metadata; the packaged app always does.
export async function loadAppVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return FALLBACK_APP_VERSION;
  }
}
