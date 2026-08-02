// KödLocal: the existing embedded-model manager, unchanged, on its own page.

import { LocalModelsSection } from "../../local/LocalModels";
import { SettingsPanel } from "./SettingsCard";

export function LocalSection() {
  return (
    <SettingsPanel>
      <LocalModelsSection />
    </SettingsPanel>
  );
}
