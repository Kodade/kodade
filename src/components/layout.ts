// Pure layout helpers for the 4-pane workspace. Kept separate from the React
// component so the size math (defaults, array<->map conversion) tests headless.
//
// The resize library consumes object values in insertion order when applying
// an imperative layout, so this order MUST match the rendered panel order.
export const PANEL_IDS = ["sidebar", "terminal", "editor", "files"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

// Persisted v1 documents predate the visual editor/files swap. Keep their
// array order stable and translate at the map boundary so existing users retain
// the width that belonged to each pane.
const PERSISTED_PANEL_IDS = ["sidebar", "terminal", "files", "editor"] as const;

// Sensible first-run sizes (percentages summing to 100), roughly matching the
// old static grid: narrow sidebar, wide terminal, medium files, wide editor.
export const DEFAULT_SIZES: number[] = [14, 40, 16, 30];

// react-resizable-panels Layout: { panelId: percentage }.
export type Layout = Record<string, number>;

// Rail sizing is intentionally temporary: only a user resize with the full
// sidebar AND an expanded files pane should become that project's remembered
// layout — a fixed 44px rail width must never be recorded as a real size.
export function shouldPersistLayout(
  isUserInteraction: boolean,
  sidebarMode: "full" | "rail",
  filesCollapsed = false,
): boolean {
  return isUserInteraction && sidebarMode === "full" && !filesCollapsed;
}

// Persisted array (panel order) -> Layout map for `defaultLayout`. Falls back
// to defaults when the array is missing or the wrong length (a foreign/older
// doc must not wedge the UI).
export function sizesToLayout(sizes: number[] | undefined): Layout {
  const src =
    sizes && sizes.length === PERSISTED_PANEL_IDS.length ? sizes : DEFAULT_SIZES;
  const layout: Layout = {};
  PANEL_IDS.forEach((id) => {
    const persistedIndex = PERSISTED_PANEL_IDS.indexOf(id);
    layout[id] = src[persistedIndex];
  });
  return layout;
}

// A user can collapse a panel to 0 with the drag handle. The compact rails
// still have a fixed width, but returning to the expanded state must not
// reapply the saved zero and strand the panel off-screen. Restore each
// expanded-but-zero panel's default share and proportionally shrink the other
// panes so the layout still totals 100.
export function sizesToRestoredLayout(
  sizes: number[] | undefined,
  expandIds: readonly PanelId[],
): Layout {
  const layout = sizesToLayout(sizes);
  const restore = expandIds.filter((id) => layout[id] <= 0);
  if (restore.length === 0) return layout;

  const restoredTotal = restore.reduce(
    (total, id) => total + DEFAULT_SIZES[PERSISTED_PANEL_IDS.indexOf(id)],
    0,
  );
  const remaining = PANEL_IDS.filter((id) => !restore.includes(id)).reduce(
    (total, id) => total + layout[id],
    0,
  );
  if (remaining <= 0) return sizesToLayout(undefined);

  const scale = (100 - restoredTotal) / remaining;
  const restored: Layout = {};
  PANEL_IDS.forEach((id) => {
    restored[id] = restore.includes(id)
      ? DEFAULT_SIZES[PERSISTED_PANEL_IDS.indexOf(id)]
      : roundLayoutSize(layout[id] * scale);
  });
  return restored;
}

// Back-compat wrapper: restore only the sidebar (pre-files-toggle behavior).
export function sizesToExpandedSidebarLayout(
  sizes: number[] | undefined,
): Layout {
  return sizesToRestoredLayout(sizes, ["sidebar"]);
}

function roundLayoutSize(value: number): number {
  return Math.round(value * 100) / 100;
}

// Layout map (from onLayoutChanged) -> persisted array in panel order. Any
// panel missing from the map falls back to its default so the array is always
// the right length.
export function layoutToSizes(layout: Layout): number[] {
  return PERSISTED_PANEL_IDS.map((id, i) =>
    typeof layout[id] === "number" ? layout[id] : DEFAULT_SIZES[i],
  );
}
