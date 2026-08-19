// Rules for the v2 shell's Editor tab (issue #62, slice d).
//
// Pure and headless on purpose: no React and no store instance, so both rules
// below are testable against the real files store without rendering the shell.

import type { Tab } from "../../store/tabs";

// The slice of files-store state these rules read. Field names match the real
// store so a subscriber can hand its (state, prevState) pair straight in.
export interface TabActivationState {
  openIntentCount: number;
}

/**
 * True when a files-store write was a deliberate "put this on the editor
 * surface" gesture: the GitHub/review/browser tab actions, or opening a file.
 *
 * The store bumps `openIntentCount` inside the same write as the activation it
 * belongs to (see files.ts), so intent is stated rather than inferred from the
 * shape of the write. Everything else is inert by construction — in-page
 * browser navigation (setBrowserUrl), a close activating the neighbor, the
 * cycle shortcut, the tab strip, project re-seeds, and boot tab restore all
 * leave the count alone.
 *
 * Deliberately NOT conditioned on `activeTab` changing: pressing the title
 * bar's GitHub button while that tab is already the files store's active one
 * is still a request to look at it.
 */
export function isEditorOpenIntent(
  next: TabActivationState,
  prev: TabActivationState,
): boolean {
  return next.openIntentCount !== prev.openIntentCount;
}

/** The `editor.panels` flags implied by the tabs that are actually open. */
export function panelFlagsFor(live: Tab[]): {
  github: boolean;
  review: boolean;
} {
  return {
    github: live.some((tab) => tab.kind === "github"),
    review: live.some((tab) => tab.kind === "review"),
  };
}
