// Pure combo-matching tests: parsing, mac Mod handling, exact-modifier
// matching, and the terminal-focus gate. No DOM, no stores.

import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalKeyForCode,
  eventMatchesCombo,
  matchEvent,
  parseCombo,
  type KeyEventLike,
} from "./match";
import { BINDINGS, setComboOverrides } from "./bindings";

afterEach(() => setComboOverrides({}));

// Build a KeyEventLike with everything off, then override.
function ev(over: Partial<KeyEventLike>): KeyEventLike {
  return { key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over };
}

describe("parseCombo", () => {
  it("splits modifiers and lowercases single-letter keys", () => {
    expect(parseCombo("Mod-t")).toMatchObject({ mod: true, key: "t" });
    expect(parseCombo("Mod-T")).toMatchObject({ mod: true, key: "t" });
  });

  it("keeps named keys and bracket keys verbatim", () => {
    expect(parseCombo("Mod-Alt-ArrowUp")).toMatchObject({
      mod: true,
      alt: true,
      key: "ArrowUp",
    });
    expect(parseCombo("Mod-Shift-]")).toMatchObject({ mod: true, shift: true, key: "]" });
  });
});

describe("eventMatchesCombo — mac Mod handling", () => {
  const combo = parseCombo("Mod-t");

  it("Mod is Cmd (metaKey) on mac", () => {
    expect(eventMatchesCombo(ev({ key: "t", metaKey: true }), combo, true)).toBe(true);
    // Ctrl on mac is NOT Mod — the shell owns Ctrl chords.
    expect(eventMatchesCombo(ev({ key: "t", ctrlKey: true }), combo, true)).toBe(false);
  });

  it("Mod is Ctrl on non-mac", () => {
    expect(eventMatchesCombo(ev({ key: "t", ctrlKey: true }), combo, false)).toBe(true);
    expect(eventMatchesCombo(ev({ key: "t", metaKey: true }), combo, false)).toBe(false);
  });
});

describe("eventMatchesCombo — exact modifiers, no partials", () => {
  it("a Mod-Shift combo does not match Mod alone", () => {
    const combo = parseCombo("Mod-Shift-]");
    expect(eventMatchesCombo(ev({ key: "]", metaKey: true, shiftKey: true }), combo, true)).toBe(
      true,
    );
    // Missing Shift → no match (partial modifiers never match).
    expect(eventMatchesCombo(ev({ key: "]", metaKey: true }), combo, true)).toBe(false);
  });

  it("a Mod combo does not match when an extra modifier is held", () => {
    const combo = parseCombo("Mod-t");
    // Cmd+Alt+T is not Cmd+T.
    expect(eventMatchesCombo(ev({ key: "t", metaKey: true, altKey: true }), combo, true)).toBe(
      false,
    );
  });

  it("Mod-Alt-Arrow requires both Cmd and Alt", () => {
    const combo = parseCombo("Mod-Alt-ArrowDown");
    expect(
      eventMatchesCombo(ev({ key: "ArrowDown", metaKey: true, altKey: true }), combo, true),
    ).toBe(true);
    expect(eventMatchesCombo(ev({ key: "ArrowDown", metaKey: true }), combo, true)).toBe(false);
  });
});

describe("matchEvent — table lookup + terminal-focus gate", () => {
  it("maps the real chords to their action ids (mac)", () => {
    const t = { isMac: true, terminalFocused: false };
    expect(matchEvent(ev({ key: "t", metaKey: true }), t)).toBe("new-session");
    expect(matchEvent(ev({ key: "s", metaKey: true }), t)).toBe("save-file");
    expect(matchEvent(ev({ key: "]", metaKey: true, shiftKey: true }), t)).toBe("next-session");
    expect(matchEvent(ev({ key: "[", metaKey: true, shiftKey: true }), t)).toBe("prev-session");
    expect(matchEvent(ev({ key: "ArrowDown", metaKey: true, altKey: true }), t)).toBe(
      "next-project",
    );
    expect(matchEvent(ev({ key: "ArrowUp", metaKey: true, altKey: true }), t)).toBe(
      "prev-project",
    );
  });

  it("no match for an unbound chord", () => {
    expect(matchEvent(ev({ key: "q", metaKey: true }), { isMac: true, terminalFocused: false })).toBe(
      null,
    );
  });

  it("terminal focus lets Cmd chords through but blocks nothing bare here", () => {
    // App chords still fire while the terminal is focused (deliberate chords).
    expect(matchEvent(ev({ key: "t", metaKey: true }), { isMac: true, terminalFocused: true })).toBe(
      "new-session",
    );
  });

  it("terminal focus does not swallow bare keys or plain Ctrl combos", () => {
    // A bare key: not an app chord, and with a terminal focused it must be
    // ignored so the shell receives it. (None of our combos are bare anyway.)
    expect(matchEvent(ev({ key: "a" }), { isMac: true, terminalFocused: true })).toBe(null);
    // Ctrl+C on mac is a shell signal, never an app chord.
    expect(matchEvent(ev({ key: "c", ctrlKey: true }), { isMac: true, terminalFocused: true })).toBe(
      null,
    );
  });
});

describe("matchEvent — KödWhisper overrides", () => {
  it("matches the effective push-to-talk combo instead of its default", () => {
    setComboOverrides({ "push-to-talk": "Mod-Alt-v" });
    const opts = { isMac: true, terminalFocused: true };

    expect(matchEvent(ev({ key: "v", metaKey: true, altKey: true }), opts)).toBe(
      "push-to-talk",
    );
    expect(matchEvent(ev({ key: "m", metaKey: true, shiftKey: true }), opts)).toBeNull();
  });
});

// Review round: shifted punctuation and autorepeat.
describe("shifted brackets and autorepeat", () => {
  it("maps bracket key codes back to their canonical combo keys", () => {
    expect(canonicalKeyForCode("BracketRight")).toBe("]");
    expect(canonicalKeyForCode("BracketLeft")).toBe("[");
    expect(canonicalKeyForCode("KeyM")).toBeNull();
  });

  it("matches Mod-Shift-] via event.code when Shift turns key into '}'", () => {
    // US layout: ⌘⇧] reports key "}" — the physical code must still match.
    const id = matchEvent(
      { key: "}", code: "BracketRight", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
      { isMac: true, terminalFocused: false },
    );
    expect(id).toBe("next-session");
    const prev = matchEvent(
      { key: "{", code: "BracketLeft", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
      { isMac: true, terminalFocused: false },
    );
    expect(prev).toBe("prev-session");
  });

  it("ignores autorepeat keydowns — one action per physical press", () => {
    const id = matchEvent(
      { key: "t", repeat: true, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      { isMac: true, terminalFocused: false },
    );
    expect(id).toBeNull();
  });
});

// --- Editor tab bindings (v1.1) ---
describe("editor tab bindings", () => {
  it("the tab actions are present in the binding table", () => {
    const ids = new Set(BINDINGS.map((b) => b.id));
    expect(ids.has("close-tab")).toBe(true);
    expect(ids.has("next-tab")).toBe(true);
    expect(ids.has("prev-tab")).toBe(true);
  });

  it("Mod-w closes the active tab", () => {
    const id = matchEvent(
      { key: "w", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      { isMac: true, terminalFocused: false },
    );
    expect(id).toBe("close-tab");
  });

  it("Ctrl-Tab / Ctrl-Shift-Tab cycle tabs when nothing terminal is focused", () => {
    expect(
      matchEvent(
        { key: "Tab", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
        { isMac: true, terminalFocused: false },
      ),
    ).toBe("next-tab");
    expect(
      matchEvent(
        { key: "Tab", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { isMac: true, terminalFocused: false },
      ),
    ).toBe("prev-tab");
  });

  it("Ctrl-Tab does NOT fire while a terminal is focused (belongs to the shell)", () => {
    // Ctrl-based (non-Mod) chords are gated out when the terminal owns focus,
    // exactly like bare keys — the shell keeps them.
    expect(
      matchEvent(
        { key: "Tab", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
        { isMac: true, terminalFocused: true },
      ),
    ).toBeNull();
  });

  it("Mod-w still fires while a terminal is focused (it IS an app chord)", () => {
    // Cmd+W is Mod-based, so it survives the gate (otherwise the shell would
    // never get a close-tab and Cmd+W would close the whole window).
    expect(
      matchEvent(
        { key: "w", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        { isMac: true, terminalFocused: true },
      ),
    ).toBe("close-tab");
  });
});
