// One compile-time product boundary for the public app. This is deliberately
// separate from licensing: unavailable development features cannot be restored
// with persisted state, a shortcut, or an entitlement.

export type ReleaseProfile = "public" | "development";
export type DevelopmentFeature =
  | "local"
  | "voice"
  | "ssh"
  | "work"
  | "shell"
  | "browser";

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
      // The v2 tabbed shell graduated into the supported product in v2.0.0.
      // Keep it in this manifest so a build that explicitly disables it still
      // fails closed, without tying the shell to unrelated dev tools.
      shell: true,
      // The embedded KödBrowser pane (issue #62) is archived: public builds
      // ship without it, and the code stays here so it can be revived.
      browser: enabled,
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
