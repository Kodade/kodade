import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { labelFor, labelForCombo } from "../shortcuts/bindings";
import { DEFAULT_VOICE_PREFERENCES } from "./models";
import type { VoiceStoreState } from "./store";
import { VoiceControls } from "./VoiceControls";

function controlsStore(over: Partial<VoiceStoreState> = {}) {
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
    ...over,
  }));
}

describe("VoiceControls", () => {
  it("uses the canonical push-to-talk binding in its microphone tooltip", () => {
    const markup = renderToStaticMarkup(<VoiceControls store={controlsStore()} disabled={false} />);

    expect(markup).toContain(`Hold to talk (${labelFor("push-to-talk")})`);
  });

  it("shows a late native error without hiding the review transcript", () => {
    const input = document.createElement("input");
    const markup = renderToStaticMarkup(
      <VoiceControls
        store={controlsStore({
          voice: {
            phase: "review",
            level: 0,
            text: "keep this transcript",
            target: { kind: "text-input", element: input },
            error: "late native error",
          },
        })}
        disabled={false}
      />,
    );

    expect(markup).toContain("keep this transcript");
    expect(markup).toContain("late native error");
  });

  it("offers a privacy-settings deep link only when the error is a denied microphone", () => {
    const deniedMarkup = renderToStaticMarkup(
      <VoiceControls
        store={controlsStore({
          voice: {
            phase: "error",
            level: 0,
            message: "Allow microphone access in System Settings → Privacy & Security → Microphone.",
          },
        })}
        disabled={false}
      />,
    );
    expect(deniedMarkup).toContain("Open privacy settings");

    const otherMarkup = renderToStaticMarkup(
      <VoiceControls
        store={controlsStore({
          voice: { phase: "error", level: 0, message: "Voice input stopped unexpectedly." },
        })}
        disabled={false}
      />,
    );
    expect(otherMarkup).not.toContain("Open privacy settings");
  });

  it("prevents pointerdown from moving focus away from the active terminal", async () => {
    const store = controlsStore();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<VoiceControls store={store} disabled={false} />));
    const mic = container.querySelector('button[aria-label="Start voice capture"]');
    if (!mic) throw new Error("microphone button not found");
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });

    await act(async () => mic.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    await act(async () => root.unmount());
    container.remove();
  });

  it("updates the microphone tooltip when its shortcut preference changes", async () => {
    const store = controlsStore();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<VoiceControls store={store} disabled={false} />));

    await act(async () =>
      store.setState((state) => ({
        preferences: { ...state.preferences, pushToTalkCombo: "Mod-Alt-v" },
      })),
    );

    const mic = container.querySelector('button[aria-label="Start voice capture"]');
    expect(mic?.getAttribute("title")).toBe(`Hold to talk (${labelForCombo("Mod-Alt-v")})`);
    await act(async () => root.unmount());
    container.remove();
  });
});

// M9f hardening follow-up: the confirm/insert popovers used to arm on a
// window-wide Enter listener with no focus check, so any Enter press anywhere
// in the app (an unrelated input, a PTY pane) would silently run a
// state-changing voice command or insert a transcript. These exercise the
// fix — scoped Enter, click-outside dismissal, and (for commands) a stale-
// confirm timeout — via a mounted DOM rather than static markup.
function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`button "${label}" not found`);
  return button;
}

describe("CommandConfirmPopover", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
  });

  async function renderCommand() {
    const store = controlsStore({
      voice: { phase: "command", level: 0, command: { kind: "send" }, label: "Send" },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<VoiceControls store={store} disabled={false} />));
    return store;
  }

  it("autofocuses Confirm and lets Enter confirm from within the popover", async () => {
    const store = await renderCommand();
    const confirmButton = findButton(container!, "Confirm");
    expect(document.activeElement).toBe(confirmButton);

    await act(async () =>
      confirmButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(store.getState().confirmCommand).toHaveBeenCalled();
  });

  it("does not confirm on Enter typed into an unrelated focused input elsewhere in the app", async () => {
    const store = await renderCommand();
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);
    outsideInput.focus();

    await act(async () =>
      outsideInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(store.getState().confirmCommand).not.toHaveBeenCalled();
    outsideInput.remove();
  });

  it("dismisses (cancels) on an outside click without confirming", async () => {
    const store = await renderCommand();

    await act(async () => window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));

    expect(store.getState().cancelCommand).toHaveBeenCalled();
    expect(store.getState().confirmCommand).not.toHaveBeenCalled();
  });

  it("auto-cancels a stale pending command after the confirm timeout", async () => {
    vi.useFakeTimers();
    const store = await renderCommand();

    await act(async () => vi.advanceTimersByTime(15_000));

    expect(store.getState().cancelCommand).toHaveBeenCalled();
    expect(store.getState().confirmCommand).not.toHaveBeenCalled();
  });
});

describe("ReviewPopover", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function renderReview() {
    const store = controlsStore({
      voice: {
        phase: "review",
        level: 0,
        text: "insert this transcript",
        target: { kind: "terminal", sessionId: "session-1" },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<VoiceControls store={store} disabled={false} />));
    return store;
  }

  it("autofocuses Insert and lets Enter insert from within the popover", async () => {
    const store = await renderReview();
    const insertButton = findButton(container!, "Insert");
    expect(document.activeElement).toBe(insertButton);

    await act(async () =>
      insertButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(store.getState().insertReview).toHaveBeenCalled();
  });

  it("does not insert on Enter typed into an unrelated focused input elsewhere in the app", async () => {
    const store = await renderReview();
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);
    outsideInput.focus();

    await act(async () =>
      outsideInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(store.getState().insertReview).not.toHaveBeenCalled();
    outsideInput.remove();
  });

  it("dismisses (discards) on an outside click without inserting", async () => {
    const store = await renderReview();

    await act(async () => window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));

    expect(store.getState().discardReview).toHaveBeenCalled();
    expect(store.getState().insertReview).not.toHaveBeenCalled();
  });
});
