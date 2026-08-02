import { describe, expect, it } from "vitest";
import { monoFontFamily } from "./fonts";

describe("monospace font fallback", () => {
  it("prefers native Windows terminal fonts on Windows", () => {
    expect(monoFontFamily(false)).toBe(
      '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
    );
  });

  it("preserves the native macOS fallback chain", () => {
    expect(monoFontFamily(true)).toContain('"SF Mono", Menlo, Monaco');
    expect(monoFontFamily(true)).not.toContain("Consolas");
  });
});
