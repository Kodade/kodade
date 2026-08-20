import { createStore } from "zustand/vanilla";
import type { VoxIpc, VoxStartArgs } from "../ipc/contract";
import {
  DEFAULT_VOICE_PREFERENCES,
  ModelChecksumError,
  isProModel,
  STREAMING_MIN_CORES,
  type VoiceModelId,
  type VoicePreferences,
  VoiceModelManager,
} from "./models";
import { cleanTranscript, type CleanupProvider } from "./cleanup/pipeline";
import { buildInitialPrompt } from "./vocabulary/initialPrompt";
import type { Vocabulary } from "./vocabulary/types";
import { FEATURES, hasFeature as licenseHasFeature } from "../license";
import {
  MIN_CAPTURE_MS,
  initialVoiceState,
  reduceVoice,
  type VoiceEvent,
  type VoiceMode,
  type VoiceState,
  type VoiceTarget,
} from "./reducer";
import {
  commandLabel,
  isAbortCommand,
  isSubmittingCommand,
  parseVoiceCommand,
  type VoiceCommand,
} from "./commands/grammar";

export const VOICE_IDLE_TEARDOWN_MS = 60_000;

// The Pro intelligence context for one capture (M9e): the project's vocabulary
// (for decode bias + identifier repair) and which agent CLI the focused terminal
// is running (for the per-provider cleanup preset). Resolved once at press().
export type VoiceContext = {
  vocabulary: Vocabulary;
  provider: CleanupProvider;
};

// The app-action surface KödWhisper Pro voice commands (M9f) drive. These map
// one-to-one onto EXISTING app actions (the same ones behind keyboard shortcuts
// and the sidebar) — voice never invents a parallel action path, so it inherits
// every guard those actions already enforce. Injected so the store never
// imports a live app store. Absent (free path / not wired) = commands disabled.
export type VoiceCommandActions = {
  // How many terminals the active project has — bounds "switch to terminal N".
  sessionCount(): number;
  newSession(): void;
  // Focus the 1-based Nth terminal. Returns false when it doesn't exist, so an
  // out-of-range command no-ops gracefully instead of mis-firing.
  switchTerminal(index: number): boolean;
  nextTerminal(): void;
  prevTerminal(): void;
  // Submit the focused terminal (the "send" verb). Goes through the app's PTY
  // write path — the same channel dictation uses — never a synthesized key.
  submit(): void | Promise<void>;
};

export type VoiceStoreDeps = {
  vox: VoxIpc;
  models: VoiceModelManager;
  resolveTarget(): VoiceTarget | null;
  insert(target: VoiceTarget, text: string): Promise<void>;
  savePreferences(preferences: VoicePreferences): void;
  // Deep-links to the OS mic-privacy pane for the permission-denied guidance.
  openMicrophonePrivacySettings(): Promise<void>;
  // Pro gating (M9e). All KödWhisper Pro behavior is fronted by this boolean —
  // the store never imports a verifier. Defaults to the app-wide license gate;
  // tests inject their own to exercise free vs Pro without a token.
  hasFeature?(feature: string): boolean;
  // The project vocabulary + provider for the active capture. Null (the default)
  // means no bias/cleanup context — the free-tier path.
  resolveContext?(): VoiceContext | null;
  // Voice-command app actions (M9f, Pro). Absent = commands unavailable (a
  // command-mode press then just dictates).
  commands?: VoiceCommandActions;
  // Whether the hardware can keep up with streaming partials. Below this the
  // feature auto-disables even for Pro. Defaults to a core-count check.
  streamingCapable?(): boolean;
  now?(): number;
  setTimeout?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout?(timer: ReturnType<typeof setTimeout>): void;
  isMac?(): boolean;
};

function defaultStreamingCapable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.hardwareConcurrency === "number" &&
    navigator.hardwareConcurrency >= STREAMING_MIN_CORES
  );
}

export type VoiceStoreState = {
  voice: VoiceState;
  preferences: VoicePreferences;
  // Expert input-device picker (Settings → Advanced → KödWhisper). Empty
  // until refreshInputDevices() resolves; enumeration failing leaves it empty
  // and the host default keeps working regardless.
  inputDevices: string[];
  start(): void;
  press(mode?: VoiceMode): Promise<void>;
  // Start a command-mode capture (M9f, Pro). Downgrades to dictation when
  // vox.commands is not entitled or command actions aren't wired.
  pressCommand(): Promise<void>;
  // Confirm / cancel a pending voice command (the confirm guard).
  confirmCommand(): Promise<void>;
  cancelCommand(): void;
  release(): Promise<void>;
  toggle(): Promise<void>;
  cancelCapture(): Promise<void>;
  downloadSelectedModel(): Promise<void>;
  downloadModel(modelId: VoiceModelId): Promise<void>;
  deleteModel(modelId: VoiceModelId): Promise<void>;
  setModel(modelId: VoiceModelId): void;
  setReviewBeforeInsert(enabled: boolean): void;
  setCommandAutoConfirm(enabled: boolean): void;
  setPushToTalkCombo(combo: string | null): void;
  setPushToTalkCommandCombo(combo: string | null): void;
  refreshInputDevices(): Promise<void>;
  setInputDevice(deviceId: string | null): void;
  setModelsDir(modelsDir: string | null): void;
  openPrivacySettings(): Promise<void>;
  insertReview(): Promise<void>;
  discardReview(): void;
  dismiss(): void;
  dispose(): Promise<void>;
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDeviceError(message: string): boolean {
  return /device|disconnected|unplugged|no input/i.test(message);
}

function isUnavailableModelError(message: string): boolean {
  return /(?:model.*(?:missing|not found|corrupt|invalid|load)|(?:missing|not found|corrupt|invalid).*(?:model|file)|no such file)/i.test(
    message,
  );
}

function friendlyError(message: string, isMac: boolean): string {
  if (/permission|not authorized|access denied|microphone.*denied/i.test(message)) {
    return isMac
      ? "Allow microphone access in System Settings → Privacy & Security → Microphone."
      : "Allow microphone access in Settings → Privacy → Microphone.";
  }
  return message || "Voice input stopped unexpectedly.";
}

// Owns the side effects around the pure reducer: Tauri calls, model download,
// idle lifetime, and final insertion. Every capture has a generation so a late
// native completion/event can never mutate a newer capture's state.
export function createVoiceStore(
  deps: VoiceStoreDeps,
  initialPreferences: VoicePreferences = DEFAULT_VOICE_PREFERENCES,
) {
  const now = deps.now ?? (() => Date.now());
  const setTimer =
    deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((timer) => clearTimeout(timer));
  const isMac = deps.isMac ?? (() => /Mac/i.test(navigator.platform));
  const hasFeature = deps.hasFeature ?? licenseHasFeature;
  const resolveContext = deps.resolveContext ?? (() => null);
  const streamingCapable = deps.streamingCapable ?? defaultStreamingCapable;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let offError: (() => void) | null = null;
  let errorListenerId = 0;
  let captureGeneration = 0;
  let pendingReleaseGeneration: number | null = null;
  let disposed = false;
  // The Pro context resolved at press() and reused at stop(), so the vocabulary
  // and provider that biased the decode are the same ones the cleanup uses.
  let captureContext: VoiceContext | null = null;
  // Which intent this capture carries (M9f). Set at press(); read at stop() to
  // decide whether the transcript is parsed as a command or dictated. Only ever
  // "command" when vox.commands is entitled AND command actions are wired.
  let captureMode: VoiceMode = "dictation";

  return createStore<VoiceStoreState>((set, get) => {
    const clearIdleTimer = () => {
      if (idleTimer === null) return;
      clearTimer(idleTimer);
      idleTimer = null;
    };

    const clearErrorListener = () => {
      errorListenerId++;
      offError?.();
      offError = null;
    };

    const isCurrentCapture = (generation: number) =>
      !disposed && generation === captureGeneration;

    const transition = (event: VoiceEvent) => {
      const previous = get().voice;
      const voice = reduceVoice(previous, event);
      set({ voice });
      if (voice.phase !== "idle") {
        clearIdleTimer();
      } else if (previous.phase !== "idle") {
        clearIdleTimer();
        const idleGeneration = captureGeneration;
        idleTimer = setTimer(() => {
          idleTimer = null;
          if (
            idleGeneration !== captureGeneration ||
            get().voice.phase !== "idle"
          )
            return;
          transition({ type: "idle-timeout" });
          void deps.vox.teardown().catch(() => undefined);
        }, VOICE_IDLE_TEARDOWN_MS);
      }
    };

    const savePreferences = (preferences: VoicePreferences) => {
      set({ preferences });
      deps.savePreferences(preferences);
    };

    const reportError = (error: unknown) => {
      const message = friendlyError(messageFrom(error), isMac());
      if (get().voice.phase === "review") {
        transition({ type: "review-error", message });
      } else if (isDeviceError(message)) {
        transition({ type: "device-lost" });
      } else {
        transition({ type: "error", message });
      }
    };

    // Calls are issued before yielding, so a subsequent press cannot get a
    // teardown command from this failed generation after it has started.
    const cancelAndTeardownNative = () => {
      void deps.vox.cancel().catch(() => undefined);
      void deps.vox.teardown().catch(() => undefined);
    };

    const cancelCurrentCapture = async (generation: number) => {
      if (!isCurrentCapture(generation)) return;
      if (pendingReleaseGeneration === generation) pendingReleaseGeneration = null;
      captureGeneration++;
      clearErrorListener();
      transition({ type: "cancelled" });
      await deps.vox.cancel().catch(() => undefined);
    };

    const failCurrentCapture = (generation: number, error: unknown) => {
      if (!isCurrentCapture(generation)) return;
      if (pendingReleaseGeneration === generation) pendingReleaseGeneration = null;
      captureGeneration++;
      clearErrorListener();
      reportError(error);
      cancelAndTeardownNative();
    };

    const listenForCaptureErrors = (generation: number) => {
      const listenerId = ++errorListenerId;
      void deps.vox
        .onError((event) => {
          if (!isCurrentCapture(generation) || listenerId !== errorListenerId) return;
          if (get().voice.phase === "review") {
            reportError(event.message);
            cancelAndTeardownNative();
            return;
          }
          failCurrentCapture(generation, event.message);
        })
        .then((off) => {
          if (
            !isCurrentCapture(generation) ||
            listenerId !== errorListenerId
          ) {
            off();
            return;
          }
          offError = off;
        })
        .catch(() => {
          // Capture-scoped channels are a safety net. A failed subscription
          // must not stop a capture that has otherwise started successfully.
        });
    };

    const forgetUnavailableModel = (modelId: VoiceModelId) => {
      const preferences = get().preferences;
      if (preferences.installedModelIds.includes(modelId)) {
        savePreferences({
          ...preferences,
          installedModelIds: preferences.installedModelIds.filter((id) => id !== modelId),
        });
      }
      transition({ type: "model-missing" });
    };

    // Actually run a confirmed/auto-confirmed command against the injected app
    // actions. Re-checks entitlement at the moment of execution (defense in
    // depth) and always ends the capture at idle with a short notice.
    const executeCommand = async (generation: number, command: VoiceCommand) => {
      if (!isCurrentCapture(generation)) return;
      const commands = deps.commands;
      if (!commands || !hasFeature(FEATURES.voxCommands)) {
        transition({ type: "command-resolved" });
        clearErrorListener();
        return;
      }
      let notice: string | undefined;
      switch (command.kind) {
        case "new-session":
          commands.newSession();
          notice = "New terminal.";
          break;
        case "switch-terminal": {
          const ok = commands.switchTerminal(command.index);
          notice = ok ? `Terminal ${command.index}.` : `No terminal ${command.index}.`;
          break;
        }
        case "next-terminal":
          commands.nextTerminal();
          notice = "Next terminal.";
          break;
        case "prev-terminal":
          commands.prevTerminal();
          notice = "Previous terminal.";
          break;
        case "send":
          await Promise.resolve(commands.submit()).catch(() => undefined);
          notice = "Sent.";
          break;
        case "cancel":
        case "discard":
          break;
      }
      if (!isCurrentCapture(generation)) return;
      transition({ type: "command-resolved", notice });
      clearErrorListener();
    };

    // Route a recognized command through the confirm guard. Aborts run
    // immediately (they touch no app state); "send" always confirms and can
    // never auto-fire; other state-changing commands confirm by default and
    // only skip the prompt when the user has opted into commandAutoConfirm.
    const routeCommand = async (generation: number, command: VoiceCommand) => {
      if (!isCurrentCapture(generation)) return;
      if (isAbortCommand(command)) {
        transition({
          type: "command-resolved",
          notice: command.kind === "discard" ? "Discarded." : undefined,
        });
        clearErrorListener();
        return;
      }
      const submitting = isSubmittingCommand(command);
      const autoConfirm = get().preferences.commandAutoConfirm && !submitting;
      if (autoConfirm) {
        await executeCommand(generation, command);
        return;
      }
      transition({ type: "command-pending", command, label: commandLabel(command) });
    };

    const finishStop = async (
      generation: number,
      utteranceId: string,
      target: VoiceTarget,
    ) => {
      try {
        const result = await deps.vox.stop();
        if (!isCurrentCapture(generation)) return;
        const voice = get().voice;
        if (
          result.utteranceId !== utteranceId ||
          voice.phase !== "transcribing" ||
          voice.utteranceId !== utteranceId
        ) {
          await cancelCurrentCapture(generation);
          // cancelCurrentCapture only sends cancel. A mismatched result means
          // native state is untrustworthy, so release the engine as well.
          void deps.vox.teardown().catch(() => undefined);
          return;
        }

        const raw = result.text.trim();

        // M9f: a command-mode capture (Pro) parses the RAW transcript against
        // the closed grammar. A recognized command routes to the guarded
        // executor; anything else — including near-misses — falls straight
        // through to the dictation path below, so an unrecognized utterance is
        // never guessed into an action. Double-gated: captureMode is only ever
        // "command" when entitled, and we re-check the entitlement here.
        if (
          captureMode === "command" &&
          deps.commands &&
          hasFeature(FEATURES.voxCommands)
        ) {
          const parse = parseVoiceCommand(raw, {
            sessionCount: deps.commands.sessionCount(),
          });
          if (parse.type === "command") {
            await routeCommand(generation, parse.command);
            return;
          }
        }

        // Free tier: raw trimmed transcript (byte-identical to before). Pro:
        // run the deterministic cleanup pipeline with the capture's vocabulary
        // and provider preset. Cleanup can legitimately empty an all-filler
        // utterance, so re-check for empty afterwards.
        const text = hasFeature(FEATURES.voxCleanup)
          ? cleanTranscript(raw, {
              vocabulary: captureContext?.vocabulary,
              provider: captureContext?.provider,
            })
          : raw;
        if (!text) {
          transition({ type: "empty-transcript" });
          clearErrorListener();
          return;
        }

        const { preferences } = get();
        if (preferences.reviewBeforeInsert) {
          transition({
            type: "transcript-ready",
            text,
            reviewBeforeInsert: true,
          });
          return;
        }

        transition({ type: "insertion-started", text });
        try {
          await deps.insert(target, text);
          if (!isCurrentCapture(generation)) return;
          transition({ type: "inserted" });
          clearErrorListener();
        } catch (error) {
          if (!isCurrentCapture(generation)) return;
          clearErrorListener();
          reportError(new Error(`Couldn't insert voice text: ${messageFrom(error)}`));
        }
      } catch (error) {
        failCurrentCapture(generation, error);
      }
    };

    return {
      voice: initialVoiceState,
      preferences: initialPreferences,
      inputDevices: [],

      start() {
        // Error listeners are installed per capture below. A listener created
        // at app boot cannot distinguish an old vox://error from a new press.
      },

      async press(mode: VoiceMode = "dictation") {
        const current = get().voice;
        if (current.phase !== "idle" && current.phase !== "error") return;
        // Store-level command gating (M9f): command mode requires both the
        // entitlement and wired command actions. Without either, the press
        // silently becomes an ordinary dictation — free/non-opted behavior
        // stays unchanged and no command grammar ever runs.
        const commandMode =
          mode === "command" && !!deps.commands && hasFeature(FEATURES.voxCommands);
        captureMode = commandMode ? "command" : "dictation";
        const { preferences } = get();
        if (!preferences.installedModelIds.includes(preferences.modelId)) {
          transition({ type: "model-missing" });
          return;
        }
        // Defense-in-depth: a Pro model (turbo) can be selected in preferences
        // without a current entitlement — e.g. a lapsed Pro subscription that
        // downloaded turbo while active, or a stale/tampered preferences doc.
        // setModel() already blocks *selecting* an unentitled Pro model, but
        // press() must independently refuse to *use* one, or a free session
        // could keep transcribing with the paid model forever.
        if (isProModel(preferences.modelId) && !hasFeature(FEATURES.voxStreaming)) {
          transition({ type: "model-missing" });
          return;
        }
        const target = deps.resolveTarget();
        if (!target) {
          transition({ type: "target-missing" });
          return;
        }

        const modelId = preferences.modelId;
        const generation = ++captureGeneration;
        pendingReleaseGeneration = null;
        clearErrorListener();
        transition({ type: "capture-requested", at: now(), target, mode: captureMode });
        listenForCaptureErrors(generation);
        try {
          const modelPath = await deps.models.pathFor(modelId, preferences.modelsDir);
          if (!isCurrentCapture(generation)) return;
          await deps.vox.init({ modelPath, deviceName: preferences.inputDeviceId });
          if (!isCurrentCapture(generation)) return;

          // Resolve the Pro intelligence context once for this capture. Only
          // touched when cleanup or vocabulary is entitled — the free path
          // leaves captureContext null and passes no bias/streaming flags.
          const wantsVocabulary = hasFeature(FEATURES.voxVocabulary);
          const wantsCleanup = hasFeature(FEATURES.voxCleanup);
          captureContext =
            wantsVocabulary || wantsCleanup ? resolveContext() : null;
          const startArgs: VoxStartArgs = { language: null };
          if (wantsVocabulary && captureContext) {
            startArgs.initialPrompt = buildInitialPrompt(captureContext.vocabulary);
          }
          if (hasFeature(FEATURES.voxStreaming) && streamingCapable()) {
            startArgs.streaming = true;
          }

          let nativeCapturing = false;
          let utteranceId: string | null = null;
          utteranceId = await deps.vox.start(startArgs, (event) => {
            if (!isCurrentCapture(generation)) return;
            if (event.type === "level") {
              transition({ type: "level", rms: event.rms });
            } else if (event.type === "partial") {
              transition({ type: "partial", text: event.text });
            } else if (event.type === "state" && event.state === "capturing") {
              nativeCapturing = true;
              transition({ type: "capture-acknowledged", at: now() });
              if (utteranceId) transition({ type: "capture-started", utteranceId });
            } else if (event.type === "state" && event.state === "transcribing") {
              transition({ type: "transcribing" });
            } else if (event.type === "error") {
              failCurrentCapture(generation, event.message);
            }
          });
          if (!isCurrentCapture(generation)) return;
          if (nativeCapturing) {
            transition({ type: "capture-started", utteranceId });
          }
          if (pendingReleaseGeneration === generation) {
            pendingReleaseGeneration = null;
            const voice = get().voice;
            if (
              isCurrentCapture(generation) &&
              voice.phase === "capturing" &&
              voice.utteranceId
            ) {
              transition({ type: "released", at: now() });
              await finishStop(generation, voice.utteranceId, voice.target);
            }
          }
        } catch (error) {
          if (!isCurrentCapture(generation)) return;
          if (isUnavailableModelError(messageFrom(error))) {
            if (pendingReleaseGeneration === generation) pendingReleaseGeneration = null;
            captureGeneration++;
            forgetUnavailableModel(modelId);
            clearErrorListener();
            return;
          }
          failCurrentCapture(generation, error);
        }
      },

      async release() {
        const voice = get().voice;
        if (voice.phase !== "capturing") return;
        const generation = captureGeneration;
        if (voice.startedAt === null) {
          await cancelCurrentCapture(generation);
          return;
        }
        if (now() - voice.startedAt < MIN_CAPTURE_MS) {
          await cancelCurrentCapture(generation);
          return;
        }
        if (!voice.utteranceId) {
          pendingReleaseGeneration = generation;
          return;
        }
        transition({ type: "released", at: now() });
        await finishStop(generation, voice.utteranceId, voice.target);
      },

      async toggle() {
        if (get().voice.phase === "capturing") await get().release();
        else await get().press();
      },

      async pressCommand() {
        await get().press("command");
      },

      async confirmCommand() {
        const voice = get().voice;
        if (voice.phase !== "command") return;
        await executeCommand(captureGeneration, voice.command);
      },

      cancelCommand() {
        if (get().voice.phase !== "command") return;
        transition({ type: "command-resolved" });
        clearErrorListener();
      },

      async cancelCapture() {
        const phase = get().voice.phase;
        // A pending command confirm (M9f) must not survive the app losing
        // focus/visibility — the dispatcher fires this same abandonment path
        // on window blur and tab-hidden. Without this, a "send" awaiting
        // confirm would linger indefinitely, and the confirm popover's global
        // Enter listener would fire it on the next unrelated Enter keypress
        // anywhere in the app once focus returns.
        if (phase === "command") {
          transition({ type: "command-resolved" });
          clearErrorListener();
          return;
        }
        if (phase !== "capturing" && phase !== "transcribing") return;
        await cancelCurrentCapture(captureGeneration);
      },

      async downloadSelectedModel() {
        await get().downloadModel(get().preferences.modelId);
      },

      async downloadModel(modelId: VoiceModelId) {
        const phase = get().voice.phase;
        if (phase !== "no-model" && phase !== "idle" && phase !== "error") return;
        // Turbo is Pro-gated: block the download itself (not just selection),
        // so a free session can't fetch the ~1.6 GB paid model via a direct
        // store dispatch that bypasses the UI's entitlement filtering.
        if (isProModel(modelId) && !hasFeature(FEATURES.voxStreaming)) return;
        transition({ type: "download-started" });
        try {
          await deps.models.download(
            modelId,
            (progress) => transition({ type: "download-progress", ...progress }),
            get().preferences.modelsDir,
          );
          const preferences = get().preferences;
          savePreferences({
            ...preferences,
            installedModelIds: [...new Set([...preferences.installedModelIds, modelId])],
          });
          transition({ type: "downloaded" });
        } catch (error) {
          if (error instanceof ModelChecksumError) {
            transition({
              type: "error",
              message: error.cleanupError
                ? "The download could not be verified, and the corrupt file could not be removed."
                : "The download could not be verified. Please download it again.",
            });
          } else {
            reportError(error);
          }
        }
      },

      async deleteModel(modelId: VoiceModelId) {
        const preferences = get().preferences;
        if (!preferences.installedModelIds.includes(modelId)) return;
        const phase = get().voice.phase;
        if (
          phase === "capturing" ||
          phase === "transcribing" ||
          phase === "inserting" ||
          phase === "downloading"
        )
          return;

        let deletionError: unknown = null;
        if (preferences.modelId === modelId) {
          try {
            await deps.vox.teardown();
          } catch (error) {
            deletionError = error;
          }
        }
        try {
          await deps.models.delete(modelId, preferences.modelsDir);
        } catch (error) {
          deletionError ??= error;
        } finally {
          // A missing file is exactly when metadata needs to be forgotten.
          const current = get().preferences;
          if (current.installedModelIds.includes(modelId)) {
            savePreferences({
              ...current,
              installedModelIds: current.installedModelIds.filter((id) => id !== modelId),
            });
          }
        }
        if (deletionError !== null) {
          reportError(
            new Error(`Couldn't delete voice model: ${messageFrom(deletionError)}`),
          );
        }
      },

      setModel(modelId: VoiceModelId) {
        const preferences = get().preferences;
        const phase = get().voice.phase;
        if (
          phase === "capturing" ||
          phase === "transcribing" ||
          phase === "inserting" ||
          phase === "downloading"
        )
          return;
        // Pro models (turbo) are only selectable with `vox.streaming` — keep a
        // free session from ever landing on one, even via a stale preference.
        if (isProModel(modelId) && !hasFeature(FEATURES.voxStreaming)) return;
        if (preferences.modelId === modelId) return;
        savePreferences({ ...preferences, modelId });
      },

      setReviewBeforeInsert(reviewBeforeInsert: boolean) {
        const preferences = get().preferences;
        if (
          preferences.reviewBeforeInsert === reviewBeforeInsert &&
          preferences.reviewBeforeInsertConfigured
        )
          return;
        savePreferences({
          ...preferences,
          reviewBeforeInsert,
          reviewBeforeInsertConfigured: true,
        });
      },

      setCommandAutoConfirm(commandAutoConfirm: boolean) {
        const preferences = get().preferences;
        if (preferences.commandAutoConfirm === commandAutoConfirm) return;
        savePreferences({ ...preferences, commandAutoConfirm });
      },

      setPushToTalkCombo(pushToTalkCombo: string | null) {
        const preferences = get().preferences;
        if (preferences.pushToTalkCombo === pushToTalkCombo) return;
        savePreferences({ ...preferences, pushToTalkCombo });
      },

      setPushToTalkCommandCombo(pushToTalkCommandCombo: string | null) {
        const preferences = get().preferences;
        if (preferences.pushToTalkCommandCombo === pushToTalkCommandCombo) return;
        savePreferences({ ...preferences, pushToTalkCommandCombo });
      },

      async refreshInputDevices() {
        try {
          const inputDevices = await deps.vox.listInputDevices();
          set({ inputDevices });
        } catch {
          // Enumeration failing (unsupported platform, no permission yet)
          // leaves the picker empty; the host default still works.
        }
      },

      setInputDevice(deviceId: string | null) {
        const preferences = get().preferences;
        const phase = get().voice.phase;
        if (
          phase === "capturing" ||
          phase === "transcribing" ||
          phase === "inserting" ||
          phase === "downloading"
        )
          return;
        if (preferences.inputDeviceId === deviceId) return;
        savePreferences({ ...preferences, inputDeviceId: deviceId });
      },

      setModelsDir(modelsDir: string | null) {
        const preferences = get().preferences;
        const phase = get().voice.phase;
        if (
          phase === "capturing" ||
          phase === "transcribing" ||
          phase === "inserting" ||
          phase === "downloading"
        )
          return;
        if (preferences.modelsDir === modelsDir) return;
        // Downloaded models live at the old location; moving them isn't
        // automatic, so treat them as no-longer-installed rather than have
        // the app believe a model is present where it no longer is.
        savePreferences({ ...preferences, modelsDir, installedModelIds: [] });
      },

      async openPrivacySettings() {
        await deps.openMicrophonePrivacySettings().catch(() => undefined);
      },

      async insertReview() {
        const voice = get().voice;
        if (voice.phase !== "review") return;
        const generation = captureGeneration;
        transition({ type: "insertion-started", text: voice.text });
        try {
          await deps.insert(voice.target, voice.text);
          if (!isCurrentCapture(generation)) return;
          transition({ type: "inserted" });
          clearErrorListener();
        } catch (error) {
          if (!isCurrentCapture(generation)) return;
          clearErrorListener();
          reportError(new Error(`Couldn't insert voice text: ${messageFrom(error)}`));
        }
      },

      discardReview() {
        if (get().voice.phase === "review") {
          transition({ type: "discarded" });
          clearErrorListener();
        }
      },

      dismiss() {
        transition({ type: "dismissed" });
        clearErrorListener();
      },

      async dispose() {
        disposed = true;
        pendingReleaseGeneration = null;
        captureGeneration++;
        clearIdleTimer();
        clearErrorListener();
        await deps.vox.teardown().catch(() => undefined);
      },
    };
  });
}
