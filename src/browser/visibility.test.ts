import { describe, expect, it } from "vitest";
import { browserViewportDecision } from "./visibility";

const visible = { x: 10, y: 20, width: 800, height: 600 };

describe("browserViewportDecision", () => {
  it("places a loaded browser in a non-empty viewport", () => {
    expect(browserViewportDecision("https://example.com/", visible, false)).toBe("place");
  });

  it.each([
    { ...visible, width: 0 },
    { ...visible, height: 0 },
  ])("hides a loaded browser for collapsed bounds %#", (bounds) => {
    expect(browserViewportDecision("https://example.com/", bounds, false)).toBe("hide");
  });

  it("does not touch a native browser for the blank start page", () => {
    expect(browserViewportDecision("", visible, true)).toBe("idle");
  });

  it("hides a loaded native browser while another full-page surface covers it", () => {
    expect(browserViewportDecision("https://example.com/", visible, true)).toBe("hide");
  });
});
