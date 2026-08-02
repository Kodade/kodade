import type { BrowserBounds } from "../ipc/contract";

export type BrowserViewportDecision = "idle" | "hide" | "place";

// Keep the native overlay out of the window when its DOM viewport collapses.
// A blank browser has no native child yet, so resize events are inert there.
export function browserViewportDecision(
  url: string,
  bounds: BrowserBounds,
  covered: boolean,
): BrowserViewportDecision {
  if (!url) return "idle";
  if (covered) return "hide";
  return bounds.width > 0 && bounds.height > 0 ? "place" : "hide";
}
