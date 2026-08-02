import { describe, expect, it } from "vitest";
import { projectColorHex } from "../projects/colors";
import { hexToRgba, projectTileStyle } from "./ProjectTile";

describe("projectTileStyle", () => {
  it("uses the resolved project color for both the glyph and its tint", () => {
    const project = { id: "one", color: "red" };
    const appearance = "dark" as const;
    const color = projectColorHex(project, appearance);

    expect(projectTileStyle(project, appearance)).toEqual({
      color,
      backgroundColor: hexToRgba(color, 0.22),
    });
  });
});

describe("hexToRgba", () => {
  it("converts a six-digit hex color with the supplied opacity", () => {
    expect(hexToRgba("#123456", 0.15)).toBe("rgba(18, 52, 86, 0.15)");
  });
});
