// LicenseSection UX tests. Drives the real component against the app-wide
// licenseStore singleton (reset between tests) with dev-signed tokens, covering
// the progressive-disclosure activation flow and graceful expiry.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LicenseSection } from "./LicenseSection";
import { licenseStore } from "../license";
import { signLicense } from "../license/__fixtures__/dev-keypair";

const DAY = 86_400_000;

function proToken(expiryOffsetDays: number | null): string {
  const now = Date.now();
  return signLicense({
    id: "lic-ui",
    tier: "pro",
    issuedAt: new Date(now - DAY).toISOString(),
    expiry: expiryOffsetDays === null ? null : new Date(now + expiryOffsetDays * DAY).toISOString(),
    features: ["vox.cleanup"],
  });
}

// Set a controlled input/textarea's value the way React expects, then fire input.
function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickButton(container: HTMLElement, label: RegExp) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (!button) throw new Error(`no button matching ${label}`);
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("LicenseSection", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    licenseStore.getState().deactivate(); // reset the singleton to free
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    licenseStore.getState().deactivate();
  });

  it("shows the free plan by default", () => {
    act(() => root.render(createElement(LicenseSection)));
    expect(container.textContent).toMatch(/Free plan/);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("activates a pasted Pro key and reflects the upgrade", () => {
    act(() => root.render(createElement(LicenseSection)));
    clickButton(container, /activate license/i);

    const textarea = container.querySelector("textarea")!;
    act(() => typeInto(textarea, proToken(30)));
    clickButton(container, /^activate$/i);

    expect(container.textContent).toMatch(/Pro — active/);
    expect(licenseStore.getState().hasFeature("vox.cleanup")).toBe(true);
    // The paste UI closes on success.
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("shows a clear error and stays free for a forged key", () => {
    act(() => root.render(createElement(LicenseSection)));
    clickButton(container, /activate license/i);

    const textarea = container.querySelector("textarea")!;
    act(() => typeInto(textarea, "not.a.real.token"));
    clickButton(container, /^activate$/i);

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toMatch(/Free plan/);
    expect(licenseStore.getState().entitlements.tier).toBe("free");
  });

  it("degrades gracefully for an expired key (features off, clear message)", () => {
    act(() => root.render(createElement(LicenseSection)));
    clickButton(container, /activate license/i);

    const textarea = container.querySelector("textarea")!;
    act(() => typeInto(textarea, proToken(-1))); // already expired
    clickButton(container, /^activate$/i);

    expect(container.textContent).toMatch(/Pro — expired/);
    expect(licenseStore.getState().hasFeature("vox.cleanup")).toBe(false);
  });

  it("removes an active license and returns to free", () => {
    act(() => root.render(createElement(LicenseSection)));
    act(() => {
      licenseStore.getState().activate(proToken(30));
    });
    expect(container.textContent).toMatch(/Pro — active/);

    clickButton(container, /remove license/i);
    expect(container.textContent).toMatch(/Free plan/);
    expect(licenseStore.getState().status).toBe("none");
  });
});
