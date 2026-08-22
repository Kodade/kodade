import { describe, expect, it, vi } from "vitest";

type LinkHandler = (event: MouseEvent, uri: string) => void;

// Capture the handler passed to `new WebLinksAddon(handler)` so the actual
// click-gating logic in createTerminalWebLinksAddon can be exercised without
// a real xterm terminal or DOM link provider.
let capturedHandler: LinkHandler | null = null;
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(handler: LinkHandler) {
      capturedHandler = handler;
    }
    dispose() {}
  },
}));

const { createTerminalWebLinksAddon, hasLinkModifier } = await import(
  "./web-links"
);

function mouseEvent(init: MouseEventInit): MouseEvent {
  return new MouseEvent("click", init);
}

describe("hasLinkModifier", () => {
  it("requires Cmd (metaKey) on macOS", () => {
    expect(hasLinkModifier(mouseEvent({ metaKey: true }), true)).toBe(true);
    expect(hasLinkModifier(mouseEvent({ ctrlKey: true }), true)).toBe(false);
    expect(hasLinkModifier(mouseEvent({}), true)).toBe(false);
  });

  it("requires Ctrl elsewhere", () => {
    expect(hasLinkModifier(mouseEvent({ ctrlKey: true }), false)).toBe(true);
    expect(hasLinkModifier(mouseEvent({ metaKey: true }), false)).toBe(false);
  });
});

describe("createTerminalWebLinksAddon", () => {
  it("plain click never opens a URL", () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    createTerminalWebLinksAddon(openUrl, true);
    capturedHandler?.(mouseEvent({}), "https://kodade.com");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("Cmd+click opens an allowed http/https URL", () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    createTerminalWebLinksAddon(openUrl, true);
    capturedHandler?.(mouseEvent({ metaKey: true }), "https://kodade.com");
    expect(openUrl).toHaveBeenCalledWith("https://kodade.com");
  });

  it("Ctrl+click opens on non-mac platforms", () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    createTerminalWebLinksAddon(openUrl, false);
    capturedHandler?.(mouseEvent({ ctrlKey: true }), "http://localhost:1420/");
    expect(openUrl).toHaveBeenCalledWith("http://localhost:1420/");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,nope",
    "file:///Applications/Calculator.app",
  ])("Cmd+click never opens a disallowed scheme (%s)", (uri) => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    createTerminalWebLinksAddon(openUrl, true);
    capturedHandler?.(mouseEvent({ metaKey: true }), uri);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
