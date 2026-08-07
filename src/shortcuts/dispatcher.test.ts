// Dispatcher tests: event → action wiring against fake actions and fake focus
// probes. Verifies preventDefault/stopPropagation, the terminal-focus gate, and
// that save defers to the editor when the editor is focused.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleKeydown,
  handleKeyup,
  installShortcuts,
  type DispatcherDeps,
} from "./dispatcher";
import {
  setComboOverrides,
  setShortcutCaptureActive,
  type ShortcutActions,
} from "./bindings";

afterEach(() => {
  setComboOverrides({});
  setShortcutCaptureActive(false);
});

function fakeActions() {
  return {
    toggleSidebar: vi.fn(),
    toggleFiles: vi.fn(),
    newSession: vi.fn(),
    saveFile: vi.fn(),
    nextSession: vi.fn(),
    prevSession: vi.fn(),
    nextProject: vi.fn(),
    prevProject: vi.fn(),
    closeTab: vi.fn(),
    nextTab: vi.fn(),
    prevTab: vi.fn(),
    startVoice: vi.fn(),
    startVoiceCommand: vi.fn(),
    stopVoice: vi.fn(),
  } satisfies ShortcutActions;
}

// A minimal KeyboardEvent-like with spies for preventDefault/stopPropagation.
function fakeEvent(over: Partial<KeyboardEvent>) {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...over,
  } as unknown as KeyboardEvent;
}

function deps(over: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    actions: fakeActions(),
    isTerminalFocused: () => false,
    isMac: true,
    ...over,
  };
}

describe("handleKeydown — wiring", () => {
  it("Cmd+B toggles the projects sidebar", () => {
    const d = deps();
    expect(handleKeydown(fakeEvent({ key: "b", metaKey: true }), d)).toBe("toggle-sidebar");
    expect(d.actions.toggleSidebar).toHaveBeenCalledOnce();
  });

  it("Cmd+T runs newSession and preventDefaults the browser default", () => {
    const d = deps();
    const e = fakeEvent({ key: "t", metaKey: true });
    expect(handleKeydown(e, d)).toBe("new-session");
    expect(d.actions.newSession).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalledOnce();
  });

  it("wires every session/project chord to its action", () => {
    const d = deps();
    handleKeydown(fakeEvent({ key: "]", metaKey: true, shiftKey: true }), d);
    handleKeydown(fakeEvent({ key: "[", metaKey: true, shiftKey: true }), d);
    handleKeydown(fakeEvent({ key: "ArrowDown", metaKey: true, altKey: true }), d);
    handleKeydown(fakeEvent({ key: "ArrowUp", metaKey: true, altKey: true }), d);
    expect(d.actions.nextSession).toHaveBeenCalledOnce();
    expect(d.actions.prevSession).toHaveBeenCalledOnce();
    expect(d.actions.nextProject).toHaveBeenCalledOnce();
    expect(d.actions.prevProject).toHaveBeenCalledOnce();
  });

  it("ignores an unbound chord (no action, no preventDefault)", () => {
    const d = deps();
    const e = fakeEvent({ key: "q", metaKey: true });
    expect(handleKeydown(e, d)).toBe(null);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("does not dispatch bindings while a settings recorder captures a chord", () => {
    const d = deps();
    const captured = fakeEvent({ key: "b", metaKey: true });
    setShortcutCaptureActive(true);

    expect(handleKeydown(captured, d)).toBe(null);
    expect(d.actions.toggleSidebar).not.toHaveBeenCalled();
    expect(captured.preventDefault).not.toHaveBeenCalled();

    setShortcutCaptureActive(false);
    expect(handleKeydown(fakeEvent({ key: "b", metaKey: true }), d)).toBe("toggle-sidebar");
    expect(d.actions.toggleSidebar).toHaveBeenCalledOnce();
  });

  it("starts hold-to-talk on Cmd+Shift+M", () => {
    const d = deps();
    const e = fakeEvent({ key: "m", metaKey: true, shiftKey: true });
    expect(handleKeydown(e, d)).toBe("push-to-talk");
    expect(d.actions.startVoice).toHaveBeenCalledOnce();
  });

  it("fires an overridden hold-to-talk binding and not its default", () => {
    setComboOverrides({ "push-to-talk": "Mod-Alt-v" });
    const d = deps();

    expect(handleKeydown(fakeEvent({ key: "v", metaKey: true, altKey: true }), d)).toBe(
      "push-to-talk",
    );
    expect(d.actions.startVoice).toHaveBeenCalledOnce();
    expect(handleKeydown(fakeEvent({ key: "m", metaKey: true, shiftKey: true }), d)).toBe(
      null,
    );
  });

  it("does not start a second capture for an autorepeated hold-to-talk keydown", () => {
    const d = deps();
    const e = fakeEvent({ key: "m", metaKey: true, shiftKey: true, repeat: true });

    expect(handleKeydown(e, d)).toBe(null);
    expect(d.actions.startVoice).not.toHaveBeenCalled();
  });

  it("starts command-mode capture on Cmd+Shift+K", () => {
    const d = deps();
    const e = fakeEvent({ key: "k", metaKey: true, shiftKey: true });
    expect(handleKeydown(e, d)).toBe("push-to-talk-command");
    expect(d.actions.startVoiceCommand).toHaveBeenCalledOnce();
    expect(d.actions.startVoice).not.toHaveBeenCalled();
  });
});

describe("handleKeyup — hold-to-talk", () => {
  it("stops a held dictation capture when M is released, even after Shift lifts", () => {
    const d = deps();
    const e = fakeEvent({ key: "m", metaKey: true });

    expect(handleKeyup(e, d, { id: "push-to-talk", key: "m" })).toBe(null);
    expect(d.actions.stopVoice).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it("stops a held command capture when K is released", () => {
    const d = deps();
    const e = fakeEvent({ key: "k", metaKey: true });

    expect(handleKeyup(e, d, { id: "push-to-talk-command", key: "k" })).toBe(null);
    expect(d.actions.stopVoice).toHaveBeenCalledOnce();
  });

  it("keeps the command key held when a different key is released", () => {
    const d = deps();
    const e = fakeEvent({ key: "m", metaKey: true });

    // K is held; releasing M must not stop the command capture.
    expect(handleKeyup(e, d, { id: "push-to-talk-command", key: "k" })).toEqual({
      id: "push-to-talk-command",
      key: "k",
    });
    expect(d.actions.stopVoice).not.toHaveBeenCalled();
  });

  it("no-ops a keyup when nothing is held", () => {
    const d = deps();
    const e = fakeEvent({ key: "m", metaKey: true });
    expect(handleKeyup(e, d, null)).toBe(null);
    expect(d.actions.stopVoice).not.toHaveBeenCalled();
  });
});

describe("installShortcuts — held push-to-talk keys", () => {
  it("stops shifted punctuation after Shift is released first", () => {
    setComboOverrides({
      "next-session": "Mod-Shift-;",
      "push-to-talk": "Mod-Shift-]",
    });
    const d = deps();
    const uninstall = installShortcuts(d);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "}",
        code: "BracketRight",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "]",
        code: "BracketRight",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(d.actions.startVoice).toHaveBeenCalledOnce();
    expect(d.actions.stopVoice).toHaveBeenCalledOnce();
    uninstall();
  });

  it("stops on the original physical key after a held binding is rebound", () => {
    const d = deps();
    const uninstall = installShortcuts(d);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "m",
        code: "KeyM",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    setComboOverrides({ "push-to-talk": "Mod-Alt-v" });
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "m",
        code: "KeyM",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(d.actions.startVoice).toHaveBeenCalledOnce();
    expect(d.actions.stopVoice).toHaveBeenCalledOnce();
    uninstall();
  });
});

describe("handleKeydown — terminal focus gate", () => {
  it("app chords still fire while the terminal is focused", () => {
    const d = deps({ isTerminalFocused: () => true });
    const e = fakeEvent({ key: "t", metaKey: true });
    expect(handleKeydown(e, d)).toBe("new-session");
    expect(d.actions.newSession).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it("bare keys and Ctrl combos pass through to the shell (no match, no preventDefault)", () => {
    const d = deps({ isTerminalFocused: () => true });
    const bare = fakeEvent({ key: "a" });
    const ctrlC = fakeEvent({ key: "c", ctrlKey: true });
    expect(handleKeydown(bare, d)).toBe(null);
    expect(handleKeydown(ctrlC, d)).toBe(null);
    expect(bare.preventDefault).not.toHaveBeenCalled();
    expect(ctrlC.preventDefault).not.toHaveBeenCalled();
  });
});

describe("handleKeydown — save coexists with the editor", () => {
  it("defers save to CodeMirror while the editor is focused", () => {
    const d = deps({ isEditorFocused: () => true });
    const e = fakeEvent({ key: "s", metaKey: true });
    // Global handler bails so CodeMirror's own Mod-s keymap handles it.
    expect(handleKeydown(e, d)).toBe(null);
    expect(d.actions.saveFile).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("saves globally when the editor is NOT focused", () => {
    const d = deps({ isEditorFocused: () => false });
    const e = fakeEvent({ key: "s", metaKey: true });
    expect(handleKeydown(e, d)).toBe("save-file");
    expect(d.actions.saveFile).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("installShortcuts — capture abandonment", () => {
  it("cancels an active voice capture when the app loses focus or becomes hidden", () => {
    const d = deps({ actions: { ...fakeActions(), cancelVoice: vi.fn() } });
    const uninstall = installShortcuts(d);
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(d.actions.cancelVoice).toHaveBeenCalledTimes(2);
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    uninstall();
  });
});
