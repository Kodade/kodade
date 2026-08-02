import { describe, expect, it, vi } from "vitest";
import { MockPtyIpc, MockVoxIpc } from "../ipc/mock";
import { fromBase64 } from "../terminal/base64";
import { TerminalSession } from "../terminal/session";
import { MODEL_BY_ID, VoiceModelManager } from "./models";
import { frameForInsertion } from "./insertion";
import { initialVoiceState, MIN_CAPTURE_MS, type VoiceTarget } from "./reducer";
import { createVoiceStore, VOICE_IDLE_TEARDOWN_MS } from "./store";

const target: VoiceTarget = {
  kind: "terminal",
  sessionId: "terminal-1",
};
const TERMINAL_ID = "terminal-1";

function setup(over: {
  preferences?: Partial<{
    installedModelIds: ("base.en" | "small.en")[];
    reviewBeforeInsert: boolean;
    modelsDir: string | null;
    inputDeviceId: string | null;
    pushToTalkCombo: string | null;
    pushToTalkCommandCombo: string | null;
  }>;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  isMac?: () => boolean;
  insert?: (target: VoiceTarget, text: string) => Promise<void>;
  openMicrophonePrivacySettings?: () => Promise<void>;
} = {}) {
  const vox = new MockVoxIpc();
  const pty = new MockPtyIpc();
  const session = new TerminalSession(pty, { write: () => undefined }, {
    id: TERMINAL_ID,
    cwd: "/project",
    cols: 80,
    rows: 24,
  });
  const preferences = {
    modelId: "base.en" as const,
    installedModelIds: ["base.en"] as ("base.en" | "small.en")[],
    reviewBeforeInsert: true,
    reviewBeforeInsertConfigured: true,
    modelsDir: null,
    inputDeviceId: null,
    commandAutoConfirm: false,
    pushToTalkCombo: null,
    pushToTalkCommandCombo: null,
    ...over.preferences,
  };
  const savePreferences = vi.fn();
  const openMicrophonePrivacySettings =
    over.openMicrophonePrivacySettings ?? vi.fn(async () => undefined);
  const store = createVoiceStore(
    {
      vox,
      models: new VoiceModelManager(vox),
      resolveTarget: () => target,
      insert: over.insert ?? (async (to, text) => {
        if (to.kind === "terminal") {
          await session.command(frameForInsertion(text, true));
        }
      }),
      savePreferences,
      openMicrophonePrivacySettings,
      now: over.now,
      setTimeout: over.setTimeout,
      isMac: over.isMac,
    },
    preferences,
  );
  return { vox, pty, session, savePreferences, openMicrophonePrivacySettings, store };
}

describe("voice store", () => {
  it("gates capture behind the first model download", async () => {
    const { store, vox } = setup({ preferences: { installedModelIds: [] } });

    await store.getState().press();

    expect(store.getState().voice.phase).toBe("no-model");
    expect(vox.inits).toEqual([]);
  });

  it("downloads the selected model and records it as available", async () => {
    const { store, vox, savePreferences } = setup({ preferences: { installedModelIds: [] } });
    vox.nextDownload = {
      sha256: MODEL_BY_ID["base.en"].sha256,
      bytes: MODEL_BY_ID["base.en"].bytes,
    };
    vox.downloadProgress = [{ downloaded: 4, total: MODEL_BY_ID["base.en"].bytes }];
    await store.getState().press();

    await store.getState().downloadSelectedModel();

    expect(vox.downloads).toHaveLength(1);
    expect(store.getState().preferences.installedModelIds).toEqual(["base.en"]);
    expect(savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ installedModelIds: ["base.en"] }),
    );
    expect(store.getState().voice).toEqual(initialVoiceState);
  });

  it("holds to capture, then reviews and inserts framed terminal bytes", async () => {
    let now = 1_000;
    const { store, vox, pty, session } = setup({ now: () => now });
    await session.start();
    vox.nextStop = { utteranceId: "utterance-1", text: "add a focused test\n", durationMs: 850 };

    await store.getState().press();
    vox.emitCapture({ type: "level", rms: 0.4 });
    now += MIN_CAPTURE_MS;
    await store.getState().release();

    expect(store.getState().voice).toMatchObject({ phase: "review", text: "add a focused test" });
    expect(pty.writes).toEqual([]);

    await store.getState().insertReview();

    expect(new TextDecoder().decode(fromBase64(pty.writes[0].data))).toBe(
      "\x1b[200~add a focused test\x1b[201~",
    );
    expect(store.getState().voice.phase).toBe("idle");
  });

  it("discards a reviewed transcript without writing to the terminal", async () => {
    let now = 1_000;
    const { store, vox, pty, session } = setup({ now: () => now });
    await session.start();
    vox.nextStop = { utteranceId: "utterance-1", text: "do not paste", durationMs: 850 };

    await store.getState().press();
    now += MIN_CAPTURE_MS;
    await store.getState().release();
    store.getState().discardReview();

    expect(pty.writes).toEqual([]);
    expect(store.getState().voice.phase).toBe("idle");
  });

  it("can insert immediately when review is turned off", async () => {
    let now = 1_000;
    const { store, vox, pty, session } = setup({
      now: () => now,
      preferences: { reviewBeforeInsert: false },
    });
    await session.start();
    vox.nextStop = { utteranceId: "utterance-1", text: "paste this", durationMs: 850 };

    await store.getState().press();
    now += MIN_CAPTURE_MS;
    await store.getState().release();

    expect(store.getState().voice.phase).toBe("idle");
    expect(new TextDecoder().decode(fromBase64(pty.writes[0].data))).toBe(
      "\x1b[200~paste this\x1b[201~",
    );
  });

  it("cancels a tap shorter than 300ms instead of transcribing", async () => {
    let now = 1_000;
    const { store, vox } = setup({ now: () => now });

    await store.getState().press();
    now += MIN_CAPTURE_MS - 1;
    await store.getState().release();

    expect(vox.cancels).toBe(1);
    expect(vox.stops).toBe(0);
    expect(store.getState().voice.phase).toBe("idle");
  });

  it("cancels an active capture without producing a transcript", async () => {
    const { store, vox } = setup();

    await store.getState().press();
    await store.getState().cancelCapture();

    expect(vox.cancels).toBe(1);
    expect(store.getState().voice.phase).toBe("idle");
  });

  it("cancels a release before native capture acknowledgement instead of stopping", async () => {
    let now = 1_000;
    const { store, vox } = setup({ now: () => now });
    vox.autoCaptureState = false;

    await store.getState().press();
    now += MIN_CAPTURE_MS + 1_000;
    await store.getState().release();

    expect(vox.cancels).toBe(1);
    expect(vox.stops).toBe(0);
    expect(store.getState().voice.phase).toBe("idle");
  });

  it("starts the minimum-duration clock when native capture is acknowledged", async () => {
    let now = 1_000;
    const { store, vox } = setup({ now: () => now });
    vox.autoCaptureState = false;

    await store.getState().press();
    now += 5_000;
    vox.emitCapture({ type: "state", state: "capturing" });
    now += MIN_CAPTURE_MS - 1;
    await store.getState().release();

    expect(vox.cancels).toBe(1);
    expect(vox.stops).toBe(0);
  });

  it("waits for its utterance id after acknowledgement instead of cancelling a valid release", async () => {
    let now = 1_000;
    const { store, vox } = setup({ now: () => now });
    vox.deferStart = true;
    vox.nextStop = { utteranceId: "utterance-1", text: "after ack", durationMs: 850 };

    const press = store.getState().press();
    await vi.waitFor(() => expect(vox.starts).toHaveLength(1));
    now += MIN_CAPTURE_MS;
    await store.getState().release();

    expect(vox.cancels).toBe(0);
    vox.resolveStart();
    await press;
    expect(vox.stops).toBe(1);
    expect(store.getState().voice).toMatchObject({ phase: "review", text: "after ack" });
  });

  it("ignores a second keydown while a capture is already active", async () => {
    const { store, vox } = setup();

    await store.getState().press();
    await store.getState().press();

    expect(vox.starts).toHaveLength(1);
  });

  it("turns permission and device failures into actionable inline states", async () => {
    const denied = setup({ isMac: () => true });
    denied.vox.failInitWith = new Error("microphone permission denied");
    await denied.store.getState().press();
    expect(denied.store.getState().voice).toMatchObject({
      phase: "error",
      message: "Allow microphone access in System Settings → Privacy & Security → Microphone.",
    });

    const disconnected = setup();
    await disconnected.store.getState().press();
    disconnected.vox.emitCapture({ type: "error", message: "input device disconnected" });
    expect(disconnected.store.getState().voice).toMatchObject({
      phase: "idle",
      notice: "Microphone disconnected.",
    });
  });

  it("drops a stop result for a different utterance and tears down the native capture", async () => {
    let now = 1_000;
    const { store, vox } = setup({ now: () => now });
    vox.nextUtteranceId = "utterance-current";
    vox.nextStop = { utteranceId: "utterance-stale", text: "wrong target", durationMs: 850 };

    await store.getState().press();
    now += MIN_CAPTURE_MS;
    await store.getState().release();

    expect(store.getState().voice.phase).toBe("idle");
    expect(vox.cancels).toBe(1);
    expect(vox.teardowns).toBe(1);
  });

  it("does not let an old capture channel error terminate a newer capture", async () => {
    const { store, vox } = setup();

    await store.getState().press();
    await store.getState().cancelCapture();
    await store.getState().press();
    vox.emitCaptureForStart(0, { type: "error", message: "old capture failed" });

    expect(store.getState().voice.phase).toBe("capturing");
  });

  it("does not tear down a newer capture when a cancelled init resolves late", async () => {
    const { store, vox } = setup();
    vox.deferInit = true;

    const first = store.getState().press();
    await vi.waitFor(() => expect(vox.inits).toHaveLength(1));
    await store.getState().cancelCapture();
    const second = store.getState().press();
    await vi.waitFor(() => expect(vox.inits).toHaveLength(2));
    vox.resolveInit();
    await Promise.resolve();

    expect(vox.teardowns).toBe(0);
    expect(vox.starts).toHaveLength(0);

    vox.resolveInit();
    await second;
    await first;
    expect(vox.starts).toHaveLength(1);
    expect(store.getState().voice.phase).toBe("capturing");
  });

  it("cancels and tears down native capture when stop rejects", async () => {
    let now = 1_000;
    const { store, vox } = setup({ now: () => now });
    vox.failStopWith = new Error("native stop failed");

    await store.getState().press();
    now += MIN_CAPTURE_MS;
    await store.getState().release();

    expect(store.getState().voice.phase).toBe("error");
    expect(vox.cancels).toBe(1);
    expect(vox.teardowns).toBe(1);
  });

  it("cancels and tears down native capture when its channel reports an error", async () => {
    const { store, vox } = setup();

    await store.getState().press();
    vox.emitCapture({ type: "error", message: "native capture failed" });
    await Promise.resolve();

    expect(store.getState().voice.phase).toBe("error");
    expect(vox.cancels).toBe(1);
    expect(vox.teardowns).toBe(1);
  });

  it("keeps a reviewed transcript when a late global channel error arrives", async () => {
    let now = 1_000;
    const { store, vox } = setup({ now: () => now });
    vox.nextStop = { utteranceId: "utterance-1", text: "keep this", durationMs: 850 };
    store.getState().start();
    await Promise.resolve();

    await store.getState().press();
    now += MIN_CAPTURE_MS;
    await store.getState().release();
    vox.emitError("late native error");
    await Promise.resolve();

    expect(store.getState().voice).toMatchObject({
      phase: "review",
      text: "keep this",
      error: "late native error",
    });
  });

  it("begins review insertion synchronously so repeated Enter cannot write twice", async () => {
    let now = 1_000;
    let resolveInsert: (() => void) | undefined;
    const insert = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveInsert = resolve;
      }),
    );
    const { store, vox } = setup({ now: () => now, insert });
    vox.nextStop = { utteranceId: "utterance-1", text: "insert once", durationMs: 850 };

    await store.getState().press();
    now += MIN_CAPTURE_MS;
    await store.getState().release();
    const first = store.getState().insertReview();
    const second = store.getState().insertReview();

    expect(insert).toHaveBeenCalledOnce();
    resolveInsert?.();
    await first;
    await second;
    expect(store.getState().voice.phase).toBe("idle");
  });

  it("marks a missing or corrupt selected model unavailable so it can be downloaded again", async () => {
    const { store, vox, savePreferences } = setup();
    vox.failInitWith = new Error("model file not found");

    await store.getState().press();

    expect(store.getState().voice.phase).toBe("no-model");
    expect(store.getState().preferences.installedModelIds).toEqual([]);
    expect(savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ installedModelIds: [] }),
    );
  });

  it("clears stale model metadata even when deleting its file fails", async () => {
    const { store, vox, savePreferences } = setup();
    vox.failDeleteModelWith = new Error("file already missing");

    await store.getState().deleteModel("base.en");

    expect(store.getState().preferences.installedModelIds).toEqual([]);
    expect(savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ installedModelIds: [] }),
    );
  });

  it("tears down the active model engine before deleting the model file", async () => {
    const { store, vox } = setup();

    await store.getState().deleteModel("base.en");

    expect(vox.operations).toEqual(["teardown", "delete-model"]);
  });

  it("keeps preferences changed during a download when recording the completed model", async () => {
    const { store, vox } = setup({ preferences: { installedModelIds: [] } });
    vox.deferDownload = true;
    vox.nextDownload = {
      sha256: MODEL_BY_ID["base.en"].sha256,
      bytes: MODEL_BY_ID["base.en"].bytes,
    };
    const download = store.getState().downloadSelectedModel();
    await vi.waitFor(() => expect(vox.downloads).toHaveLength(1));
    store.getState().setReviewBeforeInsert(false);
    vox.resolveDownload();
    await download;

    expect(store.getState().preferences).toMatchObject({
      installedModelIds: ["base.en"],
      reviewBeforeInsert: false,
    });
  });

  it("surfaces a corrupt-download cleanup failure", async () => {
    const { store, vox } = setup({ preferences: { installedModelIds: [] } });
    vox.nextDownload = { sha256: "wrong", bytes: 1 };
    vox.failDeleteModelWith = new Error("file is locked");

    await store.getState().downloadSelectedModel();

    expect(store.getState().voice).toMatchObject({
      phase: "error",
      message: expect.stringContaining("corrupt file could not be removed"),
    });
  });

  it("shows an empty-transcript notice and releases the engine after idle time", async () => {
    let now = 1_000;
    let idleTimer: (() => void) | undefined;
    const { store, vox } = setup({
      now: () => now,
      setTimeout: ((callback: TimerHandler, ms?: number) => {
        expect(ms).toBe(VOICE_IDLE_TEARDOWN_MS);
        idleTimer = callback as () => void;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });
    vox.nextStop = { utteranceId: "utterance-1", text: "   ", durationMs: 850 };

    await store.getState().press();
    now += MIN_CAPTURE_MS;
    await store.getState().release();

    expect(store.getState().voice).toMatchObject({ phase: "idle", notice: "Didn't catch that." });
    idleTimer?.();
    expect(vox.teardowns).toBe(1);
  });

  it("does not let an old idle timeout tear down a later idle generation", async () => {
    const timers: (() => void)[] = [];
    const { store, vox } = setup({
      setTimeout: ((callback: TimerHandler) => {
        timers.push(callback as () => void);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });

    await store.getState().press();
    await store.getState().cancelCapture();
    await store.getState().press();
    await store.getState().cancelCapture();
    timers[0]?.();

    expect(vox.teardowns).toBe(0);
  });

  it("passes the preferred input device through to native init", async () => {
    const { store, vox } = setup({ preferences: { inputDeviceId: "USB headset" } });

    await store.getState().press();

    expect(vox.inits).toEqual([{ modelPath: "/app/models/ggml-base.en.bin", deviceName: "USB headset" }]);
  });

  it("threads the storage-location override into model path lookups and downloads", async () => {
    const { store, vox } = setup({
      preferences: { installedModelIds: [], modelsDir: "/custom/models" },
    });
    vox.nextDownload = {
      sha256: MODEL_BY_ID["base.en"].sha256,
      bytes: MODEL_BY_ID["base.en"].bytes,
    };

    await store.getState().downloadSelectedModel();

    expect(vox.downloads).toEqual([
      {
        url: MODEL_BY_ID["base.en"].url,
        destPath: "/custom/models/ggml-base.en.bin",
        expectedSha256: MODEL_BY_ID["base.en"].sha256,
        modelRoot: "/custom/models",
      },
    ]);
  });

  it("clears installed models when the storage location changes, since files don't move", () => {
    const { store, savePreferences } = setup();

    store.getState().setModelsDir("/new/location");

    expect(savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ modelsDir: "/new/location", installedModelIds: [] }),
    );
  });

  it("ignores redundant storage-location changes and changes while busy", async () => {
    const { store, savePreferences } = setup();

    store.getState().setModelsDir(null); // already the default
    expect(savePreferences).not.toHaveBeenCalled();

    await store.getState().press();
    store.getState().setModelsDir("/new/location");
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it("populates the input-device list from native enumeration", async () => {
    const { store, vox } = setup();
    vox.inputDevices = ["Built-in Microphone", "Conference Room Mic"];

    await store.getState().refreshInputDevices();

    expect(store.getState().inputDevices).toEqual(["Built-in Microphone", "Conference Room Mic"]);
  });

  it("leaves the device list empty when enumeration fails, without throwing", async () => {
    const { store, vox } = setup();
    vox.failListInputDevicesWith = new Error("unsupported");

    await expect(store.getState().refreshInputDevices()).resolves.toBeUndefined();
    expect(store.getState().inputDevices).toEqual([]);
  });

  it("saves the selected input device and ignores redundant or busy changes", async () => {
    const { store, savePreferences } = setup();

    store.getState().setInputDevice("USB headset");
    expect(savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ inputDeviceId: "USB headset" }),
    );

    savePreferences.mockClear();
    store.getState().setInputDevice("USB headset");
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it("persists KödWhisper shortcut overrides and their resets", () => {
    const { store, savePreferences } = setup();

    store.getState().setPushToTalkCombo("Mod-Alt-v");
    expect(savePreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ pushToTalkCombo: "Mod-Alt-v" }),
    );

    store.getState().setPushToTalkCommandCombo("Mod-Shift-k");
    expect(savePreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ pushToTalkCommandCombo: "Mod-Shift-k" }),
    );

    store.getState().setPushToTalkCombo(null);
    expect(savePreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ pushToTalkCombo: null }),
    );
  });

  it("opens the microphone privacy settings deep link and swallows failures", async () => {
    const openMicrophonePrivacySettings = vi.fn(async () => {
      throw new Error("unsupported on this platform");
    });
    const { store } = setup({ openMicrophonePrivacySettings });

    await expect(store.getState().openPrivacySettings()).resolves.toBeUndefined();
    expect(openMicrophonePrivacySettings).toHaveBeenCalledOnce();
  });
});
