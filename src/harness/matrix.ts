// The multi-CLI matrix projection (M10c): a pure function from a flat
// artifact list to display rows. Exact shared paths collapse naturally.
// Skills additionally collapse when they resolve to the same symlink target or
// carry the same validated managed-copy identity. Physical aliases stay on the
// row so mutation UI can avoid pretending one toggle controls several paths.
// Never stored, always recomputed at view time from the scanned inventory.

import type { ArtifactKind, HarnessArtifact } from "./model";

export type MatrixRow = {
  identity: string;
  kind: ArtifactKind;
  path: string;
  // Every physical alias represented by this logical row. More than one path
  // means a single enable/disable button would be misleading.
  paths: string[];
  // The artifact used for display (name, detail, status): the first one
  // encountered for this (kind, path), in `clis` column order.
  representative: HarnessArtifact;
  // cli id -> the artifact that CLI has at this row's path. Absent entries
  // render as "not present" (the "–" cell).
  cells: Partial<Record<string, HarnessArtifact>>;
};

// Group artifacts sharing one logical identity into a matrix row, restricted
// to `clis` (the entitled/detected column roster — order fixes column order).
// Row order is first-seen order across the filtered artifact list.
export function projectMatrix(
  artifacts: readonly HarnessArtifact[],
  clis: readonly string[],
): MatrixRow[] {
  const allowed = new Set(clis);
  const order: string[] = [];
  const rows = new Map<string, MatrixRow>();

  for (const artifact of artifacts) {
    if (!allowed.has(artifact.cli)) continue;
    const key = rowIdentity(artifact);
    let row = rows.get(key);
    if (!row) {
      row = {
        identity: key,
        kind: artifact.kind,
        path: artifact.path,
        paths: [artifact.path],
        representative: artifact,
        cells: {},
      };
      rows.set(key, row);
      order.push(key);
    } else if (!row.paths.includes(artifact.path)) {
      row.paths.push(artifact.path);
    }
    row.cells[artifact.cli] = artifact;
  }

  return order.map((key) => rows.get(key)!);
}

function rowIdentity(artifact: HarnessArtifact): string {
  if (artifact.kind === "skill") {
    if (artifact.canonicalGroupId) {
      return `skill:managed:${artifact.canonicalGroupId}`;
    }
    if (
      artifact.status !== "orphaned-symlink" &&
      artifact.source.via === "symlink" &&
      artifact.source.target
    ) {
      return `skill:symlink:${artifact.source.target}`;
    }
  }
  return `${artifact.kind}:path:${artifact.path}`;
}
