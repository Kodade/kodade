import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_PREFERENCES } from "./models";
import type { VoiceStoreState } from "./store";
import { VoiceSettings } from "./VoiceSettings";
import {
  detectMacPlatform,
  isShortcutCaptureActive,
  setComboOverrides,
  setShortcutCaptureActive,
} from "../shortcuts/bindings";

function settingsStore() {
  return createStore<VoiceStoreState>(() => ({
    voice: { phase: "idle", level: 0 },
    preferences: DEFAULT_VOICE_PREFERENCES,
    inputDevices: [],
    start: vi.fn(),
    press: vi.fn(async () => undefined),
    pressCommand: vi.fn(async () => undefined),
    confirmCommand: vi.fn(async () => undefined),
    cancelCommand: vi.fn(),
    release: vi.fn(async () => undefined),
    toggle: vi.fn(async () => undefined),
    cancelCapture: vi.fn(async () => undefined),
    downloadSelectedModel: vi.fn(async () => undefined),
    downloadModel: vi.fn(async () => undefined),
    deleteModel: vi.fn(async () => undefined),
    setModel: vi.fn(),
    setReviewBeforeInsert: vi.fn(),
    setCommandAutoConfirm: vi.fn(),
    setPushToTalkCombo: vi.fn(),
    setPushToTalkCommandCombo: vi.fn(),
    refreshInputDevices: vi.fn(async () => undefined),
    setInputDevice: vi.fn(),
    setModelsDir: vi.fn(),
    openPrivacySettings: vi.fn(async () => undefined),
    insertReview: vi.fn(async () => undefined),
    discardReview: vi.fn(),
    dismiss: vi.fn(),
    dispose: vi.fn(async () => undefined),
  }));
}

describe("VoiceSettings shortcuts", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    setComboOverrides({});
    setShortcutCaptureActive(false);
  });

  it("records a Mod-based hold-to-talk override", async () => {
    const store = settingsStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<VoiceSettings store={store} />));

    const changeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "change…",
    );
    if (!changeButton) throw new Error("shortcut change button not found");
    await act(async () => changeButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "v",
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(store.getState().setPushToTalkCombo).toHaveBeenCalledWith("Mod-Alt-v");
  });

  it("rejects a shifted bracket recording that collides with next session", async () => {
    const store = settingsStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<VoiceSettings store={store} />));

    const changeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "change…",
    );
    if (!changeButton) throw new Error("shortcut change button not found");
    await act(async () => changeButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const modKey = detectMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "}",
          code: "BracketRight",
          shiftKey: true,
          ...modKey,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(store.getState().setPushToTalkCombo).not.toHaveBeenCalled();
    expect(container.textContent).toContain("That shortcut is already in use.");
  });

  it("clears shortcut capture after Escape or recording a shortcut", async () => {
    const store = settingsStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<VoiceSettings store={store} />));

    const changeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "change…",
    );
    if (!changeButton) throw new Error("shortcut change button not found");

    await act(async () => changeButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(isShortcutCaptureActive()).toBe(true);

    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(isShortcutCaptureActive()).toBe(false);

    await act(async () => changeButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(isShortcutCaptureActive()).toBe(true);

    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "v",
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(isShortcutCaptureActive()).toBe(false);
  });
});
