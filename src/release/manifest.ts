// One compile-time product boundary for the public app. This is deliberately
// separate from licensing: unavailable development features cannot be restored
// with persisted state, a shortcut, or an entitlement.

export type ReleaseProfile = "public" | "development";
export type DevelopmentFeature = "local" | "voice" | "ssh";

export type ReleaseManifest = {
  readonly profile: ReleaseProfile;
  readonly features: Readonly<Record<DevelopmentFeature, boolean>>;
};

export function releaseManifestFor(profile: ReleaseProfile): ReleaseManifest {
  const enabled = profile === "development";
  return Object.freeze({
    profile,
    features: Object.freeze({
      local: enabled,
      voice: enabled,
      ssh: enabled,
    }),
  });
}

export const RELEASE_MANIFEST = releaseManifestFor(__KODADE_RELEASE_PROFILE__);

export function developmentFeatureEnabled(
  feature: DevelopmentFeature,
  manifest: ReleaseManifest = RELEASE_MANIFEST,
): boolean {
  return manifest.features[feature];
}
