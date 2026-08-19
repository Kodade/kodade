import {
  RELEASE_MANIFEST,
  developmentFeatureEnabled,
  type DevelopmentFeature,
  type ReleaseManifest,
} from "./manifest";

const FEATURE_NAMES: Record<DevelopmentFeature, string> = {
  local: "KödLocal",
  voice: "KödWhisper",
  ssh: "KödSSH",
  work: "KödWork",
  // UI-only feature: it has no IPC group of its own, but the registry stays
  // exhaustive so a future guarded call reads correctly.
  shell: "Ködade v2 shell",
  browser: "KödBrowser",
};

export function unavailableFeatureError(feature: DevelopmentFeature): Error {
  return new Error(
    `${FEATURE_NAMES[feature]} is unavailable in the public release`,
  );
}

// IPC groups are method-only objects. A disabled group keeps the same static
// contract while rejecting before native execution can be reached.
export function guardDevelopmentIpc<T extends object>(
  feature: DevelopmentFeature,
  implementation: T,
  manifest: ReleaseManifest = RELEASE_MANIFEST,
): T {
  if (developmentFeatureEnabled(feature, manifest)) return implementation;
  return new Proxy(implementation, {
    get: () => () => Promise.reject(unavailableFeatureError(feature)),
  });
}
