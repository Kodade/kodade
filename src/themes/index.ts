// The theme registry: one Ködade look in a light and a dark variant, plus the
// implicit "system" selection that follows the OS. Order here is the order the
// settings picker shows (System first, then these).

import type { Theme } from "./schema";
import { kodadeLight } from "./kodade-light";
import { kodadeDark } from "./kodade-dark";

export const THEMES: Theme[] = [kodadeLight, kodadeDark];

export const THEMES_BY_ID: Record<string, Theme> = Object.fromEntries(
  THEMES.map((t) => [t.id, t]),
);

// System-following pairing. Ids persisted before the six-theme collapse (e.g.
// "catppuccin-mocha") coerce back to "system" in the store, so old installs
// land on the right appearance with zero migration.
export const SYSTEM_DARK_THEME = kodadeDark;
export const SYSTEM_LIGHT_THEME = kodadeLight;

export type { Theme } from "./schema";
export * from "./schema";
