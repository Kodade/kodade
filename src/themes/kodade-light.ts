// Ködade Light — the same warm amber, sage, cornflower, and coral palette on
// warm off-white paper. Hues are darkened for contrast on light backgrounds
// (body-text tokens hold ≥4.5:1 on their surfaces); chrome sits on the
// slightly darker `surface` so the pane layering mirrors the dark theme.
import type { Theme } from "./schema";
import { KODADE_AMBER_ON_LIGHT } from "./brand";

export const kodadeLight: Theme = {
  id: "light",
  name: "Light",
  appearance: "light",
  ui: {
    bg: "#faf9f5", // work surfaces — warm paper, not stark white
    surface: "#f2f0ea", // chrome: title bar, sidebar, file tree, tab strips
    surfaceHover: "#e7e4dc",
    border: "#ddd9cf",
    text: "#3f3b34", // warm ink (10.6:1 on bg)
    textDim: "#6b665c", // 5.4:1 on bg
    accent: KODADE_AMBER_ON_LIGHT,
    accentText: "#faf9f5",
  },
  // Same shape scale as Ködade Dark — radii are appearance-independent.
  chrome: {
    radiusSm: "6px",
    radiusMd: "8px",
    radiusLg: "10px",
    radiusXl: "12px",
  },
  terminal: {
    background: "#f4f2ec", // one step below bg so the terminal recesses
    foreground: "#3f3b34",
    cursor: "#b07d2a", // muted amber (block cursor, not text)
    selection: "#d5d0c4", // warm grey; 1.37:1 on the terminal bg, as distinct as the old cool one
    ansi: {
      black: "#4a4e63",
      red: "#b8434c", // muted coral
      green: "#587f33", // sage
      yellow: "#966b1f", // amber
      blue: "#4470b8", // cornflower
      magenta: KODADE_AMBER_ON_LIGHT,
      cyan: "#2f758a", // mist
      white: "#b6b9c6",
      brightBlack: "#5f6478", // pre-refresh hex on purpose: the ANSI palette is held stable, so this no longer mirrors ui.textDim
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
    variable: "#3f3b34", // ink
    propertyName: "#52709e", // soft steel blue
    attributeName: "#966b1f", // amber
    tagName: "#b8434c", // coral
    operator: "#2f758a", // mist cyan
    punctuation: "#6b665c",
    constant: "#9d5729",
    heading: KODADE_AMBER_ON_LIGHT,
    link: "#4470b8",
    invalid: "#c43d47",
  },
};
