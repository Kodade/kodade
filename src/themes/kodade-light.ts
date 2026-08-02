// Ködade Light — the same warm amber, sage, cornflower, and coral palette on
// soft paper grays. Hues are darkened for contrast on light backgrounds
// (body-text tokens hold ≥4.5:1 on their surfaces); chrome sits on the
// slightly darker `surface` so the pane layering mirrors the dark theme.
import type { Theme } from "./schema";
import { KODADE_AMBER_ON_LIGHT } from "./brand";

export const kodadeLight: Theme = {
  id: "light",
  name: "Light",
  appearance: "light",
  ui: {
    bg: "#f4f4f6", // work surfaces — soft paper, not stark white
    surface: "#eaebee", // chrome: title bar, sidebar, file tree, tab strips
    surfaceHover: "#dfe0e6",
    border: "#cfd0da",
    text: "#3d4259", // cool ink
    textDim: "#5f6478",
    accent: KODADE_AMBER_ON_LIGHT,
    accentText: "#f7f7f9",
  },
  terminal: {
    background: "#ededf0", // one step below bg so the terminal recesses
    foreground: "#3d4259",
    cursor: "#b07d2a", // muted amber (block cursor, not text)
    selection: "#cdced9",
    ansi: {
      black: "#4a4e63",
      red: "#b8434c", // muted coral
      green: "#587f33", // sage
      yellow: "#966b1f", // amber
      blue: "#4470b8", // cornflower
      magenta: KODADE_AMBER_ON_LIGHT,
      cyan: "#2f758a", // mist
      white: "#b6b9c6",
      brightBlack: "#5f6478",
      brightRed: "#a93a43",
      brightGreen: "#4c6f2c",
      brightYellow: "#855f1b",
      brightBlue: "#3a63a8",
      brightMagenta: "#844617",
      brightCyan: "#296778",
      brightWhite: "#9a9db0",
    },
  },
  // Same warm mapping as Ködade Dark, with every hue darkened to stay legible
  // on paper.
  syntax: {
    comment: "#7d829c",
    commentItalic: true,
    keyword: KODADE_AMBER_ON_LIGHT,
    string: "#587f33", // sage
    number: "#9d5729", // muted orange
    functionName: "#4470b8", // cornflower
    typeName: "#966b1f", // amber
    variable: "#3d4259", // ink
    propertyName: "#52709e", // soft steel blue
    attributeName: "#966b1f", // amber
    tagName: "#b8434c", // coral
    operator: "#2f758a", // mist cyan
    punctuation: "#5f6478",
    constant: "#9d5729",
    heading: KODADE_AMBER_ON_LIGHT,
    link: "#4470b8",
    invalid: "#c43d47",
  },
};
