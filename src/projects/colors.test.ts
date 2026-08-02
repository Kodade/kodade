import { describe, expect, it } from "vitest";
import {
  PROJECT_COLORS,
  autoColorId,
  normalizeProjectColorId,
  projectColorHex,
} from "./colors";

const DARK_SURFACE = "#0F1012";
const LIGHT_SURFACE = "#eff1f5";

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const srgb = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

describe("project colors", () => {
  it("keeps purple out of the visible palette and migrates the legacy violet id", () => {
    expect(PROJECT_COLORS.map((color) => color.id)).toEqual([
      "red",
      "orange",
      "amber",
      "green",
      "teal",
      "blue",
      "copper",
      "pink",
    ]);
    expect(normalizeProjectColorId("violet")).toBe("copper");
    expect(normalizeProjectColorId("neon")).toBeUndefined();
  });

  it("assigns a stable valid palette id for a project id", () => {
    const first = autoColorId("project-42");
    expect(autoColorId("project-42")).toBe(first);
    expect(PROJECT_COLORS.map((color) => color.id)).toContain(first);
  });

  it("distributes many ids across every palette hue", () => {
    const assigned = new Set(
      Array.from({ length: 256 }, (_, index) => autoColorId(`project-${index}`)),
    );
    expect(assigned).toEqual(new Set(PROJECT_COLORS.map((color) => color.id)));
  });

  it("uses a picked color when valid and otherwise falls back to auto", () => {
    const picked = PROJECT_COLORS[3];
    expect(
      projectColorHex({ id: "project-42", color: picked.id }, "dark"),
    ).toBe(picked.dark);
    expect(
      projectColorHex({ id: "project-42", color: picked.id }, "light"),
    ).toBe(picked.light);
    expect(
      projectColorHex({ id: "project-42", color: "not-a-color" }, "dark"),
    ).toBe(projectColorHex({ id: "project-42" }, "dark"));
  });

  it("keeps every appearance variant distinct on its extreme surface", () => {
    for (const color of PROJECT_COLORS) {
      expect(
        contrastRatio(color.dark, DARK_SURFACE),
        `${color.name} on dark`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(color.light, LIGHT_SURFACE),
        `${color.name} on light`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
