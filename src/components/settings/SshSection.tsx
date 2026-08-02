// KödSSH: the canonical management surface for remote hosts. Reuses the same
// component the projects sidebar renders, so hosts, pins, and connect flows
// behave identically in both places.

import { RemoteHostsSection } from "../RemoteHostsSection";
import { SettingsPanel } from "./SettingsCard";

export function SshSection() {
  return (
    <SettingsPanel>
      <RemoteHostsSection />
    </SettingsPanel>
  );
}
