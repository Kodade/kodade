// Where a KödChat link opens (#62). This suite compiles the development
// profile, so the feature is on and only capabilities decide.

import { describe, expect, it } from "vitest";
import { chatLinkTarget } from "./link-target";

describe("chat link target", () => {
  it("uses the embedded pane when the feature and platform allow it", () => {
    expect(chatLinkTarget(null)).toBe("browser-pane");
    expect(
      chatLinkTarget({
        browser: true,
        pickFolder: true,
        voice: true,
        revealInOs: true,
      }),
    ).toBe("browser-pane");
  });

  it("falls back to the OS browser when the platform cannot host the pane", () => {
    expect(
      chatLinkTarget({
        browser: false,
        pickFolder: true,
        voice: true,
        revealInOs: true,
      }),
    ).toBe("external");
  });
});
