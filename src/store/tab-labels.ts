// Pure tab-label helper (v1.1). Given the ordered open-tab paths, compute the
// display label for each: just the basename when unique, or basename plus a
// disambiguating parent-directory suffix when two tabs share a basename
// (e.g. "index.ts — src" vs "index.ts — test"). Kept pure and headless so it's
// unit-testable without React.

import { nativeBasename, nativeDirname } from "../platform/native-path";

// Fixed-kind tabs (github/harness/browser/memory/review) each carry one stable
// display label rather than a disambiguated basename. KödPR's review tab (M12c)
// is one per project, so a single constant is all it needs.
export const REVIEW_TAB_LABEL = "review";
// KödWork task tabs fall back to this when the task's title isn't loaded yet.
export const KODWORK_TAB_LABEL = "KödWork";

function basename(path: string): string {
  return nativeBasename(path);
}

function parentName(path: string): string {
  const parent = nativeDirname(path);
  return parent && nativeDirname(parent) !== null ? nativeBasename(parent) : "";
}

// Map of path -> display label. Basenames that collide across the open set get
// a " — <parent>" suffix; unique basenames stay bare. Deterministic (input
// order preserved), so the same open set always renders the same labels.
export function tabLabels(paths: string[]): Record<string, string> {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const b = basename(p);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const labels: Record<string, string> = {};
  for (const p of paths) {
    const b = basename(p);
    if ((counts.get(b) ?? 0) > 1) {
      const parent = parentName(p);
      labels[p] = parent ? `${b} — ${parent}` : b;
    } else {
      labels[p] = b;
    }
  }
  return labels;
}
