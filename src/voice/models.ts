import type { VoxIpc } from "../ipc/contract";
import { BINDINGS } from "../shortcuts/bindings";
import { comboSignature, parseCombo } from "../shortcuts/match";

export type VoiceModel = {
  id: "base.en" | "small.en" | "large-v3-turbo";
  fileName: string;
  label: string;
  description: string;
  bytes: number;
  url: string;
  sha256: string;
  // KödWhisper Pro tier (M9e): the model is only offered when `vox.streaming`
  // is entitled. The free tiers (base.en/small.en) leave this false/absent, so
  // free-tier behavior is untouched when entitlements are empty.
  pro?: boolean;
  // Expert-matrix guidance (Settings → Advanced → KödWhisper). Novices never
  // see these fields; the expert view renders them alongside the checksum.
  speed: string;
  accuracy: string;
  ramGuidance: string;
  language: string;
};

// SHA-256 values come from the Hugging Face LFS pointer metadata fetched from
// ggerganov/whisper.cpp on 2026-07-14 (not from a mutable release page).
export const VOICE_MODELS = [
  {
    id: "base.en",
    fileName: "ggml-base.en.bin",
    label: "Recommended",
    description: "Fast everyday voice input",
    bytes: 147_964_211,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    pro: false,
    speed: "Fast — transcribes well under real time on any CPU",
    accuracy: "Good for clear speech and short prompts",
    ramGuidance: "Comfortable on any machine, including Windows CPU-only laptops",
    language: "English only",
  },
  {
    id: "small.en",
    fileName: "ggml-small.en.bin",
    label: "Higher quality",
    description: "More accurate, uses more space",
    bytes: 487_614_201,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    pro: false,
    speed: "Moderate — still faster than real time on a capable machine",
    accuracy: "Better on accents, background noise, and technical vocabulary",
    ramGuidance: "Recommended on 8+ cores / 16 GB+ RAM",
    language: "English only",
  },
  {
    id: "large-v3-turbo",
    fileName: "ggml-large-v3-turbo.bin",
    label: "Turbo (Pro)",
    description: "Highest accuracy, large download",
    bytes: 1_624_555_275,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    pro: true,
    speed: "Fast for its size — ~8× large-v3 speed on Apple Silicon",
    accuracy: "Best-in-class on accents, noise, and dense technical vocabulary",
    ramGuidance: "Wants Apple Silicon or a strong GPU and 16 GB+ RAM",
    language: "Multilingual",
  },
] as const satisfies readonly VoiceModel[];

// Cores at/above which the turbo tier and streaming partials are worth
// suggesting. Higher than small.en's bar — turbo is a 1.6 GB multilingual model
// and streaming re-decodes the growing buffer, so both want real headroom.
export const STREAMING_MIN_CORES = 8;

// True when a model is Pro-gated (offered only with `vox.streaming`). Used by
// the settings UI and the store's model-selection guard so a free session can
// never land on a Pro model.
export function isProModel(modelId: VoiceModelId): boolean {
  return MODEL_BY_ID[modelId]?.pro === true;
}

// Cores at/above this suggest hardware capable of small.en without a
// noticeably slower transcribe-on-release turnaround. navigator.hardwareConcurrency
// is the one capability signal available identically in both WKWebView
// (macOS) and WebView2 (Windows) — deviceMemory is Chromium-only.
export const CAPABLE_HARDWARE_CORES = 8;

// Pure novice-polish heuristic: suggest the small.en upgrade only when the
// user is still on base.en, hasn't already installed small.en, and the
// machine looks capable. Kept pure/testable — no navigator access here.
export function suggestsSmallEnUpgrade(
  cores: number,
  modelId: VoiceModelId,
  installedModelIds: readonly VoiceModelId[],
): boolean {
  return (
    cores >= CAPABLE_HARDWARE_CORES &&
    modelId === "base.en" &&
    !installedModelIds.includes("small.en")
  );
}

export type VoiceModelId = (typeof VOICE_MODELS)[number]["id"];

export const MODEL_BY_ID: Record<VoiceModelId, VoiceModel> = Object.fromEntries(
  VOICE_MODELS.map((model) => [model.id, model]),
) as Record<VoiceModelId, VoiceModel>;

export type VoicePreferences = {
  modelId: VoiceModelId;
  installedModelIds: VoiceModelId[];
  reviewBeforeInsert: boolean;
  // Added in 1.3.1 so the old review-by-default value can migrate to the new
  // one-step flow without erasing a future explicit review opt-in.
  reviewBeforeInsertConfigured: boolean;
  // Expert storage-location override: an absolute directory models download
  // into and load from. null keeps the default appDataDir()/models root.
  // Changing it does not move already-downloaded files (see setModelsDir in
  // store.ts), so it always pairs with clearing installedModelIds.
  modelsDir: string | null;
  // Expert input-device override: a microphone name from listInputDevices().
  // null keeps the host default; Rust falls back silently if the named
  // device has disappeared since it was picked.
  inputDeviceId: string | null;
  // KödWhisper Pro voice commands (M9f). When false (default) every recognized
  // command shows the confirm guard before it runs. When true, an expert opts
  // into skipping the prompt for SAFE (non-submitting) commands only — "send"
  // is always guarded regardless. Free/unentitled sessions ignore this.
  commandAutoConfirm: boolean;
  // null keeps KödWhisper's built-in hold-to-talk binding. Overrides must use
  // Mod so they survive the terminal-focus shortcut gate.
  pushToTalkCombo: string | null;
  pushToTalkCommandCombo: string | null;
};

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  modelId: "base.en",
  installedModelIds: [],
  reviewBeforeInsert: false,
  reviewBeforeInsertConfigured: false,
  modelsDir: null,
  inputDeviceId: null,
  commandAutoConfirm: false,
  pushToTalkCombo: null,
  pushToTalkCommandCombo: null,
};

function normalizePushToTalkCombo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseCombo(value);
  return parsed.valid && parsed.mod && parsed.key ? value : null;
}

function collidesWith(combo: string, candidates: readonly string[]): boolean {
  const signature = comboSignature(combo);
  return signature !== null && candidates.some((candidate) => comboSignature(candidate) === signature);
}

export function normalizeVoicePreferences(value: unknown): VoicePreferences {
  if (typeof value !== "object" || value === null) return DEFAULT_VOICE_PREFERENCES;
  const data = value as Record<string, unknown>;
  const modelId = isVoiceModelId(data.modelId) ? data.modelId : "base.en";
  const installedModelIds = Array.isArray(data.installedModelIds)
    ? [...new Set(data.installedModelIds.filter(isVoiceModelId))]
    : [];
  const otherBindingCombos = BINDINGS.filter(
    (binding) =>
      binding.id !== "push-to-talk" && binding.id !== "push-to-talk-command",
  ).map((binding) => binding.combo);
  const defaultPushToTalkCombo = BINDINGS.find(
    (binding) => binding.id === "push-to-talk",
  )?.combo ?? "";
  const defaultPushToTalkCommandCombo = BINDINGS.find(
    (binding) => binding.id === "push-to-talk-command",
  )?.combo ?? "";

  let pushToTalkCombo = normalizePushToTalkCombo(data.pushToTalkCombo);
  let pushToTalkCommandCombo = normalizePushToTalkCombo(data.pushToTalkCommandCombo);

  if (pushToTalkCombo && collidesWith(pushToTalkCombo, otherBindingCombos)) {
    pushToTalkCombo = null;
  }
  if (pushToTalkCommandCombo && collidesWith(pushToTalkCommandCombo, otherBindingCombos)) {
    pushToTalkCommandCombo = null;
  }
  // A sibling override replaces its default. On a mutual override collision,
  // dictation wins and command mode is discarded below.
  if (
    pushToTalkCombo &&
    !pushToTalkCommandCombo &&
    collidesWith(pushToTalkCombo, [defaultPushToTalkCommandCombo])
  ) {
    pushToTalkCombo = null;
  }
  if (
    pushToTalkCommandCombo &&
    collidesWith(pushToTalkCommandCombo, [pushToTalkCombo ?? defaultPushToTalkCombo])
  ) {
    pushToTalkCommandCombo = null;
  }

  const reviewBeforeInsertConfigured =
    data.reviewBeforeInsertConfigured === true;

  return {
    modelId,
    installedModelIds,
    reviewBeforeInsert:
      reviewBeforeInsertConfigured && data.reviewBeforeInsert === true,
    reviewBeforeInsertConfigured,
    modelsDir: typeof data.modelsDir === "string" && data.modelsDir.trim() ? data.modelsDir : null,
    inputDeviceId:
      typeof data.inputDeviceId === "string" && data.inputDeviceId.trim()
        ? data.inputDeviceId
        : null,
    commandAutoConfirm:
      typeof data.commandAutoConfirm === "boolean" ? data.commandAutoConfirm : false,
    pushToTalkCombo,
    pushToTalkCommandCombo,
  };
}

export function isVoiceModelId(value: unknown): value is VoiceModelId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(MODEL_BY_ID, value)
  );
}

export class ModelChecksumError extends Error {
  constructor(
    public readonly model: VoiceModel,
    public readonly cleanupError: unknown = null,
  ) {
    super(
      cleanupError
        ? "The downloaded voice model did not pass verification, and its corrupt file could not be removed."
        : "The downloaded voice model did not pass verification.",
    );
    this.name = "ModelChecksumError";
  }
}

export class VoiceModelManager {
  constructor(
    private vox: Pick<VoxIpc, "downloadModel" | "deleteModel" | "modelPath">,
  ) {}

  // modelsDir is the expert storage-location override (omitted/null = default
  // appDataDir()/models). Every path/download/delete call takes it explicitly
  // rather than caching it, since the store is the source of truth and the
  // override can change between calls.
  async pathFor(modelId: VoiceModelId, modelsDir?: string | null): Promise<string> {
    return this.vox.modelPath(MODEL_BY_ID[modelId].fileName, modelsDir);
  }

  async download(
    modelId: VoiceModelId,
    onProgress: (progress: { downloaded: number; total: number | null }) => void,
    modelsDir?: string | null,
  ): Promise<{ model: VoiceModel; path: string }> {
    const model = MODEL_BY_ID[modelId];
    const path = await this.pathFor(modelId, modelsDir);
    const result = await this.vox.downloadModel(
      { url: model.url, destPath: path, expectedSha256: model.sha256, modelRoot: modelsDir },
      onProgress,
    );
    if (result.sha256.toLowerCase() !== model.sha256) {
      let cleanupError: unknown = null;
      try {
        await this.vox.deleteModel(path, modelsDir);
      } catch (error) {
        cleanupError = error;
      }
      throw new ModelChecksumError(model, cleanupError);
    }
    return { model, path };
  }

  async delete(modelId: VoiceModelId, modelsDir?: string | null): Promise<void> {
    await this.vox.deleteModel(await this.pathFor(modelId, modelsDir), modelsDir);
  }
}
