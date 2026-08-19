// One design-token schema for the whole app. A single tokens object per theme
// drives three surfaces at once: the UI chrome (via CSS variables + Tailwind
// @theme), the xterm palette (derived ITheme), and the CodeMirror editor
// (highlight style + view theme). Adding a theme is ONE new file exporting a
// Theme — everything else reads these keys generically, which is the whole
// extensibility contract (see themes.test.ts pinning key completeness).

// The 16 standard ANSI colors an xterm palette needs.
export type AnsiPalette = {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

// UI chrome tiers — map 1:1 onto the semantic Tailwind tokens in styles.css.
export type UiTokens = {
  bg: string; // app/root background (deepest)
  surface: string; // panels, headers, hover fills
  surfaceHover: string; // interactive hover state
  border: string; // pane/divider borders
  text: string; // primary foreground
  textDim: string; // secondary/muted foreground
  accent: string; // active/selection highlight
  accentText: string; // text on top of accent (kept legible)
};

// Chrome shape tokens — the non-color half of the design token layer. These map
// onto --kd-radius-* CSS variables which styles.css feeds into Tailwind's
// --radius-* namespace, so every `rounded-sm|md|lg|xl` utility in the app is
// theme-driven instead of hardcoded. Values are CSS lengths ("6px").
export type ChromeTokens = {
  radiusSm: string; // chips, inline badges, dense controls
  radiusMd: string; // buttons, inputs, list rows
  radiusLg: string; // cards, popovers
  radiusXl: string; // dialogs, large panels
};

// Terminal palette. `ansi` is the 16-color set; the rest are xterm's specials.
export type TerminalTokens = {
  background: string;
  foreground: string;
  cursor: string;
  selection: string; // xterm's selectionBackground
  ansi: AnsiPalette;
};

// CodeMirror syntax colors. A language-agnostic palette deep enough that code
// reads with meaning — tags vs attributes vs strings all distinguishable —
// across our common languages (tsx, rust, css, html, json, md). Every key is
// filled from each theme's OFFICIAL upstream palette (see per-theme files); the
// applier maps these onto @lezer/highlight tags. Deliberately one flat set so a
// new theme is still one file.
export type SyntaxTokens = {
  comment: string;
  commentItalic?: boolean; // render comments italic when the palette wants it
  keyword: string; // if/return/const/function...
  string: string; // "text", 'text', template literals
  number: string; // numeric literals
  functionName: string; // function definitions and calls
  typeName: string; // types, classes, interfaces
  variable: string; // identifiers / bindings
  propertyName: string; // object properties / member access
  attributeName: string; // HTML/JSX attribute names (upstream palettes distinguish)
  tagName: string; // HTML/JSX element tags
  operator: string; // + - = => && ...
  punctuation: string; // brackets, commas, separators
  constant: string; // booleans, null, named constants
  heading: string; // markdown headings
  link: string; // markdown links/urls
  invalid: string; // error/invalid tokens
};

export type Theme = {
  id: string; // stable persisted id, e.g. "catppuccin-mocha"
  name: string; // display name in the picker
  appearance: "dark" | "light"; // drives system-following resolution
  ui: UiTokens;
  chrome: ChromeTokens;
  terminal: TerminalTokens;
  syntax: SyntaxTokens;
};

// The required key lists, exported so tests can assert every theme is complete
// without hand-maintaining a duplicate list. This IS the "new theme = one
// fully-populated file" guarantee.
export const UI_KEYS = [
  "bg",
  "surface",
  "surfaceHover",
  "border",
  "text",
  "textDim",
  "accent",
  "accentText",
] as const satisfies readonly (keyof UiTokens)[];

export const CHROME_KEYS = [
  "radiusSm",
  "radiusMd",
  "radiusLg",
  "radiusXl",
] as const satisfies readonly (keyof ChromeTokens)[];

export const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof AnsiPalette)[];

export const TERMINAL_KEYS = [
  "background",
  "foreground",
  "cursor",
  "selection",
] as const satisfies readonly (keyof Omit<TerminalTokens, "ansi">)[];

// Every required syntax key. `commentItalic` is an optional boolean flag, not a
// color, so it is intentionally excluded here — the completeness test asserts
// hex on these keys only.
export const SYNTAX_KEYS = [
  "comment",
  "keyword",
  "string",
  "number",
  "functionName",
  "typeName",
  "variable",
  "propertyName",
  "attributeName",
  "tagName",
  "operator",
  "punctuation",
  "constant",
  "heading",
  "link",
  "invalid",
] as const satisfies readonly (keyof SyntaxTokens)[];
