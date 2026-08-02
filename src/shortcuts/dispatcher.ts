// The keydown dispatcher: a single window listener (capture phase) that turns
// key events into store actions via the binding table. Capture phase lets us
// intercept app chords before xterm/CodeMirror see them; matchEvent() decides
// which events we own so the terminal keeps everything else.
//
// All product wiring is injected (ShortcutActions + an isTerminalFocused probe)
// so the dispatcher is headless-testable: tests dispatch fake events and assert
// which action fired without a real DOM terminal.

import {
  BINDINGS,
  detectMacPlatform,
  isShortcutCaptureActive,
  PUSH_TO_TALK_IDS,
  type ActionId,
  type ShortcutActions,
} from "./bindings";
import { matchEvent, type KeyEventLike } from "./match";

export type DispatcherDeps = {
  actions: ShortcutActions & { cancelVoice?(): void };
  // Is focus currently inside a terminal? Real impl checks the registry host
  // container; while true, only Mod chords match (bare keys pass to the shell).
  isTerminalFocused: (target: EventTarget | null) => boolean;
  // Is focus inside the CodeMirror editor? When true, save-file defers to
  // CodeMirror's own Mod-s keymap (which preventDefaults and saves), so the two
  // save paths coexist without double-firing. Optional — defaults to false.
  isEditorFocused?: (target: EventTarget | null) => boolean;
  isMac?: boolean; // defaults to platform detection
};

// Core handler, exported for direct testing. Returns the matched action id (or
// null) so tests can assert without inspecting side effects.
export function handleKeydown(
  e: KeyboardEvent,
  deps: DispatcherDeps,
): string | null {
  if (isShortcutCaptureActive()) return null;

  const isMac = deps.isMac ?? detectMacPlatform();
  const terminalFocused = deps.isTerminalFocused(e.target);
  const event: KeyEventLike = {
    key: e.key,
    code: e.code,
    repeat: e.repeat,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
  };

  const id = matchEvent(event, { isMac, terminalFocused });
  if (!id) return null;

  const binding = BINDINGS.find((b) => b.id === id);
  if (!binding) return null;

  // Save while the editor is focused: let CodeMirror's own Mod-s keymap own it
  // (it preventDefaults and saves). Bail here so we don't double-fire the save
  // — the event flows on to the editor untouched.
  if (id === "save-file" && deps.isEditorFocused?.(e.target)) return null;

  // We own this chord: stop browser defaults (such as Mod+S / Mod+T) and keep
  // it from reaching the terminal/editor.
  e.preventDefault();
  e.stopPropagation();
  binding.run(deps.actions);
  return id;
}

export type HeldPtt = {
  id: ActionId;
  code?: string;
  key: string;
};

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

// Keyup must match the physical key that started the capture. Re-reading the
// current combo breaks when Shift lifts before punctuation or the binding is
// changed while the key is held. (M9f)
export function handleKeyup(
  e: KeyboardEvent,
  deps: DispatcherDeps,
  heldPtt: HeldPtt | null,
): HeldPtt | null {
  if (!heldPtt) return null;
  const releasedHeldKey = heldPtt.code
    ? e.code === heldPtt.code
    : normalizeKey(e.key) === heldPtt.key;
  if (!releasedHeldKey) return heldPtt;
  e.preventDefault();
  e.stopPropagation();
  deps.actions.stopVoice();
  return null;
}

// Install the capture-phase window listener. Returns an unlisten.
export function installShortcuts(deps: DispatcherDeps): () => void {
  let heldPtt: HeldPtt | null = null;
  const onKeydown = (e: KeyboardEvent) => {
    const id = handleKeydown(e, deps);
    if (id && PUSH_TO_TALK_IDS.includes(id as ActionId)) {
      heldPtt = {
        id: id as ActionId,
        code: e.code || undefined,
        key: normalizeKey(e.key),
      };
    }
  };
  const onKeyup = (e: KeyboardEvent) => {
    heldPtt = handleKeyup(e, deps, heldPtt);
  };
  // A held shortcut has no keyup when the app loses focus. Let the store turn
  // this into a native cancel; it no-ops unless a capture is actually active.
  const onCaptureAbandoned = () => {
    heldPtt = null;
    deps.actions.cancelVoice?.();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") onCaptureAbandoned();
  };
  window.addEventListener("keydown", onKeydown, { capture: true });
  window.addEventListener("keyup", onKeyup, { capture: true });
  window.addEventListener("blur", onCaptureAbandoned);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("keydown", onKeydown, { capture: true });
    window.removeEventListener("keyup", onKeyup, { capture: true });
    window.removeEventListener("blur", onCaptureAbandoned);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
