// The entitlements selector: turns a verify result into the boolean-only view
// the rest of the app consumes. This is the seam that keeps feature code
// ignorant of licensing — modules import `hasFeature`, never the verifier.
//
// The rule is simple and safe: ONLY a "valid" token grants features. Every
// other outcome (expired, tampered, malformed, not-yet-valid, or no token at
// all) collapses to the free tier with no features — so a broken license never
// breaks the app, it just quietly disables the paid extras.

import type { Entitlements, Feature, Tier, VerifyResult } from "./types";

// Build an Entitlements object from a tier + feature list. `hasFeature` is a
// set membership check; the free tier is just this with an empty set.
function makeEntitlements(tier: Tier, features: readonly Feature[]): Entitlements {
  const set = new Set(features);
  return {
    tier,
    features: set,
    hasFeature: (feature: Feature) => set.has(feature),
  };
}

// The free tier: no features. Used as the default everywhere a token is absent
// or not honored.
export function freeEntitlements(): Entitlements {
  return makeEntitlements("free", []);
}

// Map a verification result to entitlements. Only "valid" unlocks anything.
export function entitlementsFor(result: VerifyResult): Entitlements {
  if (result.status === "valid" && result.token) {
    return makeEntitlements(result.token.tier, result.token.features);
  }
  return freeEntitlements();
}
