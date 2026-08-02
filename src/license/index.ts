// Public surface of the license module.
//
// Feature code imports from here — the app-wide `licenseStore` singleton, the
// `hasFeature` convenience, the feature catalog, and types. It does NOT export
// the verifier: entitlements are the only contract the rest of the app sees, so
// nothing downstream can (accidentally) couple itself to crypto or tiers.

import { invoke } from "@tauri-apps/api/core";
import { createLicenseStore } from "./licenseStore";
import { LICENSE_PUBLIC_KEY } from "./public-key";
import { verifyLicense } from "./verify";
import type { Feature } from "./types";

// Where the activated token is persisted. localStorage is available in the
// Tauri WKWebView, needs no filesystem IPC, and keeps Rust tier-blind.
const STORAGE_KEY = "kodade.license.token";
let mirrorQueue: Promise<void> = Promise.resolve();

function mirrorSharedToken(token: string | null): void {
  // Serialize writes so a later invalid result's clear cannot finish before an
  // earlier valid write and leave stale KödLocal entitlement.
  mirrorQueue = mirrorQueue
    .then(() => invoke<void>("license_token_write", { token }))
    .catch(() => undefined);
}

function loadToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage disabled/unavailable — treat as no license (free).
  }
}

function saveToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Non-fatal: activation still works for the session, just won't persist.
  }
}

// The app-wide license store. Verifier + clock + persistence are the only wired
// side effects; everything else is the pure store logic.
export const licenseStore = createLicenseStore({
  publicKey: LICENSE_PUBLIC_KEY,
  verify: verifyLicense,
  now: () => Date.now(),
  load: loadToken,
  save: saveToken,
  mirror: mirrorSharedToken,
});

// Boolean gate for feature code: `hasFeature("vox.cleanup")`.
export function hasFeature(feature: Feature): boolean {
  return licenseStore.getState().hasFeature(feature);
}

export { FEATURES } from "./features";
export type { KnownFeature } from "./features";
export { freeEntitlements } from "./entitlements";
export type {
  Entitlements,
  Feature,
  LicenseToken,
  Tier,
  VerifyResult,
  VerifyStatus,
} from "./types";
export type { LicenseState, LicenseStatus } from "./licenseStore";
