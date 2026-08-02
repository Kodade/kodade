// Ködade Dark — warm logo amber, sage, cornflower, and coral desaturated onto
// neutral charcoal grays. Chrome sits on the darker `surface`, work surfaces
// on `bg`, and the terminal recesses one step below that — the layered-pane
// depth is built into these tiers.
import type { Theme } from "./schema";
import { KODADE_AMBER } from "./brand";

export const kodadeDark: Theme = {
  id: "dark",
  name: "Dark",
  appearance: "dark",
  ui: {
    bg: "#26282d", // work surfaces (editor/terminal frames) — charcoal
    surface: "#1e2024", // chrome: title bar, sidebar, file tree, tab strips
    surfaceHover: "#343841",
    border: "#363a42",
    text: "#bfc5da", // soft cool gray
    textDim: "#8b91a7",
    accent: KODADE_AMBER,
    accentText: "#1e2024",
  },
  terminal: {
    background: "#212327", // one step below bg so the terminal recesses
    foreground: "#bfc5da",
    cursor: "#e2b86e", // muted amber
    selection: "#3c4049",
    ansi: {
      black: "#3a3d45",
      red: "#d97a80", // muted coral
      green: "#a8c87f", // sage
      yellow: "#e2b86e", // amber
      blue: "#7fa3e0", // cornflower
      magenta: "#d98a5b", // warm orange in Ködade's purple-free palette
      cyan: "#7fc4d6", // mist
      white: "#bfc5da",
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
    variable: "#bfc5da", // fg
    propertyName: "#9fb8dd", // soft steel blue
    attributeName: "#e2b86e", // amber (Palenight attrs are yellow)
    tagName: "#d97a80", // coral (Palenight tags are red)
    operator: "#7fc4d6", // mist cyan
    punctuation: "#8b91a7",
    constant: "#e39a72", // booleans/null share the orange
    heading: KODADE_AMBER,
    link: "#7fa3e0",
    invalid: "#e0616e",
  },
};
