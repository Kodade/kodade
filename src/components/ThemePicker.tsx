import { useStore } from "zustand";
import { themeStore } from "../store/appStore";

// Unobtrusive theme picker for the sidebar footer: System / Light / Dark.
// "System" follows the OS with zero config. Thin view over the theme store —
// selecting persists and re-skins the whole app live.
export function ThemePicker() {
  const selection = useStore(themeStore, (s) => s.selection);
  const themes = useStore(themeStore, (s) => s.themes);

  return (
    <label className="mt-2 flex shrink-0 items-center gap-2 text-[11px] text-text-dim">
      <span className="shrink-0">theme</span>
      <select
        value={selection}
        onChange={(e) => themeStore.getState().setSelection(e.target.value)}
        className="min-w-0 flex-1 truncate rounded border border-border bg-surface px-2 py-1 text-text-dim hover:text-text focus:text-text focus:outline-none"
      >
        <option value="system">System</option>
        {themes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}
