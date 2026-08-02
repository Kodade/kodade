// The offline entitlements selector fronting feature gates in the app. Feature
// modules call `hasFeature` and never import a verifier directly; Rust never
// learns about tiers.

export type Entitlements = {
  hasFeature(feature: string): boolean;
};

// A factory, not a bare boolean map, lets tests construct a flipped instance
// via DI instead of mutating global state.
export function createEntitlements(overrides: Partial<Record<string, boolean>> = {}): Entitlements {
  return {
    hasFeature(feature: string): boolean {
      return overrides[feature] ?? true;
    },
  };
}

// The app-wide singleton real code depends on (see src/store/appStore.ts
// wiring conventions). Tests that need a flipped feature build their own
// createEntitlements({...}) and inject it instead of touching this export.
export const entitlements: Entitlements = createEntitlements();
