// Shared license/entitlement types. Deliberately small and stringly-typed so
// consuming modules depend on booleans (hasFeature) rather than the license
// system's internals. No crypto or store code here — pure data shapes.

// The only tiers the app knows about. "free" is the default when there is no
// valid token; everything above it is unlocked by a signed license.
export type Tier = "free" | "pro";

// A feature flag string, namespaced by area, e.g. "vox.cleanup". Kept as a
// plain string alias (not a union) so new gated features are added at the call
// site without touching the license core.
export type Feature = string;

// The signed license payload. Issued (online, once) by the license service and
// verified locally forever. `expiry: null` means a perpetual license.
export interface LicenseToken {
  id: string; // opaque license id (for support/revocation lookups)
  tier: Tier;
  issuedAt: string; // ISO 8601
  expiry: string | null; // ISO 8601, or null for no expiry
  features: Feature[];
}

// Outcome of verifying a token string. Every non-"valid" status degrades to the
// free tier at the entitlements layer, but the distinct statuses let the UI
// explain *why* (expired vs tampered vs clock skew) without crashing.
export type VerifyStatus =
  | "valid" // signature good and within its time window
  | "expired" // signature good, but expiry has passed
  | "not-yet-valid" // signature good, but issuedAt is in the future (clock skew)
  | "invalid-signature" // signature check failed (tampered or wrong key)
  | "malformed"; // not a parseable token at all

export interface VerifyResult {
  status: VerifyStatus;
  // The parsed payload when the signature checked out (valid / expired /
  // not-yet-valid), otherwise null — an unverified payload is never trusted.
  token: LicenseToken | null;
  // Human-readable, safe to show in Settings.
  message: string;
}

// What consuming modules actually read. `hasFeature` is the whole public API a
// feature module needs; `tier`/`features` are for display and debugging.
export interface Entitlements {
  tier: Tier;
  features: ReadonlySet<Feature>;
  hasFeature(feature: Feature): boolean;
}
