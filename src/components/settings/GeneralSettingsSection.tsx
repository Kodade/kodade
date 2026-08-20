// General settings page: appearance/workspace chrome first, then the read-only
// keybindings list re-homed beneath it. Both blocks are the untouched
// components they always were — this file only stacks them.

import { GeneralSection } from "./GeneralSection";
import { KeybindingsSection } from "./KeybindingsSection";
import { SettingsBlock } from "./SettingsCard";

export function GeneralSettingsSection() {
  return (
    <div className="space-y-6">
      <GeneralSection />
      <SettingsBlock
        title="keybindings"
        description="Every shortcut Ködade handles."
      >
        <KeybindingsSection />
      </SettingsBlock>
    </div>
  );
}
