// Provenance-backed logical identity for skill copies. Physical paths remain
// the mutation boundary; this identity is display-only and never authorizes a
// write or turns an unowned directory into a managed one.

export const KODADE_PROJECT_SKILL_MARKER = ".kodade-skill.json";
export const KODSKILLS_MARKER_NAME = ".kodskills.json";

type FileHash = { path: string; sha256: string };

function validFiles(value: unknown): FileHash[] | null {
  if (!Array.isArray(value)) return null;
  const files: FileHash[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.path !== "string" ||
      record.path.length === 0 ||
      typeof record.sha256 !== "string" ||
      record.sha256.length === 0
    ) {
      return null;
    }
    files.push({ path: record.path, sha256: record.sha256 });
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

export function skillCanonicalGroupId(markerName: string, contents: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const marker = value as Record<string, unknown>;

  if (markerName === KODADE_PROJECT_SKILL_MARKER) {
    if (
      marker.schemaVersion !== 1 ||
      marker.managedBy !== "kodade" ||
      typeof marker.skillId !== "string" ||
      typeof marker.sourceHash !== "string" ||
      marker.skillId.length === 0 ||
      marker.sourceHash.length === 0 ||
      !validFiles(marker.files)
    ) {
      return null;
    }
    return `project-skill:${marker.skillId}:${marker.sourceHash}`;
  }

  if (markerName === KODSKILLS_MARKER_NAME) {
    const files = validFiles(marker.files);
    if (
      marker.schemaVersion !== 1 ||
      typeof marker.pack !== "string" ||
      typeof marker.skillId !== "string" ||
      marker.pack.length === 0 ||
      marker.skillId.length === 0 ||
      !files
    ) {
      return null;
    }
    const fingerprint = files.map((file) => `${file.path}=${file.sha256}`).join("|");
    return `kodskills:${marker.pack}:${marker.skillId}:${fingerprint}`;
  }

  return null;
}
