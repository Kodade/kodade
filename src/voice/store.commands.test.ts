import { describe, expect, it, vi } from "vitest";
import { MockVoxIpc } from "../ipc/mock";
import { FEATURES } from "../license";
import { VoiceModelManager } from "./models";
import { MIN_CAPTURE_MS, type VoiceTarget } from "./reducer";
import { createVoiceStore, type VoiceCommandActions } from "./store";

const target: VoiceTarget = { kind: "terminal", sessionId: "terminal-1" };

function fakeCommands(over: Partial<VoiceCommandActions> = {}) {
  return {
    sessionCount: vi.fn(() => 3),
    newSession: vi.fn(),
    switchTerminal: vi.fn((index: number) => index >= 1 && index <= 3),
    nextTerminal: vi.fn(),
    prevTerminal: vi.fn(),
    submit: vi.fn(),
    ...over,
  } satisfies VoiceCommandActions;
}

function setup(
  over: {
    features?: string[];
    commands?: VoiceCommandActions;
    commandAutoConfirm?: boolean;
    stopText?: string;
    now?: () => number;
  } = {},
) {
  const vox = new MockVoxIpc();
  vox.nextStop = {
    utteranceId: "utterance-1",
    text: over.stopText ?? "new terminal",
    durationMs: 850,
  };
  const features = new Set(over.features ?? [FEATURES.voxCommands]);
  const commands = over.commands ?? fakeCommands();
  const insert = vi.fn(async () => undefined);
  const store = createVoiceStore(
    {
      vox,
      models: new VoiceModelManager(vox),
      resolveTarget: () => target,
      insert,
      savePreferences: vi.fn(),
      openMicrophonePrivacySettings: vi.fn(async () => undefined),
      hasFeature: (feature) => features.has(feature),
      commands,
      now: over.now,
    },
    {
      modelId: "base.en",
      installedModelIds: ["base.en"],
      reviewBeforeInsert: true,
      reviewBeforeInsertConfigured: true,
      modelsDir: null,
      inputDeviceId: null,
      commandAutoConfirm: over.commandAutoConfirm ?? false,
      pushToTalkCombo: null,
      pushToTalkCommandCombo: null,
    },
  );
  return { vox, store, commands, insert };
}

async function captureCommand(
  store: ReturnType<typeof setup>["store"],
  now: { t: number },
) {
  await store.getState().pressCommand();
  now.t += MIN_CAPTURE_MS;
  await store.getState().release();
}

describe("voice store — KodWhisper Pro voice commands (M9f)", () => {
  it("marks a command-mode capture in the state for the mode indicator", async () => {
    const now = { t: 1000 };
    const { store } = setup({ now: () => now.t });
    await store.getState().pressCommand();
    const voice = store.getState().voice;
    expect(voice.phase).toBe("capturing");
    expect(voice.phase === "capturing" && voice.mode).toBe("command");
  });

  it("holds a recognized command at the confirm guard before running it", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({ stopText: "new terminal", now: () => now.t });
    await captureCommand(store, now);

    const voice = store.getState().voice;
    expect(voice.phase).toBe("command");
    expect(voice.phase === "command" && voice.label).toBe("New terminal");
    // Nothing runs until confirmation.
    expect(commands.newSession).not.toHaveBeenCalled();

    await store.getState().confirmCommand();
    expect(commands.newSession).toHaveBeenCalledOnce();
    expect(store.getState().voice.phase).toBe("idle");
  });

  it("ignores a second press while a command awaits confirmation", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({ stopText: "new terminal", now: () => now.t });
    await captureCommand(store, now);
    expect(store.getState().voice.phase).toBe("command");

    // A second Mod-Shift-K press must not start a new capture over the
    // pending confirm — press() only re-arms from "idle"/"error".
    await store.getState().pressCommand();
    expect(store.getState().voice.phase).toBe("command");
    expect(commands.newSession).not.toHaveBeenCalled();

    await store.getState().confirmCommand();
    expect(commands.newSession).toHaveBeenCalledOnce();
  });

  it("cancelling the guard runs nothing", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({ stopText: "new terminal", now: () => now.t });
    await captureCommand(store, now);
    expect(store.getState().voice.phase).toBe("command");

    store.getState().cancelCommand();
    expect(commands.newSession).not.toHaveBeenCalled();
    expect(store.getState().voice.phase).toBe("idle");
  });

  it("resolves a spoken terminal index against the app's existing action", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({ stopText: "switch to terminal 2", now: () => now.t });
    await captureCommand(store, now);
    await store.getState().confirmCommand();
    expect(commands.switchTerminal).toHaveBeenCalledWith(2);
  });

  it("no-ops gracefully when the target terminal does not exist", async () => {
    const now = { t: 1000 };
    const commands = fakeCommands({ switchTerminal: vi.fn(() => false) });
    const { store } = setup({ stopText: "terminal 9", commands, now: () => now.t });
    await captureCommand(store, now);
    await store.getState().confirmCommand();
    expect(commands.switchTerminal).toHaveBeenCalledWith(9);
    // Graceful: the store returns to idle with a "no terminal" notice, no throw.
    expect(store.getState().voice).toMatchObject({
      phase: "idle",
      notice: "No terminal 9.",
    });
  });

  it("always confirms 'send' even with auto-confirm on", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({
      stopText: "send",
      commandAutoConfirm: true,
      now: () => now.t,
    });
    await captureCommand(store, now);
    // Auto-confirm never applies to the submitting command.
    expect(store.getState().voice.phase).toBe("command");
    expect(commands.submit).not.toHaveBeenCalled();

    await store.getState().confirmCommand();
    expect(commands.submit).toHaveBeenCalledOnce();
  });

  it("auto-confirms a safe command when the user opts in", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({
      stopText: "next terminal",
      commandAutoConfirm: true,
      now: () => now.t,
    });
    await captureCommand(store, now);
    // No confirm prompt — it ran straight through.
    expect(store.getState().voice.phase).toBe("idle");
    expect(commands.nextTerminal).toHaveBeenCalledOnce();
  });

  it("abort commands clear the UI without touching app state", async () => {
    const now = { t: 1000 };
    const { store, commands, insert } = setup({ stopText: "cancel", now: () => now.t });
    await captureCommand(store, now);
    expect(store.getState().voice.phase).toBe("idle");
    expect(insert).not.toHaveBeenCalled();
    expect(commands.newSession).not.toHaveBeenCalled();
  });

  it("falls through to dictation for an unrecognized utterance", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({
      stopText: "add a test for the parser",
      now: () => now.t,
    });
    await captureCommand(store, now);
    // Not a command → normal review-before-insert dictation path.
    expect(store.getState().voice).toMatchObject({
      phase: "review",
      text: "add a test for the parser",
    });
    expect(commands.newSession).not.toHaveBeenCalled();
  });

  it("never runs a destructive-sounding near-miss as a command", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({
      stopText: "delete the project",
      now: () => now.t,
    });
    await captureCommand(store, now);
    expect(store.getState().voice.phase).toBe("review");
    expect(commands.newSession).not.toHaveBeenCalled();
    expect(commands.switchTerminal).not.toHaveBeenCalled();
    expect(commands.submit).not.toHaveBeenCalled();
  });

  it("downgrades command mode to dictation without the vox.commands entitlement", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({
      features: [], // no entitlement
      stopText: "new terminal",
      now: () => now.t,
    });
    await store.getState().pressCommand();
    // Mode never becomes "command" when unentitled.
    const capturing = store.getState().voice;
    expect(capturing.phase === "capturing" && capturing.mode).toBe("dictation");

    now.t += MIN_CAPTURE_MS;
    await store.getState().release();
    // The words are dictated, not run as a command.
    expect(store.getState().voice).toMatchObject({
      phase: "review",
      text: "new terminal",
    });
    expect(commands.newSession).not.toHaveBeenCalled();
  });

  // Regression: cancelCapture() is the same handler the shortcut dispatcher
  // fires on window blur / tab-hidden ("capture abandoned"). Before this fix
  // it only recognized "capturing"/"transcribing", so a pending confirm (the
  // "command" phase) survived the app losing focus — it would linger until an
  // unrelated Enter keypress anywhere in the app confirmed it later, since the
  // confirm popover's Enter listener is a global window listener.
  it("a pending command confirm is dismissed when the app abandons the capture", async () => {
    const now = { t: 1000 };
    const { store, commands } = setup({ stopText: "send", now: () => now.t });
    await captureCommand(store, now);
    expect(store.getState().voice.phase).toBe("command");

    // Simulate the dispatcher's abandonment path (window blur / tab hidden).
    await store.getState().cancelCapture();

    expect(store.getState().voice.phase).toBe("idle");
    // A later, unrelated Enter press cannot resurrect and run the stale command.
    await store.getState().confirmCommand();
    expect(commands.submit).not.toHaveBeenCalled();
  });
});
