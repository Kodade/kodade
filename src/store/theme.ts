// Theme store (Zustand vanilla, headless-testable). Owns the theme SELECTION
// ("system" or a specific theme id) and RESOLUTION (selection + OS appearance
// -> a concrete Theme). Everything with side effects — reading the system
// appearance, applying tokens to the DOM/xterm/CodeMirror, and persisting the
// choice — is injected, so tests drive the logic against fakes. Components are
// thin views: they read `selection`/`resolved` and call setSelection().

import { createStore } from "zustand/vanilla";
import {
  THEMES,
  THEMES_BY_ID,
  SYSTEM_DARK_THEME,
  SYSTEM_LIGHT_THEME,
  type Theme,
} from "../themes";

// "system" follows the OS; any other value is a theme id (validated on use).
export type ThemeSelection = "system" | string;

export type ThemeDeps = {
  // True when the OS is in dark mode. Injected so tests don't need matchMedia.
  prefersDark: () => boolean;
  // Persist the selection string (fire-and-forget; wired to the projects doc).
  save: (selection: ThemeSelection) => void;
  // Apply a resolved theme to the world (CSS vars, xterm, CodeMirror). Injected
  // so the store stays pure/testable; the real one lives in appStore wiring.
  apply: (theme: Theme) => void;
};

export type ThemeState = {
  selection: ThemeSelection; // what the user picked
  resolved: Theme; // the concrete theme in effect right now
  themes: Theme[]; // list for the picker (stable order)

  setSelection(selection: ThemeSelection): void;
  // Called by the matchMedia listener when the OS flips dark/light. Only has an
  // effect while following the system.
  systemAppearanceChanged(): void;
  // Force-apply the current resolved theme (initial paint on boot). Does not
  // persist — nothing changed, we're just pushing the theme to the surfaces.
  reapply(): void;
};

// Resolve a selection + current OS appearance to a concrete theme. An unknown
// or missing id falls back to system-following (tolerant of stale/garbage
// persisted values) — this is the round-trip validation the spec asks for.
export function resolveTheme(selection: ThemeSelection, prefersDark: boolean): Theme {
  if (selection && selection !== "system") {
    const picked = THEMES_BY_ID[selection];
    if (picked) return picked;
    // Unknown id → fall through to system default.
  }
  return prefersDark ? SYSTEM_DARK_THEME : SYSTEM_LIGHT_THEME;
}

// A selection that resolves (known id or "system"). An unknown/stale id is
// coerced to "system" so the picker matches reality and OS appearance changes
// keep working — resolveTheme alone would silently retain the dead id.
function coerceSelection(selection: ThemeSelection): ThemeSelection {
  return selection === "system" || THEMES_BY_ID[selection] ? selection : "system";
}

export function createThemeStore(deps: ThemeDeps, initialSelection: ThemeSelection = "system") {
  const initialEffective = coerceSelection(initialSelection);
  const initial = resolveTheme(initialEffective, deps.prefersDark());

  return createStore<ThemeState>((set, get) => {
    // Resolve, store, apply, and (optionally) persist. Applies only when the
    // resolved theme actually changed so a redundant system event doesn't churn.
    const applySelection = (selection: ThemeSelection, persist: boolean) => {
      const effective = coerceSelection(selection);
      const resolved = resolveTheme(effective, deps.prefersDark());
      const themeChanged = resolved.id !== get().resolved.id;
      set({ selection: effective, resolved });
      if (themeChanged) deps.apply(resolved);
      if (persist) deps.save(effective);
    };

    return {
      selection: initialEffective,
      resolved: initial,
      themes: THEMES,

      setSelection(selection: ThemeSelection) {
        applySelection(selection, true);
      },

      systemAppearanceChanged() {
        // Re-resolve without persisting: only the derived theme changed, not
        // the user's choice. A no-op unless we're following the system.
        if (get().selection !== "system") return;
        applySelection("system", false);
      },

      reapply() {
        deps.apply(get().resolved);
      },
    };
  });
}
