// Injectable native capability state. Production desktop runs unrestricted;
// tests can supply a constrained profile to verify honest degradation.

import { createStore } from "zustand/vanilla";
import type { PlatformCapabilities } from "../ipc/contract";
import { isTauriRuntime } from "../ipc/transport";
import { developmentFeatureEnabled } from "../release/manifest";

export type CapabilitiesState = {
  capabilities: PlatformCapabilities | null;
  setCapabilities(capabilities: PlatformCapabilities): void;
};

export const capabilitiesStore = createStore<CapabilitiesState>((set) => ({
  capabilities: null,
  setCapabilities: (capabilities) => set({ capabilities }),
}));

export function canPickFolder(caps: PlatformCapabilities | null): boolean {
  return caps ? caps.pickFolder : true;
}
export function canRevealInOs(caps: PlatformCapabilities | null): boolean {
  return caps ? caps.revealInOs : true;
}
// Module-private: browserPaneAvailable is the only legitimate consumer, so no
// caller can check the platform capability while skipping the feature gate.
function canUseBrowserPane(caps: PlatformCapabilities | null): boolean {
  return caps ? caps.browser : true;
}

// The embedded browser is archived (#62): it needs both the compiled feature
// and a platform that can host the native child view. Every UI decision about
// the browser pane reads this, so a build without the feature has no button,
// no pane, and no in-app link target.
export function browserPaneAvailable(
  caps: PlatformCapabilities | null,
): boolean {
  return developmentFeatureEnabled("browser") && canUseBrowserPane(caps);
}

// The bundled `kodade-mcp` path belongs to the desktop installation.
export function canConfigureMemoryMcp(caps: PlatformCapabilities | null): boolean {
  return isTauriRuntime() && caps === null;
}
