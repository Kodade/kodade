// Pure combo-matching: turn a keydown event into an ActionId (or null) against
// the binding table. No DOM, no stores — this is the single testable unit that
// decides "did the user press an app chord, and which one?".
//
// A combo string is "Mod-first": zero or more modifiers in the fixed order
// Mod, Alt, Ctrl, Shift, then the key — e.g. "Mod-t", "Mod-Shift-]",
// "Mod-Alt-ArrowUp". `Mod` maps to Cmd (metaKey) on macOS and Ctrl elsewhere.

import { BINDINGS, comboFor, type ActionId } from "./bindings";

// Normalized modifier set a combo requires, plus the bare key.
type ParsedCombo = {
  mod: boolean; // the platform command modifier (Cmd on mac / Ctrl elsewhere)
  alt: boolean;
  ctrl: boolean; // an explicit, non-Mod Ctrl requirement
  shift: boolean;
  key: string; // the non-modifier key, lowercased for letters
  valid: boolean;
};

const MODIFIER_TOKENS = new Set(["Mod", "Alt", "Ctrl", "Shift"]);

// Lowercase single letters so "Mod-t" matches whether or not Shift-casing or
// caps-lock is involved; leave named keys ("ArrowUp", "]") as written.
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

// Shift changes event.key for punctuation (⌘⇧] reports "}" on a US layout),
// so bracket combos also match on the layout-independent event.code.
const KEY_CODES: Record<string, string> = {
  "]": "BracketRight",
  "[": "BracketLeft",
};

const CANONICAL_KEYS_BY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_CODES).map(([key, code]) => [code, key]),
);

// The table above is keyed by canonical combo key. Recording needs the inverse
// lookup so shifted punctuation remains representable in that same vocabulary.
export function canonicalKeyForCode(code: string): string | null {
  return CANONICAL_KEYS_BY_CODE[code] ?? null;
}

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split("-");
  const rawKey = parts.pop() ?? "";
  const mods = new Set(parts);
  return {
    mod: mods.has("Mod"),
    alt: mods.has("Alt"),
    ctrl: mods.has("Ctrl"),
    shift: mods.has("Shift"),
    key: normalizeKey(rawKey),
    valid:
      rawKey.length > 0 &&
      !/\s/.test(rawKey) &&
      !MODIFIER_TOKENS.has(rawKey) &&
      parts.every((part) => MODIFIER_TOKENS.has(part)) &&
      mods.size === parts.length,
  };
}

// A stable comparison key for collision checks. Parsed modifiers make token
// ordering irrelevant while normalized single-letter keys keep casing benign.
export function comboSignature(combo: string): string | null {
  const parsed = parseCombo(combo);
  if (!parsed.valid || !parsed.key) return null;
  return [parsed.mod, parsed.alt, parsed.ctrl, parsed.shift, parsed.key].join(":");
}

// The subset of a KeyboardEvent the matcher reads — lets tests pass plain
// objects instead of synthesizing real events.
export type KeyEventLike = {
  key: string;
  code?: string; // physical key (layout-independent), used for punctuation
  repeat?: boolean; // held-key autorepeat — app chords fire once per press
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

// Does this event satisfy the parsed combo EXACTLY? Every modifier must match
// (a partial-modifier press like Cmd+T when the combo also wants Shift is not a
// match, and a bare-key combo must have no extra modifiers held).
export function eventMatchesCombo(
  e: KeyEventLike,
  parsed: ParsedCombo,
  isMac: boolean,
): boolean {
  // `Mod` is Cmd on mac, Ctrl elsewhere. A combo's Ctrl requirement (rare) is
  // separate; on non-mac, Mod already consumes ctrlKey, so an explicit Ctrl
  // combo can't also be a Mod combo — the table never mixes them.
  const modActive = isMac ? e.metaKey : e.ctrlKey;
  const needMeta = isMac ? parsed.mod : false;
  const needCtrl = isMac ? parsed.ctrl : parsed.mod || parsed.ctrl;

  if (e.metaKey !== needMeta) return false;
  if (e.ctrlKey !== needCtrl) return false;
  if (e.altKey !== parsed.alt) return false;
  if (e.shiftKey !== parsed.shift) return false;
  // Guard: on mac a Mod combo needs metaKey; the checks above already enforce
  // it, but keep the intent explicit.
  if (parsed.mod && !modActive) return false;

  if (normalizeKey(e.key) === parsed.key) return true;
  // Shifted punctuation: fall back to the physical key code so ⌘⇧] matches
  // even though event.key is "}".
  return canonicalKeyForCode(e.code ?? "") === parsed.key;
}

// True when the combo is an app-level command chord — Mod (Cmd/Ctrl) based.
// While a terminal is focused, ONLY these may match; bare keys and plain
// Ctrl-combos belong to the shell.
export function isAppChord(combo: string): boolean {
  const parsed = parseCombo(combo);
  return parsed.valid && parsed.mod;
}

// Match an event to an action id, or null. `terminalFocused` gates: when a
// terminal owns focus, only Mod-based chords are eligible so the shell keeps
// every bare key and Ctrl-combo.
export function matchEvent(
  e: KeyEventLike,
  opts: { isMac: boolean; terminalFocused: boolean },
): ActionId | null {
  // App chords fire once per physical press — a held ⌘T must not spawn a
  // session per autorepeat.
  if (e.repeat) return null;
  for (const binding of BINDINGS) {
    const combo = comboFor(binding.id);
    if (opts.terminalFocused && !isAppChord(combo)) continue;
    const parsed = parseCombo(combo);
    if (parsed.valid && eventMatchesCombo(e, parsed, opts.isMac)) {
      return binding.id;
    }
  }
  return null;
}
