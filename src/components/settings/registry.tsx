// The settings section registry: nav order, labels, icons, content component,
// and (where one exists) how to restore that section's defaults. Four sections
// only — General, Providers, Memory, Advanced — with everything else composed
// inside one of them.

import type { ComponentType } from "react";
import {
  RELEASE_MANIFEST,
  developmentFeatureEnabled,
  type ReleaseManifest,
} from "../../release/manifest";
import { appStore, themeStore } from "../../store/appStore";
import { DEFAULT_CHAT_PROVIDER } from "../../store/projects";
import { DEFAULT_LOCAL_MODEL_PREFERENCES } from "../../local/models";
import { DEFAULT_VOICE_PREFERENCES } from "../../voice/models";
import { AdvancedSection } from "./AdvancedSection";
import { ChatSection } from "./ChatSection";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { MemorySection } from "./MemorySection";
import { ChatIcon, ChipIcon, MemoryGlyph, SlidersIcon } from "./icons";

export type SettingsSection = {
  id: string;
  // Nav label. Köd names keep the umlaut.
  label: string;
  // One line under the page header.
  description: string;
  icon: ComponentType;
  Content: ComponentType;
  layout?: "padded" | "full";
  // Omitted when the section has nothing meaningful to reset — the page hides
  // "Restore defaults" for those.
  restoreDefaults?: () => void;
  // Confirm-step wording when "Reset <label> to defaults?" would not say what
  // actually resets (a page that stacks several surfaces).
  restorePrompt?: string;
};

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "general",
    description: "Appearance, workspace chrome, and keyboard shortcuts.",
    icon: SlidersIcon,
    Content: GeneralSettingsSection,
    restoreDefaults: () => {
      themeStore.getState().setSelection("system");
      appStore.getState().setSidebarMode("full");
    },
  },
  {
    id: "providers",
    label: "providers",
    description: "Which agents answer your chats, and where new ones start.",
    icon: ChatIcon,
    Content: ChatSection,
    restoreDefaults: () =>
      appStore.getState().setChatProvider(DEFAULT_CHAT_PROVIDER),
  },
  {
    id: "memory",
    label: "ködmem",
    description: "Local memory and agent access for this project.",
    icon: MemoryGlyph,
    Content: MemorySection,
    layout: "full",
  },
  {
    id: "advanced",
    label: "advanced",
    // Replaced per build by advancedSection() below.
    description: "KödHarness: what your agents read and can use.",
    icon: ChipIcon,
    Content: AdvancedSection,
  },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

// Ids that shipped before the four-section layout. Every one of them still
// resolves, so persisted deep links and older callers land somewhere sane.
const RETIRED_SECTION_IDS = {
  chat: "providers",
  keybindings: "general",
  harness: "advanced",
  local: "advanced",
  voice: "advanced",
  ssh: "advanced",
} as const satisfies Record<string, SettingsSectionId>;

export type RetiredSettingsSectionId = keyof typeof RETIRED_SECTION_IDS;

// Advanced is the one section whose contents depend on the build, so its
// description, its reset, and the wording of that reset are all derived from
// the manifest rather than hard-coded in the entry above.
function advancedSection(
  section: SettingsSection,
  manifest: ReleaseManifest,
): SettingsSection {
  const local = developmentFeatureEnabled("local", manifest);
  const voice = developmentFeatureEnabled("voice", manifest);
  const ssh = developmentFeatureEnabled("ssh", manifest);
  const resettable = [
    ...(local ? ["KödLocal"] : []),
    ...(voice ? ["KödWhisper"] : []),
  ];

  return {
    ...section,
    description: local || voice || ssh
      ? "KödHarness, plus the surfaces still under development."
      : "KödHarness: what your agents read and can use.",
    // A public build (harness alone) has nothing to reset, so it gets no
    // "Restore defaults" button at all.
    restoreDefaults: resettable.length
      ? () => {
          if (local) {
            appStore
              .getState()
              .setLocalModelPreferences(DEFAULT_LOCAL_MODEL_PREFERENCES);
          }
          if (voice) {
            appStore.getState().setVoicePreferences(DEFAULT_VOICE_PREFERENCES);
          }
        }
      : undefined,
    restorePrompt: resettable.length
      ? `Reset ${resettable.join(" and ")} preferences?`
      : undefined,
  };
}

export function availableSettingsSections(
  manifest: ReleaseManifest = RELEASE_MANIFEST,
): readonly SettingsSection[] {
  return SETTINGS_SECTIONS.map((section) =>
    section.id === "advanced" ? advancedSection(section, manifest) : section,
  );
}

export function settingsSection(
  id: SettingsSectionId | RetiredSettingsSectionId,
  manifest: ReleaseManifest = RELEASE_MANIFEST,
): SettingsSection {
  const available = availableSettingsSections(manifest);
  const resolvedId: string =
    RETIRED_SECTION_IDS[id as RetiredSettingsSectionId] ?? id;
  return (
    available.find((section) => section.id === resolvedId) ??
    available[0] ??
    SETTINGS_SECTIONS[0]
  );
}
