// Which settings section (if any) is showing instead of the workspace.
// Deliberately NOT persisted: opening settings is a transient view change and
// must never touch the saved projects document or pane layout.

import { createStore } from "zustand/vanilla";
import type { SettingsSectionId } from "../components/settings/registry";

export type SettingsViewState = {
  // null = workspace; otherwise the active settings section.
  section: SettingsSectionId | null;
  open(section?: SettingsSectionId): void;
  close(): void;
};

export const settingsViewStore = createStore<SettingsViewState>((set) => ({
  section: null,
  open: (section = "general") => set({ section }),
  close: () => set({ section: null }),
}));
