// Wires the official web-links addon into a terminal so printed URLs (dev
// server links, gh issue/PR URLs, deploy URLs) are clickable like in any
// other terminal app. Plain click keeps today's focus/selection behavior;
// the platform modifier (Cmd on macOS, Ctrl elsewhere) is required to open.
// Opening always routes through Rust (never webview navigation) and is
// restricted to http/https — see isAllowedExternalUrl.

import { WebLinksAddon } from "@xterm/addon-web-links";
import { isAllowedExternalUrl } from "../markdown/links";
import { externalUrls } from "../ipc/transport";
import { detectMacPlatform } from "../shortcuts/bindings";

// True when the platform's "open link" modifier is held: Cmd on macOS, Ctrl
// elsewhere — matches Terminal.app/iTerm2/VS Code/Warp's Cmd/Ctrl+click.
export function hasLinkModifier(
  event: MouseEvent,
  isMac = detectMacPlatform(),
): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

// Injectable opener so tests can assert on calls without a Tauri runtime.
export function createTerminalWebLinksAddon(
  openUrl: (url: string) => Promise<void> = externalUrls.openUrl,
  isMac = detectMacPlatform(),
): WebLinksAddon {
  return new WebLinksAddon((event, uri) => {
    if (!hasLinkModifier(event, isMac)) return;
    if (!isAllowedExternalUrl(uri)) return; // http/https only; Rust re-validates
    void openUrl(uri);
  });
}
