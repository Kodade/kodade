import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl, rawAllowedAnchorHref } from "./links";

describe("isAllowedExternalUrl", () => {
  it.each(["https://kodade.com", "http://localhost:3000"])(
    "allows %s",
    (url) => expect(isAllowedExternalUrl(url)).toBe(true),
  );

  // file:// is refused on purpose: macOS `open` on a file URL can LAUNCH the
  // target (an .app, an installer) — no doc click gets that power.
  it.each([
    "javascript:alert(1)",
    "data:text/html,nope",
    "relative/readme.md",
    "file:///tmp/readme.md",
    "file:///Applications/Calculator.app",
  ])("rejects %s", (url) => expect(isAllowedExternalUrl(url)).toBe(false));

  it("does not turn a relative anchor into a dev-server URL", () => {
    const link = document.createElement("a");
    link.setAttribute("href", "docs/readme.md");

    // The DOM property is absolute in a browser, but the gate must inspect the
    // raw attribute so it remains a rejected relative link.
    expect(link.href).toContain("docs/readme.md");
    expect(rawAllowedAnchorHref(link)).toBeNull();
  });
});
