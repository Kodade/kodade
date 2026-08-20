// Settings → Advanced → KödHarness: the background prompt control (issue #63).
// The prompt is invisible everywhere else, so these assert the one surface a
// user has for reading, rewriting, and switching it off.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AMBIENT_PROMPT } from "../../harness/ambient";
import { appStore } from "../../store/appStore";
import { AmbientPromptSettings } from "./AmbientPromptSettings";

describe("background prompt settings", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  const render = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<AmbientPromptSettings />));
    return container;
  };

  const toggle = () =>
    container!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const disclosure = () =>
    container!.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  const textarea = () => container!.querySelector<HTMLTextAreaElement>("textarea");
  const resetButton = () =>
    Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Reset to default"),
    )!;

  // React tracks the DOM value, so a plain assignment is ignored — go through
  // the native setter like the other component tests do.
  const type = async (value: string) => {
    const field = textarea()!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      // React's onBlur is delegated from focusout, not the non-bubbling blur.
      field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
  };

  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  beforeEach(() => {
    appStore.setState({ ambientPromptEnabled: true, ambientPromptOverride: null });
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    appStore.setState({ ambientPromptEnabled: true, ambientPromptOverride: null });
  });

  it("stays collapsed and says what the prompt is for", async () => {
    const view = await render();
    expect(view.textContent).toContain("Background prompt");
    expect(view.textContent).toContain(
      "Sent invisibly to every agent Ködade starts in chat and KödWork.",
    );
    expect(textarea()).toBeNull();
  });

  it("shows the shipped default text when there is no override", async () => {
    await render();
    await click(disclosure());
    expect(textarea()!.value).toBe(DEFAULT_AMBIENT_PROMPT);
  });

  it("persists an edited prompt to the store on blur", async () => {
    await render();
    await click(disclosure());
    await type("  Only speak in haiku.  ");
    expect(appStore.getState().ambientPromptOverride).toBe("Only speak in haiku.");
  });

  it("treats retyping the default as no override at all", async () => {
    appStore.setState({ ambientPromptOverride: "Only speak in haiku." });
    await render();
    await click(disclosure());
    await type(DEFAULT_AMBIENT_PROMPT);
    expect(appStore.getState().ambientPromptOverride).toBeNull();
  });

  it("resets back to Ködade's own text", async () => {
    appStore.setState({ ambientPromptOverride: "Only speak in haiku." });
    await render();
    await click(disclosure());
    expect(textarea()!.value).toBe("Only speak in haiku.");
    await click(resetButton());
    expect(appStore.getState().ambientPromptOverride).toBeNull();
    expect(textarea()!.value).toBe(DEFAULT_AMBIENT_PROMPT);
    expect(resetButton().disabled).toBe(true);
  });

  it("switches the whole thing off", async () => {
    await render();
    expect(toggle().checked).toBe(true);
    await act(async () => {
      toggle().click();
    });
    expect(appStore.getState().ambientPromptEnabled).toBe(false);
    await click(disclosure());
    expect(textarea()!.disabled).toBe(true);
  });
});
