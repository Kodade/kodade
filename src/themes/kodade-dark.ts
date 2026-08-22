// Ködade Dark — logo amber, sage, cornflower, and coral accents on a neutral
// near-black chrome (issue #96: the original taupe/warm-charcoal surfaces read
// as brownish next to reference apps, so the UI tiers below are neutral gray,
// not warm). Chrome sits on the darker `surface`, work surfaces on `bg`, and
// the terminal recesses one step below that — the layered-pane depth is built
// into these tiers. Only surface/text tokens shifted; ANSI/syntax accent hues
// are unchanged.
import type { Theme } from "./schema";
import { KODADE_AMBER } from "./brand";

export const kodadeDark: Theme = {
  id: "dark",
  name: "Dark",
  appearance: "dark",
  ui: {
    bg: "#1e1e20", // work surfaces (editor/terminal frames) — neutral charcoal
    surface: "#17171a", // chrome: title bar, sidebar, file tree, tab strips — near-black
    surfaceHover: "#2a2a2e",
    border: "#333336",
    text: "#eae8e5", // brighter neutral (was warm #d6d2c9) for stronger contrast
    textDim: "#a9a9ad", // neutral gray, no brown cast
    accent: KODADE_AMBER,
    accentText: "#17171a",
  },
  // Shape scale shared by both Ködade themes: dense chips through dialogs.
  chrome: {
    radiusSm: "6px",
    radiusMd: "8px",
    radiusLg: "10px",
    radiusXl: "12px",
  },
  terminal: {
    background: "#19191c", // one step below bg so the terminal recesses
    foreground: "#eae8e5",
    cursor: "#e2b86e", // muted amber
    selection: "#333338", // neutral grey (was warm); still clearly distinct on the terminal bg
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
    variable: "#eae8e5", // fg
    propertyName: "#9fb8dd", // soft steel blue
    attributeName: "#e2b86e", // amber (Palenight attrs are yellow)
    tagName: "#d97a80", // coral (Palenight tags are red)
    operator: "#7fc4d6", // mist cyan
    punctuation: "#a9a9ad",
    constant: "#e39a72", // booleans/null share the orange
    heading: KODADE_AMBER,
    link: "#7fa3e0",
    invalid: "#e0616e",
  },
};
