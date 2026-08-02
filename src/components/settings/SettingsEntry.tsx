// The settings entry point: gear + "settings" pinned at the bottom of the
// projects sidebar (icon-only in rail mode). Opens the full-page settings view.

import { settingsViewStore } from "../../store/settingsView";
import { GearIcon } from "./icons";

export function SettingsEntry({ compact = false }: { compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => settingsViewStore.getState().open()}
      title="Settings"
      aria-label="Settings"
      className={
        compact
          ? "flex h-7 w-7 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
          : "mt-2 flex w-full shrink-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
      }
    >
      <GearIcon />
      {!compact && <span>settings</span>}
    </button>
  );
}
