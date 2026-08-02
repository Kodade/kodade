// General: appearance and workspace chrome. Both controls write straight to
// the stores that already own them (theme store, projects document).

import { useStore } from "zustand";
import { appStore } from "../../store/appStore";
import { ThemePicker } from "../ThemePicker";
import { SettingsCard, SettingsRow } from "./SettingsCard";

export function GeneralSection() {
  const sidebarMode = useStore(appStore, (state) => state.sidebarMode);

  return (
    <div className="space-y-4">
      <SettingsCard title="appearance">
        <SettingsRow
          name="Theme"
          description="Follow the system appearance or pick one of the Ködade themes."
        >
          <div className="w-56">
            <ThemePicker />
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="workspace">
        <SettingsRow
          name="Projects sidebar"
          description="Show the full project and workspace list, or a compact icon rail."
        >
          <select
            aria-label="Projects sidebar mode"
            value={sidebarMode}
            onChange={(event) =>
              appStore
                .getState()
                .setSidebarMode(event.target.value as "full" | "rail")
            }
            className="w-56 rounded border border-border bg-bg px-2 py-1 text-xs text-text-dim hover:text-text focus:text-text focus:outline-none"
          >
            <option value="full">Full list</option>
            <option value="rail">Icon rail</option>
          </select>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
