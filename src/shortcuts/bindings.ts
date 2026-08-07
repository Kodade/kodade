// The single source of truth for app keyboard shortcuts (M6a). The binding
// table below is read by BOTH the keydown dispatcher (to run handlers) and the
// UI (tooltips, the shortcuts popover) — nothing hardcodes a key combo twice.
//
// A combo is written "Mod-first" like CodeMirror: modifiers in a fixed order
// then the key, e.g. "Mod-t", "Mod-Shift-]", "Mod-Alt-ArrowUp". `Mod` is the
// platform command modifier — Cmd on macOS, Ctrl elsewhere. Matching lives in
// match.ts (pure, testable). Handlers are wired to store actions via an
// injected ShortcutActions object so the dispatcher stays headless-testable.

import {
  RELEASE_MANIFEST,
  type ReleaseManifest,
} from "../release/manifest";

export type ActionId =
  | "toggle-sidebar"
  | "toggle-files"
  | "new-session"
  | "save-file"
  | "next-session"
  | "prev-session"
  | "next-project"
  | "prev-project"
  | "close-tab"
  | "next-tab"
  | "prev-tab"
  | "push-to-talk"
  | "push-to-talk-command";

// The store-facing surface the dispatcher calls. Injected (real wiring in
// appStore, fakes in tests) so no shortcut logic imports a live store.
export type ShortcutActions = {
  toggleSidebar(): void; // switch between the full projects list and icon rail
  toggleFiles(): void; // collapse/expand the right files pane
  newSession(): void; // open a new terminal in the active project
  saveFile(): void; // save the editor's open file
  nextSession(): void; // switch to the next session in the active project
  prevSession(): void; // switch to the previous session
  nextProject(): void; // switch to the next project
  prevProject(): void; // switch to the previous project
  closeTab(): void; // close the active editor tab
  nextTab(): void; // switch to the next editor tab
  prevTab(): void; // switch to the previous editor tab
  startVoice(): void; // start a hold-to-talk capture
  startVoiceCommand(): void; // start a hold-to-talk capture in command mode (Pro)
  stopVoice(): void; // finish capture when the key is released
};

// The push-to-talk bindings — both keys start a capture on keydown and finish
// it on keyup. Tracked together so either can be the "held" key (M9f).
export const PUSH_TO_TALK_IDS: ActionId[] = [
  "push-to-talk",
  "push-to-talk-command",
];

export type Binding = {
  id: ActionId;
  combo: string; // Mod-first combo string (see match.ts)
  description: string; // human sentence for the shortcuts popover
  run(actions: ShortcutActions): void;
};

// Declarative table — order here is the order shown in the popover.
const ALL_BINDINGS: Binding[] = [
  {
    id: "toggle-sidebar",
    combo: "Mod-b",
    description: "Toggle projects sidebar",
    run: (a) => a.toggleSidebar(),
  },
  {
    id: "toggle-files",
    combo: "Mod-Shift-b",
    description: "Toggle files sidebar",
    run: (a) => a.toggleFiles(),
  },
  {
    id: "new-session",
    combo: "Mod-t",
    description: "New terminal session",
    run: (a) => a.newSession(),
  },
  {
    id: "save-file",
    combo: "Mod-s",
    description: "Save file",
    run: (a) => a.saveFile(),
  },
  {
    id: "next-session",
    combo: "Mod-Shift-]",
    description: "Next session",
    run: (a) => a.nextSession(),
  },
  {
    id: "prev-session",
    combo: "Mod-Shift-[",
    description: "Previous session",
    run: (a) => a.prevSession(),
  },
  {
    id: "next-project",
    combo: "Mod-Alt-ArrowDown",
    description: "Next project",
    run: (a) => a.nextProject(),
  },
  {
    id: "prev-project",
    combo: "Mod-Alt-ArrowUp",
    description: "Previous project",
    run: (a) => a.prevProject(),
  },
  {
    // Editor tabs (v1.1). Mod-w closes the active tab — an app chord, so it
    // still fires with the terminal focused (Cmd+W would otherwise close the
    // window). Close is only meaningful when a tab is open; the store no-ops
    // otherwise.
    id: "close-tab",
    combo: "Mod-w",
    description: "Close tab",
    run: (a) => a.closeTab(),
  },
  {
    // Ctrl-Tab / Ctrl-Shift-Tab cycle tabs. These are explicit-Ctrl (NOT Mod)
    // chords, so isAppChord() reports false and the terminal-focus gate lets the
    // shell keep them while a terminal is focused — matching how bare/Ctrl combos
    // are meant to belong to the shell. They only act when the editor/tree owns
    // focus (or nothing terminal does).
    id: "next-tab",
    combo: "Ctrl-Tab",
    description: "Next tab",
    run: (a) => a.nextTab(),
  },
  {
    id: "prev-tab",
    combo: "Ctrl-Shift-Tab",
    description: "Previous tab",
    run: (a) => a.prevTab(),
  },
  {
    id: "push-to-talk",
    combo: "Mod-Shift-m",
    description: "Hold to talk",
    run: (a) => a.startVoice(),
  },
  {
    // KödWhisper Pro voice commands (M9f). A separate hold-to-talk key puts the
    // capture in command mode — an explicit mode key, never heuristic guessing.
    id: "push-to-talk-command",
    combo: "Mod-Shift-k",
    description: "Hold to talk — command mode (Pro)",
    run: (a) => a.startVoiceCommand(),
  },
];

export function bindingsFor(
  manifest: ReleaseManifest = RELEASE_MANIFEST,
): Binding[] {
  return manifest.features.voice
    ? ALL_BINDINGS
    : ALL_BINDINGS.filter((binding) => !PUSH_TO_TALK_IDS.includes(binding.id));
}

export const BINDINGS = bindingsFor();

// KödWhisper stores its two hold-to-talk choices with voice preferences rather
// than mutating the declarative binding table. The table remains the canonical
// default source; this small layer supplies the effective runtime combo.
let comboOverrides: Partial<Record<ActionId, string>> = {};

// While a settings recorder is capturing a chord, the dispatcher must not run bindings.
let shortcutCaptureActive = false;

export function setComboOverrides(overrides: Partial<Record<ActionId, string>>): void {
  comboOverrides = { ...overrides };
}

export function setShortcutCaptureActive(active: boolean): void {
  shortcutCaptureActive = active;
}

export function isShortcutCaptureActive(): boolean {
  return shortcutCaptureActive;
}

export function comboFor(id: ActionId): string {
  const binding = BINDINGS.find((item) => item.id === id);
  return comboOverrides[id] ?? binding?.combo ?? "";
}

// navigator may be absent in headless contexts; non-mac is the conservative
// default because Ctrl labels remain readable everywhere.
export function detectMacPlatform(): boolean {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return (
    /Mac|iPhone|iPad|iPod/.test(nav?.platform ?? "") ||
    /Mac OS X/.test(nav?.userAgent ?? "")
  );
}

const MAC_KEYS: Record<string, string> = {
  Tab: "⇥",
  ArrowDown: "↓",
  ArrowUp: "↑",
};

const WINDOWS_KEYS: Record<string, string> = {
  Tab: "Tab",
  ArrowDown: "Down",
  ArrowUp: "Up",
};

export function labelForCombo(
  combo: string,
  isMac = detectMacPlatform(),
): string {
  const tokens = combo.split("-");
  const key = tokens.pop() ?? "";
  if (isMac) {
    const modifiers = tokens
      .map(
        (token) =>
          ({ Mod: "⌘", Ctrl: "⌃", Shift: "⇧", Alt: "⌥" })[token] ?? token,
      )
      .join("");
    return `${modifiers}${MAC_KEYS[key] ?? key.toUpperCase()}`;
  }
  const modifiers = tokens.map((token) => (token === "Mod" ? "Ctrl" : token));
  return [...modifiers, WINDOWS_KEYS[key] ?? key.toUpperCase()].join("+");
}

// Lookup a platform-native display label by action id (for tooltips/menus).
export function labelFor(id: ActionId, isMac = detectMacPlatform()): string {
  return labelForCombo(comboFor(id), isMac);
}
