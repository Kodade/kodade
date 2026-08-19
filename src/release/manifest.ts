// One compile-time product boundary for the public app. This is deliberately
// separate from licensing: unavailable development features cannot be restored
// with persisted state, a shortcut, or an entitlement.

export type ReleaseProfile = "public" | "development";
export type DevelopmentFeature =
  | "local"
  | "voice"
  | "ssh"
  | "work"
  | "shell";

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
      // KödWork graduated into the supported product in v1.7.0. Keep it in
      // this manifest so older persisted layouts still fail closed on builds
      // that explicitly disable it, without tying it to unrelated dev tools.
      work: true,
      // The v2 tabbed shell (issue #62) is still being built. Unlike `work` it
      // is a plain development feature: public builds compile without it.
      shell: enabled,
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
