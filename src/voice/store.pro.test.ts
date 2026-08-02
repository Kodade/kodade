import { describe, expect, it, vi } from "vitest";
import { MockVoxIpc } from "../ipc/mock";
import { FEATURES } from "../license";
import { VoiceModelManager, type VoiceModelId } from "./models";
import { MIN_CAPTURE_MS, type VoiceTarget } from "./reducer";
import { createVoiceStore, type VoiceContext } from "./store";

const target: VoiceTarget = { kind: "terminal", sessionId: "terminal-1" };

function setup(
  over: {
    features?: string[];
    context?: VoiceContext | null;
    streamingCapable?: boolean;
    now?: () => number;
    stopText?: string;
    modelId?: VoiceModelId;
    installedModelIds?: VoiceModelId[];
  } = {},
) {
  const vox = new MockVoxIpc();
  vox.nextStop = {
    utteranceId: "utterance-1",
    text: over.stopText ?? "um add a test",
    durationMs: 850,
  };
  const features = new Set(over.features ?? []);
  const store = createVoiceStore(
    {
      vox,
      models: new VoiceModelManager(vox),
      resolveTarget: () => target,
      insert: vi.fn(async () => undefined),
      savePreferences: vi.fn(),
      openMicrophonePrivacySettings: vi.fn(async () => undefined),
      hasFeature: (feature) => features.has(feature),
      resolveContext: () => over.context ?? null,
      streamingCapable: () => over.streamingCapable ?? true,
      now: over.now,
    },
    {
      modelId: over.modelId ?? "base.en",
      installedModelIds: over.installedModelIds ?? ["base.en"],
      reviewBeforeInsert: true,
      reviewBeforeInsertConfigured: true,
      modelsDir: null,
      inputDeviceId: null,
      commandAutoConfirm: false,
      pushToTalkCombo: null,
      pushToTalkCommandCombo: null,
    },
  );
  return { vox, store };
}

async function captureOnce(store: ReturnType<typeof setup>["store"], now: { t: number }) {
  await store.getState().press();
  now.t += MIN_CAPTURE_MS;
  await store.getState().release();
}

describe("voice store — KodWhisper Pro gating (M9e)", () => {
  it("leaves the transcript raw on the free tier", async () => {
    const now = { t: 1000 };
    const { store } = setup({ now: () => now.t });
    await captureOnce(store, now);
    expect(store.getState().voice).toMatchObject({
      phase: "review",
      text: "um add a test",
    });
  });

  it("runs the cleanup pipeline when vox.cleanup is entitled", async () => {
    const now = { t: 1000 };
    const { store } = setup({
      features: [FEATURES.voxCleanup],
      context: { vocabulary: { terms: [] }, provider: "claude" },
      now: () => now.t,
    });
    await captureOnce(store, now);
    expect(store.getState().voice).toMatchObject({
      phase: "review",
      text: "Add a test",
    });
  });

  it("repairs identifiers using the resolved vocabulary during cleanup", async () => {
    const now = { t: 1000 };
    const { store } = setup({
      features: [FEATURES.voxCleanup],
      context: { vocabulary: { terms: ["appStore"] }, provider: "claude" },
      stopText: "reset the app store",
      now: () => now.t,
    });
    await captureOnce(store, now);
    expect(store.getState().voice).toMatchObject({
      phase: "review",
      text: "Reset the appStore",
    });
  });

  it("treats an all-filler utterance cleaned to empty as no transcript", async () => {
    const now = { t: 1000 };
    const { store } = setup({
      features: [FEATURES.voxCleanup],
      stopText: "um uh basically",
      now: () => now.t,
    });
    await captureOnce(store, now);
    expect(store.getState().voice).toMatchObject({
      phase: "idle",
      notice: "Didn't catch that.",
    });
  });

  it("biases the decode with an initial prompt when vox.vocabulary is entitled", async () => {
    const now = { t: 1000 };
    const { store, vox } = setup({
      features: [FEATURES.voxVocabulary],
      context: { vocabulary: { terms: ["appStore", "voxStart"] }, provider: "claude" },
      now: () => now.t,
    });
    await store.getState().press();
    expect(vox.starts[0].initialPrompt).toBe("Technical terms: appStore, voxStart.");
  });

  it("sends no initial prompt on the free tier", async () => {
    const { store, vox } = setup({ context: { vocabulary: { terms: ["appStore"] }, provider: "claude" } });
    await store.getState().press();
    expect(vox.starts[0].initialPrompt).toBeUndefined();
  });

  it("enables streaming when vox.streaming is entitled and hardware is capable", async () => {
    const { store, vox } = setup({
      features: [FEATURES.voxStreaming],
      streamingCapable: true,
    });
    await store.getState().press();
    expect(vox.starts[0].streaming).toBe(true);
  });

  it("auto-disables streaming below the hardware threshold", async () => {
    const { store, vox } = setup({
      features: [FEATURES.voxStreaming],
      streamingCapable: false,
    });
    await store.getState().press();
    expect(vox.starts[0].streaming).toBeFalsy();
  });

  it("shows a streaming partial in the capture indicator", async () => {
    const { store, vox } = setup({
      features: [FEATURES.voxStreaming],
      streamingCapable: true,
    });
    await store.getState().press();
    vox.emitCapture({ type: "partial", text: "add a focused" });
    const voice = store.getState().voice;
    expect(voice.phase).toBe("capturing");
    expect(voice.phase === "capturing" && voice.partial).toBe("add a focused");
  });

  it("never sets Pro flags when entitlements are empty", async () => {
    const { store, vox } = setup({});
    await store.getState().press();
    expect(vox.starts[0].initialPrompt).toBeUndefined();
    expect(vox.starts[0].streaming).toBeFalsy();
  });

  // Turbo (large-v3-turbo) is a Pro model (vox.streaming). setModel() already
  // refuses to *select* it without entitlement; these pin the two paths that
  // previously bypassed that gate entirely — downloading it directly, and
  // actually using an already-installed one.
  describe("turbo model gating can't be bypassed", () => {
    it("refuses to download the turbo model without vox.streaming", async () => {
      const { store, vox } = setup({ features: [] });
      await store.getState().downloadModel("large-v3-turbo");
      expect(vox.downloads).toHaveLength(0);
      expect(store.getState().preferences.installedModelIds).not.toContain(
        "large-v3-turbo",
      );
    });

    it("downloads the turbo model when vox.streaming is entitled", async () => {
      const { store, vox } = setup({ features: [FEATURES.voxStreaming] });
      vox.nextDownload = {
        sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        bytes: 1,
      };
      await store.getState().downloadModel("large-v3-turbo");
      expect(vox.downloads).toHaveLength(1);
      expect(store.getState().preferences.installedModelIds).toContain(
        "large-v3-turbo",
      );
    });

    it("refuses to capture with an already-installed turbo model once entitlement lapses", async () => {
      // A stale preferences doc: turbo was downloaded and selected while Pro,
      // then the license lapsed (or the doc was hand-edited). press() must
      // independently refuse to use it, not just block re-selecting it.
      const { store } = setup({
        features: [],
        modelId: "large-v3-turbo",
        installedModelIds: ["large-v3-turbo"],
      });
      await store.getState().press();
      expect(store.getState().voice.phase).toBe("no-model");
    });

    it("still captures with turbo when entitlement is present", async () => {
      const { store } = setup({
        features: [FEATURES.voxStreaming],
        modelId: "large-v3-turbo",
        installedModelIds: ["large-v3-turbo"],
        streamingCapable: true,
      });
      await store.getState().press();
      expect(store.getState().voice.phase).toBe("capturing");
    });
  });
});
