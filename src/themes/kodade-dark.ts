// Ködade Dark — warm logo amber, sage, cornflower, and coral desaturated onto
// warm charcoal (taupe-leaning, not blue-grey). Chrome sits on the darker
// `surface`, work surfaces on `bg`, and the terminal recesses one step below
// that — the layered-pane depth is built into these tiers.
import type { Theme } from "./schema";
import { KODADE_AMBER } from "./brand";

export const kodadeDark: Theme = {
  id: "dark",
  name: "Dark",
  appearance: "dark",
  ui: {
    bg: "#2a2825", // work surfaces (editor/terminal frames) — warm charcoal
    surface: "#232120", // chrome: title bar, sidebar, file tree, tab strips
    surfaceHover: "#38352f",
    border: "#3a3733",
    text: "#d6d2c9", // soft warm gray (9.7:1 on bg)
    textDim: "#a5a096", // 5.7:1 on bg
    accent: KODADE_AMBER,
    accentText: "#232120",
  },
  // Shape scale shared by both Ködade themes: dense chips through dialogs.
  chrome: {
    radiusSm: "6px",
    radiusMd: "8px",
    radiusLg: "10px",
    radiusXl: "12px",
  },
  terminal: {
    background: "#252320", // one step below bg so the terminal recesses
    foreground: "#d6d2c9",
    cursor: "#e2b86e", // muted amber
    selection: "#454038", // warm grey; 1.53:1 on the terminal bg, as distinct as the old cool one
    ansi: {
      black: "#3a3d45",
      red: "#d97a80", // muted coral
      green: "#a8c87f", // sage
      yellow: "#e2b86e", // amber
      blue: "#7fa3e0", // cornflower
      magenta: "#d98a5b", // warm orange in Ködade's purple-free palette
      cyan: "#7fc4d6", // mist
      white: "#bfc5da", // pre-refresh hex on purpose: the ANSI palette is held stable, so this no longer mirrors ui.text
      brightBlack: "#545966",
      brightRed: "#e28f95",
      brightGreen: "#b6d38f",
      brightYellow: "#ecc77f",
      brightBlue: "#93b2e8",
      brightMagenta: KODADE_AMBER,
      brightCyan: "#94d2e2",
      brightWhite: "#d8dcea",
    },
  },
  // Warm syntax palette: logo-amber keywords, sage strings, amber
  // types/attributes, cornflower functions, and coral tags.
  syntax: {
    comment: "#697098", // slate comment
    commentItalic: true,
    keyword: KODADE_AMBER,
    string: "#a8c87f", // sage
    number: "#e39a72", // muted orange
    functionName: "#7fa3e0", // cornflower
    typeName: "#e2b86e", // amber
    variable: "#d6d2c9", // fg
    propertyName: "#9fb8dd", // soft steel blue
    attributeName: "#e2b86e", // amber (Palenight attrs are yellow)
    tagName: "#d97a80", // coral (Palenight tags are red)
    operator: "#7fc4d6", // mist cyan
    punctuation: "#a5a096",
    constant: "#e39a72", // booleans/null share the orange
    heading: KODADE_AMBER,
    link: "#7fa3e0",
    invalid: "#e0616e",
  },
};
