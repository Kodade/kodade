import type { DropPosition } from "../ipc/contract";
import { detectMacPlatform } from "../shortcuts/bindings";

let terminalDropTarget: HTMLElement | null = null;

// TerminalPane owns this registration because it owns the DOM region whose
// native drops should become terminal input rather than project additions.
export function setTerminalDropTarget(target: HTMLElement): void {
  terminalDropTarget = target;
}

export function clearTerminalDropTarget(target?: HTMLElement): void {
  if (!target || terminalDropTarget === target) terminalDropTarget = null;
}

// Tauri types positions as PhysicalPosition, but macOS delivers logical points
// from WKWebView while Windows delivers physical pixels. Convert only non-macOS
// positions before testing the CSS-pixel DOMRect.
export function isTerminalDropPosition(
  position: DropPosition,
  isMac = detectMacPlatform(),
): boolean {
  const target = terminalDropTarget;
  if (!target) return false;

  const scale = isMac ? 1 : window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  const rect = target.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
