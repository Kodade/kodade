// License store (Zustand vanilla, headless-testable) — same shape as the theme
// store: pure logic with all side effects (crypto, clock, persistence) injected.
//
// It owns the ACTIVATION lifecycle (paste/import a key, re-check on expiry,
// deactivate) and exposes the derived `entitlements`. Feature modules read
// `entitlements`/`hasFeature` from here and never touch the verifier — that
// coupling stops at this file.

import { createStore } from "zustand/vanilla";
import { entitlementsFor, freeEntitlements } from "./entitlements";
import type {
  Entitlements,
  Feature,
  LicenseToken,
  VerifyResult,
  VerifyStatus,
} from "./types";

export type LicenseDeps = {
  // The embedded public key (bytes or hex). Injected so tests use the dev key.
  publicKey: Uint8Array | string;
  // The verifier. Injected so the store never imports crypto directly and tests
  // can substitute a fake; production wires the real verifyLicense.
  verify: (token: string, publicKey: Uint8Array | string, now: number) => VerifyResult;
  // Current time in epoch ms. Injected so expiry is testable.
  now: () => number;
  // Persistence for the raw token string (null = cleared). Fire-and-forget.
  load: () => string | null;
  save: (token: string | null) => void;
  // Headless mirror receives only a currently verified valid token. Every
  // other verification result clears it, independently of display persistence.
  mirror: (validToken: string | null) => void;
};

// "none" means no key has been activated (distinct from an activated-but-invalid
// key, which carries a VerifyStatus explaining why it isn't honored).
export type LicenseStatus = VerifyStatus | "none";

export type LicenseState = {
  entitlements: Entitlements; // what feature code reads
  status: LicenseStatus; // for the Settings tier display
  message: string | null; // human-readable activation feedback
  token: LicenseToken | null; // honored/parsed token metadata (tier, expiry…)

  // Activate a pasted/imported key. Persists and honors any signature-valid
  // token (even expired, so tier display + graceful re-check work); rejects
  // malformed/forged keys without disturbing the current activation. Returns
  // the full result so the UI can show the exact reason.
  activate(tokenString: string): VerifyResult;

  // Remove the active license and fall back to free.
  deactivate(): void;

  // Re-evaluate the stored token against the current time. Call on a timer or
  // on focus so a license that crosses its expiry disables features gracefully.
  refresh(): void;

  // Convenience passthrough so callers can do licenseStore.getState().hasFeature.
  hasFeature(feature: Feature): boolean;
};

export function createLicenseStore(deps: LicenseDeps) {
  // The raw activated token string, kept out of state so refresh() can re-verify
  // it against a new clock without re-reading persistence each time.
  let current: string | null = null;

  return createStore<LicenseState>((set, get) => {
    // Apply a verification result to state (entitlements + display fields).
    const apply = (result: VerifyResult) =>
      set({
        entitlements: entitlementsFor(result),
        status: result.status,
        message: result.message,
        token: result.token,
      });

    // Hydrate from persistence at construction: verify any stored token so the
    // app boots straight into the right tier, fully offline.
    const stored = deps.load();
    let initialState: Pick<LicenseState, "entitlements" | "status" | "message" | "token">;
    if (stored) {
      current = stored;
      const result = deps.verify(stored, deps.publicKey, deps.now());
      deps.mirror(result.status === "valid" ? stored : null);
      initialState = {
        entitlements: entitlementsFor(result),
        status: result.status,
        message: result.message,
        token: result.token,
      };
    } else {
      deps.mirror(null);
      initialState = {
        entitlements: freeEntitlements(),
        status: "none",
        message: null,
        token: null,
      };
    }

    return {
      ...initialState,

      activate(tokenString: string) {
        const candidate = tokenString.trim();
        const result = deps.verify(candidate, deps.publicKey, deps.now());
        deps.mirror(result.status === "valid" ? candidate : null);
        // Don't persist or honor a key we can't authenticate — leave the current
        // activation intact and just report the problem.
        if (result.status === "malformed" || result.status === "invalid-signature") {
          set({ status: result.status, message: result.message });
          return result;
        }
        current = candidate;
        deps.save(current);
        apply(result);
        return result;
      },

      deactivate() {
        current = null;
        deps.save(null);
        deps.mirror(null);
        set({
          entitlements: freeEntitlements(),
          status: "none",
          message: null,
          token: null,
        });
      },

      refresh() {
        if (!current) return;
        const result = deps.verify(current, deps.publicKey, deps.now());
        deps.mirror(result.status === "valid" ? current : null);
        apply(result);
      },

      hasFeature(feature: Feature) {
        return get().entitlements.hasFeature(feature);
      },
    };
  });
}
