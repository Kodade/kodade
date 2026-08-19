// Identity colors adapt to the app's resolved appearance. The dark variants
// keep the original calm hues; the light variants are darker and saturated so
// each clears 3:1 against Ködade Light's paper backgrounds (#faf9f5 bg /
// #f2f0ea surface).
export const PROJECT_COLORS: {
  id: string;
  name: string;
  dark: string;
  light: string;
}[] = [
  { id: "red", name: "Red", dark: "#D96C75", light: "#C53645" }, // light/base: 3.61:1
  { id: "orange", name: "Orange", dark: "#D98A5B", light: "#B65B2B" }, // light/base: 4.10:1
  { id: "amber", name: "Amber", dark: "#CFA553", light: "#9B6D00" }, // light/base: 4.15:1
  { id: "green", name: "Green", dark: "#74A878", light: "#3C7A42" }, // light/base: 3.68:1
  { id: "teal", name: "Teal", dark: "#5FA99B", light: "#167A70" }, // light/base: 3.67:1
  { id: "blue", name: "Blue", dark: "#6299D4", light: "#336FB5" }, // light/base: 3.70:1
  { id: "copper", name: "Copper", dark: "#C9825C", light: "#A34F2C" }, // light/base: 4.54:1
  { id: "pink", name: "Pink", dark: "#D67CAA", light: "#B64D83" }, // light/base: 3.97:1
];

export function isProjectColorId(colorId: unknown): colorId is string {
  return (
    typeof colorId === "string" &&
    PROJECT_COLORS.some((color) => color.id === colorId)
  );
}

// Purple left the product palette in 1.4.3. Preserve existing project identity
// choices by moving the retired violet id onto the closest warm brand option.
export function normalizeProjectColorId(colorId: unknown): string | undefined {
  if (colorId === "violet") return "copper";
  return isProjectColorId(colorId) ? colorId : undefined;
}

// FNV-1a gives each stable project id a repeatable palette position.
export function autoColorId(projectId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = Math.imul(hash ^ projectId.charCodeAt(i), 0x01000193);
  }
  return PROJECT_COLORS[(hash >>> 0) % PROJECT_COLORS.length].id;
}

export function projectColorHex(
  project: { id: string; color?: string },
  appearance: "dark" | "light",
): string {
  const colorId = isProjectColorId(project.color)
    ? project.color
    : autoColorId(project.id);
  return PROJECT_COLORS.find((color) => color.id === colorId)![appearance];
}
