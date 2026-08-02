// KödWhisper: the existing voice settings panel, bound to the app voice store.

import { voiceStore } from "../../store/appStore";
import { VoiceSettings } from "../../voice/VoiceSettings";
import { SettingsPanel } from "./SettingsCard";

export function VoiceSection() {
  return (
    <SettingsPanel>
      <VoiceSettings store={voiceStore} />
    </SettingsPanel>
  );
}
