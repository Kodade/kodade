// Injectable native capability state. Production desktop runs unrestricted;
// tests can supply a constrained profile to verify honest degradation.

import { createStore } from "zustand/vanilla";
import type { PlatformCapabilities } from "../ipc/contract";
import { isTauriRuntime } from "../ipc/transport";

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
export function canUseBrowserPane(caps: PlatformCapabilities | null): boolean {
  return caps ? caps.browser : true;
}

// The bundled `kodade-mcp` path belongs to the desktop installation.
export function canConfigureMemoryMcp(caps: PlatformCapabilities | null): boolean {
  return isTauriRuntime() && caps === null;
}
