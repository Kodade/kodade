// Account: plan and license today; the future home of the user profile surface.

import { LicenseSection } from "../LicenseSection";
import { SettingsPanel } from "./SettingsCard";

export function AccountSection() {
  return (
    <SettingsPanel>
      <LicenseSection />
    </SettingsPanel>
  );
}
