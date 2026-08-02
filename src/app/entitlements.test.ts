import { describe, expect, it } from "vitest";
import { createEntitlements, entitlements } from "./entitlements";

describe("entitlements", () => {
  it("the default singleton reports every feature as entitled (stub-true until M9d)", () => {
    expect(entitlements.hasFeature("harness.pro")).toBe(true);
    expect(entitlements.hasFeature("vox.pro")).toBe(true);
    expect(entitlements.hasFeature("anything.at.all")).toBe(true);
  });

  it("createEntitlements lets a test flip one feature off via DI", () => {
    const flipped = createEntitlements({ "harness.pro": false });
    expect(flipped.hasFeature("harness.pro")).toBe(false);
    // Unrelated features stay entitled — only the overridden key flips.
    expect(flipped.hasFeature("vox.pro")).toBe(true);
  });
});
