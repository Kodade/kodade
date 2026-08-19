// Token-schema completeness for both themes and applier output. These pin
// the "a new theme is one fully-populated file" contract: every required key
// present, valid hex, and the applier maps them onto CSS vars + an xterm ITheme
// correctly.

import { describe, expect, it } from "vitest";
import { THEMES, THEMES_BY_ID, SYSTEM_DARK_THEME, SYSTEM_LIGHT_THEME } from "./index";
import { ANSI_KEYS, CHROME_KEYS, SYNTAX_KEYS, TERMINAL_KEYS, UI_KEYS } from "./schema";
import {
  CHROME_VARS,
  CSS_VARS,
  applyCssVars,
  toXtermTheme,
  toCodeMirrorTheme,
  buildHighlightStyle,
} from "./applier";
import { tags as t } from "@lezer/highlight";
import { KODADE_AMBER, KODADE_AMBER_ON_LIGHT } from "./brand";

const HEX = /^#[0-9a-fA-F]{6}$/;
const PX = /^\d+px$/;

describe("theme registry", () => {
  it("ships exactly Light and Dark with unique ids (picker adds System)", () => {
    const ids = THEMES.map((t) => t.id);
    expect(ids).toEqual(["light", "dark"]);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it("system default pairing is Ködade Dark (dark) / Ködade Light (light)", () => {
    expect(SYSTEM_DARK_THEME.id).toBe("dark");
    expect(SYSTEM_DARK_THEME.appearance).toBe("dark");
    expect(SYSTEM_LIGHT_THEME.id).toBe("light");
    expect(SYSTEM_LIGHT_THEME.appearance).toBe("light");
  });

  it("THEMES_BY_ID indexes every theme", () => {
    for (const t of THEMES) expect(THEMES_BY_ID[t.id]).toBe(t);
  });

  it("uses the Ködade logo amber instead of purple for active accents", () => {
    expect(SYSTEM_DARK_THEME.ui.accent).toBe(KODADE_AMBER);
    expect(SYSTEM_LIGHT_THEME.ui.accent).toBe(KODADE_AMBER_ON_LIGHT);
    expect(SYSTEM_DARK_THEME.terminal.ansi.magenta).toBe("#d98a5b");
    expect(SYSTEM_DARK_THEME.terminal.ansi.brightMagenta).toBe(KODADE_AMBER);
    expect(SYSTEM_LIGHT_THEME.terminal.ansi.magenta).toBe(KODADE_AMBER_ON_LIGHT);
    expect(SYSTEM_LIGHT_THEME.terminal.ansi.brightMagenta).toBe("#844617");
    expect(SYSTEM_DARK_THEME.syntax.keyword).toBe(KODADE_AMBER);
    expect(SYSTEM_DARK_THEME.syntax.heading).toBe(KODADE_AMBER);
    expect(SYSTEM_LIGHT_THEME.syntax.keyword).toBe(KODADE_AMBER_ON_LIGHT);
    expect(SYSTEM_LIGHT_THEME.syntax.heading).toBe(KODADE_AMBER_ON_LIGHT);
  });
});

// The completeness contract: run the SAME assertions over every theme so a new
// tokens file can't ship half-filled.
describe.each(THEMES)("theme tokens: $id", (theme) => {
  it("has a name and a dark|light appearance", () => {
    expect(theme.name.length).toBeGreaterThan(0);
    expect(["dark", "light"]).toContain(theme.appearance);
  });

  it("fills every UI token with a hex color", () => {
    for (const key of UI_KEYS) expect(theme.ui[key]).toMatch(HEX);
  });

  it("fills every chrome shape token with a px length", () => {
    for (const key of CHROME_KEYS) expect(theme.chrome[key]).toMatch(PX);
  });

  it("fills every terminal special + all 16 ANSI colors with hex", () => {
    for (const key of TERMINAL_KEYS) expect(theme.terminal[key]).toMatch(HEX);
    for (const key of ANSI_KEYS) expect(theme.terminal.ansi[key]).toMatch(HEX);
  });

  it("fills every syntax token with a hex color", () => {
    for (const key of SYNTAX_KEYS) expect(theme.syntax[key]).toMatch(HEX);
  });
});

describe("applyCssVars", () => {
  it("writes every UI token onto the target as its mapped CSS variable", () => {
    const el = document.createElement("div");
    const theme = SYSTEM_DARK_THEME;
    applyCssVars(theme, el);
    for (const key of UI_KEYS) {
      expect(el.style.getPropertyValue(CSS_VARS[key])).toBe(theme.ui[key]);
    }
    // color-scheme follows the appearance so native controls/scrollbars match.
    expect(el.style.getPropertyValue("color-scheme")).toBe("dark");
  });

  it("writes every chrome shape token as its --kd-radius-* variable", () => {
    const el = document.createElement("div");
    const theme = SYSTEM_DARK_THEME;
    applyCssVars(theme, el);
    for (const key of CHROME_KEYS) {
      expect(el.style.getPropertyValue(CHROME_VARS[key])).toBe(theme.chrome[key]);
    }
  });

  it("maps a light theme's color-scheme to light", () => {
    const el = document.createElement("div");
    applyCssVars(SYSTEM_LIGHT_THEME, el);
    expect(el.style.getPropertyValue("color-scheme")).toBe("light");
  });

  it("derives the file-icon tint variables from the theme's ANSI palette", () => {
    const el = document.createElement("div");
    const theme = SYSTEM_DARK_THEME;
    applyCssVars(theme, el);
    const a = theme.terminal.ansi;
    expect(el.style.getPropertyValue("--kd-icon-folder")).toBe(a.yellow);
    expect(el.style.getPropertyValue("--kd-icon-code")).toBe(a.blue);
    expect(el.style.getPropertyValue("--kd-icon-markup")).toBe(a.red);
    expect(el.style.getPropertyValue("--kd-icon-style")).toBe(a.magenta);
    expect(el.style.getPropertyValue("--kd-icon-config")).toBe(a.brightYellow);
    expect(el.style.getPropertyValue("--kd-icon-shell")).toBe(a.green);
    expect(el.style.getPropertyValue("--kd-icon-image")).toBe(a.cyan);
    expect(el.style.getPropertyValue("--kd-icon-pdf")).toBe(a.red);
  });
});

describe("toXtermTheme", () => {
  it("derives the xterm ITheme from terminal tokens (fg/bg/cursor/selection + 16 ANSI)", () => {
    const theme = THEMES_BY_ID["dark"];
    const it = toXtermTheme(theme);
    expect(it.background).toBe(theme.terminal.background);
    expect(it.foreground).toBe(theme.terminal.foreground);
    expect(it.cursor).toBe(theme.terminal.cursor);
    expect(it.selectionBackground).toBe(theme.terminal.selection);
    // Spot-check the ANSI mapping end to end.
    expect(it.red).toBe(theme.terminal.ansi.red);
    expect(it.brightWhite).toBe(theme.terminal.ansi.brightWhite);
  });
});

describe("toCodeMirrorTheme", () => {
  it("returns a non-empty extension array for every theme (no throw)", () => {
    for (const theme of THEMES) {
      const ext = toCodeMirrorTheme(theme);
      expect(Array.isArray(ext)).toBe(true);
      expect((ext as unknown[]).length).toBeGreaterThan(0);
    }
  });
});

// The syntax-depth contract: the HighlightStyle must cover the key tag set and
// every color it emits must come from the theme's own palette (no invented hues).
describe.each(THEMES)("buildHighlightStyle: $id", (theme) => {
  // Every distinct color the built style assigns, lowercased for comparison.
  const colors = new Set(
    buildHighlightStyle(theme)
      .specs.map((spec) => (spec as { color?: string }).color?.toLowerCase())
      .filter((c): c is string => Boolean(c)),
  );

  it("emits every syntax palette color (each key is actually mapped onto a tag)", () => {
    // commentItalic is a flag, not a color — SYNTAX_KEYS already excludes it.
    for (const key of SYNTAX_KEYS) {
      expect(colors).toContain(theme.syntax[key].toLowerCase());
    }
  });

  it("emits only colors drawn from the theme's syntax palette (no hardcoded hues)", () => {
    const palette = new Set(
      SYNTAX_KEYS.map((key) => theme.syntax[key].toLowerCase()),
    );
    for (const color of colors) expect(palette).toContain(color);
  });

  it("covers the key highlight tags the editor relies on", () => {
    // Flatten the tag(s) each spec targets into one set of tag objects.
    const covered = new Set(
      buildHighlightStyle(theme).specs.flatMap((spec) => {
        const tag = (spec as { tag: unknown }).tag;
        return Array.isArray(tag) ? tag : [tag];
      }),
    );
    const required = [
      t.keyword,
      t.string,
      t.number,
      t.comment,
      t.typeName,
      t.tagName,
      t.attributeName,
      t.propertyName,
      t.operator,
      t.punctuation,
      t.heading,
      t.link,
      t.invalid,
      t.variableName,
      t.function(t.variableName),
      t.definition(t.variableName),
      t.className,
      t.bool,
      t.null,
    ];
    for (const tag of required) expect(covered).toContain(tag);
  });
});
