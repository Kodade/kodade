// The settings section registry: nav order, labels, icons, content component,
// and (where one exists) how to restore that section's defaults. Adding a
// future section is one entry in this list.

import type { ComponentType } from "react";
import {
  RELEASE_MANIFEST,
  developmentFeatureEnabled,
  type DevelopmentFeature,
  type ReleaseManifest,
} from "../../release/manifest";
import { appStore, themeStore } from "../../store/appStore";
import { DEFAULT_CHAT_PROVIDER } from "../../store/projects";
import { DEFAULT_LOCAL_MODEL_PREFERENCES } from "../../local/models";
import { DEFAULT_VOICE_PREFERENCES } from "../../voice/models";
import { ChatSection } from "./ChatSection";
import { GeneralSection } from "./GeneralSection";
import { HarnessSection } from "./HarnessSection";
import { KeybindingsSection } from "./KeybindingsSection";
import { LocalSection } from "./LocalSection";
import { MemorySection } from "./MemorySection";
import { SshSection } from "./SshSection";
import { VoiceSection } from "./VoiceSection";
import {
  ChatIcon,
  ChipIcon,
  HarnessGlyph,
  KeyboardIcon,
  MemoryGlyph,
  MicIcon,
  RemoteIcon,
  SlidersIcon,
} from "./icons";

export type SettingsSection = {
  id: string;
  // Nav label. Köd names keep the umlaut.
  label: string;
  // One line under the page header.
  description: string;
  icon: ComponentType;
  Content: ComponentType;
  layout?: "padded" | "full";
  developmentFeature?: DevelopmentFeature;
  // Omitted when the section has nothing meaningful to reset — the page hides
  // "Restore defaults" for those.
  restoreDefaults?: () => void;
};

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "general",
    description: "Appearance and workspace chrome.",
    icon: SlidersIcon,
    Content: GeneralSection,
    restoreDefaults: () => {
      themeStore.getState().setSelection("system");
      appStore.getState().setSidebarMode("full");
    },
  },
  {
    id: "chat",
    label: "ködchat",
    description: "Which agents answer your chats, and where new ones start.",
    icon: ChatIcon,
    Content: ChatSection,
    restoreDefaults: () =>
      appStore.getState().setChatProvider(DEFAULT_CHAT_PROVIDER),
  },
  {
    id: "harness",
    label: "ködharness",
    description: "What your agents read and can use.",
    icon: HarnessGlyph,
    Content: HarnessSection,
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
    id: "local",
    label: "ködlocal",
    description: "Embedded local models that run on this machine.",
    icon: ChipIcon,
    Content: LocalSection,
    developmentFeature: "local",
    restoreDefaults: () =>
      appStore
        .getState()
        .setLocalModelPreferences(DEFAULT_LOCAL_MODEL_PREFERENCES),
  },
  {
    id: "voice",
    label: "ködwhisper",
    description: "Voice input, dictation model, and voice commands.",
    icon: MicIcon,
    Content: VoiceSection,
    developmentFeature: "voice",
    restoreDefaults: () =>
      appStore.getState().setVoicePreferences(DEFAULT_VOICE_PREFERENCES),
  },
  {
    id: "ssh",
    label: "ködssh",
    description: "Remote hosts from ~/.ssh/config and saved remote projects.",
    icon: RemoteIcon,
    Content: SshSection,
    developmentFeature: "ssh",
  },
  {
    id: "keybindings",
    label: "keybindings",
    description: "Every shortcut Ködade handles.",
    icon: KeyboardIcon,
    Content: KeybindingsSection,
  },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function availableSettingsSections(
  manifest: ReleaseManifest = RELEASE_MANIFEST,
): readonly SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (section) =>
      (!("developmentFeature" in section) ||
        developmentFeatureEnabled(section.developmentFeature, manifest)),
  );
}

export function settingsSection(
  id: SettingsSectionId | "providers",
  manifest: ReleaseManifest = RELEASE_MANIFEST,
): SettingsSection {
  const available = availableSettingsSections(manifest);
  const resolvedId = id === "providers" ? "chat" : id;
  return (
    available.find((section) => section.id === resolvedId) ??
    available[0] ??
    SETTINGS_SECTIONS[0]
  );
}
