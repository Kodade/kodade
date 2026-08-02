// KödChat's file-drop registration, mirroring terminal/drop-target.ts: the
// pane registers its DOM region plus a handler, and the global drop router
// (store/drop-routing.ts) hit-tests against it. Dropped paths become composer
// attachments instead of new projects.

import type { DropPosition } from "../ipc/contract";
import { detectMacPlatform } from "../shortcuts/bindings";

type ChatDropTarget = {
  element: HTMLElement;
  onPaths(paths: string[]): void;
};

let chatDropTarget: ChatDropTarget | null = null;

export function setChatDropTarget(
  element: HTMLElement,
  onPaths: (paths: string[]) => void,
): void {
  chatDropTarget = { element, onPaths };
}

export function clearChatDropTarget(element?: HTMLElement): void {
  if (!element || chatDropTarget?.element === element) chatDropTarget = null;
}

// Same platform note as the terminal target: Tauri types positions as
// physical pixels, but macOS delivers logical points from WKWebView, so only
// non-macOS positions are scaled before the CSS-pixel DOMRect test.
export function chatDropHandler(
  position: DropPosition,
  isMac = detectMacPlatform(),
): ((paths: string[]) => void) | null {
  const target = chatDropTarget;
  if (!target) return null;

  const scale = isMac ? 1 : window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  const rect = target.element.getBoundingClientRect();
  const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  return inside ? target.onPaths : null;
}
