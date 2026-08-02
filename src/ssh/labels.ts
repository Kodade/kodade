import type { RemoteTarget } from "./model";
import { remoteTargetKey } from "./model";

export type RemoteTargetLabel = {
  primary: string;
  secondary: string;
  full: string;
};

type LabelCandidate = {
  target: RemoteTarget;
  key: string;
  segments: string[];
};

// Derive compact labels for a collection of pinned/open remote targets.
// Basenames stay concise; same-host basename collisions grow leftward until
// the path suffix is distinct (normally one parent segment is enough).
export function remoteTargetLabels(
  targets: readonly RemoteTarget[],
): Map<string, RemoteTargetLabel> {
  const candidates = targets.map((target) => ({
    target,
    key: remoteTargetKey(target),
    segments: remotePathSegments(target.path),
  }));
  const byHostAndBasename = new Map<string, LabelCandidate[]>();

  for (const candidate of candidates) {
    const basename = candidate.segments.at(-1) ?? candidate.target.path;
    const groupKey = `${candidate.target.host}\0${basename}`;
    const group = byHostAndBasename.get(groupKey) ?? [];
    group.push(candidate);
    byHostAndBasename.set(groupKey, group);
  }

  const labels = new Map<string, RemoteTargetLabel>();
  for (const candidate of candidates) {
    const basename = candidate.segments.at(-1) ?? candidate.target.path;
    const group =
      byHostAndBasename.get(`${candidate.target.host}\0${basename}`) ?? [];
    let depth = 1;

    while (
      depth < candidate.segments.length &&
      group.some(
        (other) =>
          other.key !== candidate.key &&
          suffix(other.segments, depth) === suffix(candidate.segments, depth),
      )
    ) {
      depth += 1;
    }

    labels.set(candidate.key, {
      primary: suffix(candidate.segments, depth),
      secondary: candidate.target.host,
      full: `${candidate.target.host}:${candidate.target.path}`,
    });
  }

  return labels;
}

function remotePathSegments(path: string): string[] {
  if (path === "/" || path === "~" || /^~\/+$/.test(path)) {
    return [path.startsWith("~") ? "~" : "/"];
  }
  const withoutTrailingSlash = path.replace(/\/+$/, "");
  const segments = withoutTrailingSlash.split("/").filter(Boolean);
  return segments.length > 0 ? segments : [path];
}

function suffix(segments: readonly string[], depth: number): string {
  return segments.slice(-depth).join("/");
}
