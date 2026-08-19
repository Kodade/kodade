// The applier turns one tokens object into the three concrete forms the app's
// surfaces consume: CSS variables on :root (UI chrome, read by the Tailwind
// @theme mapping in styles.css), an xterm ITheme (terminal palette), and a
// CodeMirror extension (view theme + syntax highlighting). All three come from
// the SAME Theme, which is why a new tokens file re-skins everything at once.

import type { ITheme } from "@xterm/xterm";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { Theme } from "./schema";
import { CHROME_KEYS, UI_KEYS } from "./schema";
import { monoFontFamily } from "../platform/fonts";

// UI token -> CSS custom property. Kept a plain map so styles.css's @theme block
// can mirror it 1:1 (see the mapping table there).
export const CSS_VARS: Record<(typeof UI_KEYS)[number], string> = {
  bg: "--kd-bg",
  surface: "--kd-surface",
  surfaceHover: "--kd-surface-hover",
  border: "--kd-border",
  text: "--kd-text",
  textDim: "--kd-text-dim",
  accent: "--kd-accent",
  accentText: "--kd-accent-text",
};

// Chrome token -> CSS custom property. styles.css maps these onto Tailwind's
// --radius-* namespace, so `rounded-md` and friends follow the active theme.
export const CHROME_VARS: Record<(typeof CHROME_KEYS)[number], string> = {
  radiusSm: "--kd-radius-sm",
  radiusMd: "--kd-radius-md",
  radiusLg: "--kd-radius-lg",
  radiusXl: "--kd-radius-xl",
};

// Write the UI tokens onto a root element as CSS variables. Defaults to
// document root; a target is injectable for headless tests.
export function applyCssVars(theme: Theme, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  for (const key of UI_KEYS) {
    el.style.setProperty(CSS_VARS[key], theme.ui[key]);
  }
  // Shape tokens ride along with the colors so a theme swap re-skins radii too.
  for (const key of CHROME_KEYS) {
    el.style.setProperty(CHROME_VARS[key], theme.chrome[key]);
  }
  // Let the OS render form controls/scrollbars to match.
  el.style.setProperty("color-scheme", theme.appearance);
  // Derived status colors: the theme's own ANSI green/yellow/red are legible on
  // its background by construction, so status chrome (success/warning/error)
  // reads from these instead of hardcoded emerald/amber/red that die on light
  // themes. success = installed chips; warning = unsaved/conflict; error = save
  // failure.
  el.style.setProperty("--kd-success", theme.terminal.ansi.green);
  el.style.setProperty("--kd-warning", theme.terminal.ansi.yellow);
  el.style.setProperty("--kd-error", theme.terminal.ansi.red);
  // Per-category file-icon tints, pulled from the theme's own ANSI palette so
  // the file tree is scannable in color yet stays muted and re-skins with the
  // theme (consumed by src/icons/file-icons.tsx).
  const a = theme.terminal.ansi;
  el.style.setProperty("--kd-icon-folder", a.yellow);
  el.style.setProperty("--kd-icon-code", a.blue);
  el.style.setProperty("--kd-icon-markup", a.red);
  el.style.setProperty("--kd-icon-style", a.magenta);
  el.style.setProperty("--kd-icon-config", a.brightYellow);
  el.style.setProperty("--kd-icon-shell", a.green);
  el.style.setProperty("--kd-icon-image", a.cyan);
  el.style.setProperty("--kd-icon-pdf", a.red);
}

// Derive the xterm ITheme from terminal tokens (pure — used by the factory and
// the registry re-theme path, and unit-tested directly).
export function toXtermTheme(theme: Theme): ITheme {
  const a = theme.terminal.ansi;
  return {
    background: theme.terminal.background,
    foreground: theme.terminal.foreground,
    cursor: theme.terminal.cursor,
    cursorAccent: theme.terminal.background,
    selectionBackground: theme.terminal.selection,
    black: a.black,
    red: a.red,
    green: a.green,
    yellow: a.yellow,
    blue: a.blue,
    magenta: a.magenta,
    cyan: a.cyan,
    white: a.white,
    brightBlack: a.brightBlack,
    brightRed: a.brightRed,
    brightGreen: a.brightGreen,
    brightYellow: a.brightYellow,
    brightBlue: a.brightBlue,
    brightMagenta: a.brightMagenta,
    brightCyan: a.brightCyan,
    brightWhite: a.brightWhite,
  };
}

// Build the CodeMirror extension (view chrome + syntax highlight style) from the
// same tokens. Returned as a single Extension so EditorPane can drop it into a
// Compartment and reconfigure live (see #10 note: minimal, token-scoped).
// Build just the syntax HighlightStyle from a theme's palette. Exported so tests
// can inspect its specs (which tags are covered, which palette color each pulls)
// without reaching through the wrapped extension.
export function buildHighlightStyle(theme: Theme): HighlightStyle {
  const s = theme.syntax;
  // Map the theme's syntax palette onto @lezer/highlight tags. Order matters:
  // more specific tags (definitions, function-of-property) come before the
  // generic ones they derive from so they win. Every color pulls from the
  // theme's palette — no hardcoded hues here.
  return HighlightStyle.define([
    // comments — italic when the palette asks for it
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: s.comment,
      ...(s.commentItalic ? { fontStyle: "italic" } : {}),
    },
    // keywords / modifiers / control flow
    {
      tag: [
        t.keyword,
        t.modifier,
        t.controlKeyword,
        t.operatorKeyword,
        t.definitionKeyword,
        t.moduleKeyword,
      ],
      color: s.keyword,
    },
    // strings, template literals, regexp
    { tag: [t.string, t.special(t.string), t.regexp], color: s.string },
    // numbers
    { tag: t.number, color: s.number },
    // function definitions and calls
    {
      tag: [
        t.function(t.variableName),
        t.function(t.propertyName),
        t.definition(t.function(t.variableName)),
      ],
      color: s.functionName,
    },
    // types, classes, namespaces
    { tag: [t.typeName, t.className, t.namespace], color: s.typeName },
    // object property names / HTML-JSX attribute names
    { tag: t.propertyName, color: s.propertyName },
    { tag: t.attributeName, color: s.attributeName },
    // HTML / JSX tag names
    { tag: [t.tagName, t.angleBracket], color: s.tagName },
    // constants: booleans, null, atoms, named consts
    {
      tag: [t.bool, t.null, t.atom, t.constant(t.variableName), t.self, t.meta],
      color: s.constant,
    },
    // variables / definitions — kept after the more specific derivations above
    { tag: [t.variableName, t.definition(t.variableName)], color: s.variable },
    // operators
    { tag: t.operator, color: s.operator },
    // punctuation: brackets, braces, commas, separators
    {
      tag: [
        t.punctuation,
        t.bracket,
        t.squareBracket,
        t.paren,
        t.brace,
        t.separator,
      ],
      color: s.punctuation,
    },
    // markdown headings and links
    { tag: t.heading, color: s.heading, fontWeight: "bold" },
    { tag: [t.link, t.url], color: s.link },
    // invalid / error tokens
    { tag: t.invalid, color: s.invalid },
  ]);
}

export function toCodeMirrorTheme(theme: Theme): Extension {
  const ui = theme.ui;
  const dark = theme.appearance === "dark";

  // Brand default face for the editor (DESIGN.md §3); same fallback chain as the
  // terminal. Applied to content + gutters so the whole editor is monospace.
  const mono = monoFontFamily();

  const view = EditorView.theme(
    {
      "&": { color: ui.text, backgroundColor: ui.bg },
      ".cm-content": { caretColor: ui.text, fontFamily: mono, fontSize: "13px", lineHeight: "1.5" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: ui.text },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: theme.terminal.selection },
      ".cm-gutters": {
        backgroundColor: ui.bg,
        color: ui.textDim,
        border: "none",
        fontFamily: mono,
        fontSize: "13px",
        lineHeight: "1.5",
      },
      ".cm-activeLine": { backgroundColor: ui.surfaceHover + "66" },
      ".cm-activeLineGutter": { backgroundColor: ui.surfaceHover + "66" },
      ".cm-lineNumbers .cm-gutterElement": { color: ui.textDim },
    },
    { dark },
  );

  return [view, syntaxHighlighting(buildHighlightStyle(theme))];
}
