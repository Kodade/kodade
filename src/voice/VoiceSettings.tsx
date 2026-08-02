import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { platform } from "../ipc/transport";
import { canPickFolder, capabilitiesStore } from "../platform/capabilities";
import {
  MODEL_BY_ID,
  STREAMING_MIN_CORES,
  VOICE_MODELS,
  suggestsSmallEnUpgrade,
} from "./models";
import type { VoiceStoreState } from "./store";
import { appStore } from "../store/appStore";
import { FEATURES, licenseStore } from "../license";
import { COMMAND_REFERENCE } from "./commands/grammar";
import {
  BINDINGS,
  comboFor,
  detectMacPlatform,
  setShortcutCaptureActive,
  labelFor,
  type ActionId,
} from "../shortcuts/bindings";
import { canonicalKeyForCode, comboSignature, parseCombo } from "../shortcuts/match";

// navigator.hardwareConcurrency is available identically in WKWebView (macOS)
// and WebView2 (Windows) — the one cross-platform capability signal Tauri's
// two webview engines share. Read once per render; cores never change at runtime.
function hardwareCores(): number {
  return typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
    ? navigator.hardwareConcurrency
    : 0;
}

function truncatedSha(sha256: string): string {
  return `${sha256.slice(0, 12)}…`;
}

// Stable empty reference so the vocabulary selector doesn't churn re-renders.
const NO_TERMS: readonly string[] = [];

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);

function comboFromKeydown(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const modifiers: string[] = [];
  const isMac = detectMacPlatform();
  if (isMac ? event.metaKey : event.ctrlKey) modifiers.push("Mod");
  if (event.altKey) modifiers.push("Alt");
  if (isMac && event.ctrlKey) modifiers.push("Ctrl");
  if (event.shiftKey) modifiers.push("Shift");
  const key = event.shiftKey ? canonicalKeyForCode(event.code) ?? event.key : event.key;
  return [...modifiers, key].join("-");
}

export function VoiceSettings({ store }: { store: StoreApi<VoiceStoreState> }) {
  const preferences = useStore(store, (state) => state.preferences);
  const voice = useStore(store, (state) => state.voice);
  const inputDevices = useStore(store, (state) => state.inputDevices);
  const pickFolderCapable = useStore(capabilitiesStore, (state) => canPickFolder(state.capabilities));
  // KödWhisper Pro gates (M9e). Reads the real offline license store so the
  // panel shows Pro controls exactly when they're unlocked; free stays lean.
  const cleanupPro = useStore(licenseStore, (s) => s.hasFeature(FEATURES.voxCleanup));
  const vocabularyPro = useStore(licenseStore, (s) => s.hasFeature(FEATURES.voxVocabulary));
  const streamingPro = useStore(licenseStore, (s) => s.hasFeature(FEATURES.voxStreaming));
  const commandsPro = useStore(licenseStore, (s) => s.hasFeature(FEATURES.voxCommands));
  const commandShortcut = labelFor("push-to-talk-command");
  // Turbo (a Pro model) is only offered when streaming/large models are unlocked.
  const models = VOICE_MODELS.filter((model) => !model.pro || streamingPro);
  // Per-project vocabulary (Pro): terms live on the projects doc keyed by path.
  const activeProject = useStore(
    appStore,
    (s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null,
  );
  const vocabTerms = useStore(appStore, (s) =>
    activeProject ? (s.voiceVocabulary[activeProject.path] ?? NO_TERMS) : NO_TERMS,
  );
  const [vocabDraft, setVocabDraft] = useState("");
  const [recordingShortcut, setRecordingShortcut] = useState<ActionId | null>(null);
  const [shortcutMessage, setShortcutMessage] = useState("");
  const streamingCapable = hardwareCores() >= STREAMING_MIN_CORES;
  const busy =
    voice.phase === "capturing" ||
    voice.phase === "transcribing" ||
    voice.phase === "inserting" ||
    voice.phase === "downloading";

  useEffect(() => {
    void store.getState().refreshInputDevices();
  }, [store]);

  const upgradeSuggested = suggestsSmallEnUpgrade(
    hardwareCores(),
    preferences.modelId,
    preferences.installedModelIds,
  );

  function addVocabTerm() {
    const term = vocabDraft.trim();
    if (!term || !activeProject) return;
    appStore
      .getState()
      .setVoiceVocabularyTerms(activeProject.path, [...vocabTerms, term]);
    setVocabDraft("");
  }

  function removeVocabTerm(term: string) {
    if (!activeProject) return;
    appStore
      .getState()
      .setVoiceVocabularyTerms(
        activeProject.path,
        vocabTerms.filter((t) => t !== term),
      );
  }

  useEffect(() => {
    if (!recordingShortcut) return;
    setShortcutCaptureActive(true);
    const onKeydown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingShortcut(null);
        setShortcutMessage("");
        return;
      }

      const combo = comboFromKeydown(event);
      if (!combo) {
        setShortcutMessage("Use Command/Ctrl plus a non-modifier key.");
        return;
      }
      const parsed = parseCombo(combo);
      if (!parsed.mod) {
        setShortcutMessage("Shortcuts must include Command/Ctrl.");
        return;
      }
      if (!parsed.valid || !parsed.key) {
        setShortcutMessage("Choose a non-modifier key.");
        return;
      }
      const signature = comboSignature(combo);
      const collision = BINDINGS.some(
        (binding) =>
          binding.id !== recordingShortcut &&
          comboSignature(comboFor(binding.id)) === signature,
      );
      if (collision) {
        setShortcutMessage("That shortcut is already in use.");
        return;
      }

      if (recordingShortcut === "push-to-talk") {
        store.getState().setPushToTalkCombo(combo);
      } else {
        store.getState().setPushToTalkCommandCombo(combo);
      }
      setRecordingShortcut(null);
      setShortcutMessage("");
    };
    window.addEventListener("keydown", onKeydown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeydown, { capture: true });
      setShortcutCaptureActive(false);
    };
  }, [recordingShortcut, store]);

  function startRecording(id: ActionId) {
    setRecordingShortcut(id);
    setShortcutMessage("");
  }

  function resetShortcut(id: ActionId) {
    if (id === "push-to-talk") store.getState().setPushToTalkCombo(null);
    else store.getState().setPushToTalkCommandCombo(null);
    setShortcutMessage("");
  }

  function shortcutRow(id: ActionId, name: string, hasOverride: boolean) {
    const recording = recordingShortcut === id;
    return (
      <div key={id} className="flex items-center gap-2 text-[10px]">
        <span className="min-w-0 flex-1 text-text-dim">{name}</span>
        <kbd className="rounded border border-border bg-bg px-1.5 py-0.5 text-text">
          {recording ? "press shortcut…" : labelFor(id)}
        </kbd>
        <button
          type="button"
          onClick={() => startRecording(id)}
          className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-hover"
        >
          change…
        </button>
        {hasOverride && (
          <button
            type="button"
            onClick={() => resetShortcut(id)}
            className="rounded px-1.5 py-0.5 text-text-dim hover:bg-surface-hover hover:text-text"
          >
            reset
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="mt-4 border-t border-border pt-3" aria-labelledby="voice-heading">
      <h2 id="voice-heading" className="font-semibold tracking-[0.12em] text-text">
        voice input
      </h2>
      <section className="mt-2 rounded border border-border p-2" aria-labelledby="voice-shortcuts-heading">
        <h3 id="voice-shortcuts-heading" className="text-[11px] font-semibold text-text">
          shortcuts
        </h3>
        <div className="mt-1.5 space-y-1">
          {shortcutRow("push-to-talk", "Hold to talk", preferences.pushToTalkCombo !== null)}
          {commandsPro &&
            shortcutRow(
              "push-to-talk-command",
              "Hold to talk — command mode",
              preferences.pushToTalkCommandCombo !== null,
            )}
        </div>
        <p className="mt-1.5 text-[10px] text-text-dim">
          Hold the key to dictate into the active terminal, or click the mic button.
        </p>
        {shortcutMessage && <p role="status" className="mt-1 text-[10px] text-text-dim">{shortcutMessage}</p>}
      </section>
      <div className="mt-2 space-y-1.5">
        {models.map((model) => {
          const installed = preferences.installedModelIds.includes(model.id);
          const downloading = voice.phase === "downloading" && preferences.modelId === model.id;
          return (
            <div key={model.id} className="rounded border border-border px-2 py-1.5">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="voice-model"
                  checked={preferences.modelId === model.id}
                  onChange={() => store.getState().setModel(model.id)}
                  disabled={busy}
                  className="mt-0.5 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-text">{model.label}</span>
                  <span className="block text-[10px] text-text-dim">{model.description}</span>
                </span>
              </label>
              <div className="mt-1 flex justify-end">
                {installed ? (
                  <button
                    type="button"
                    onClick={() => void store.getState().deleteModel(model.id)}
                    disabled={busy}
                    className="rounded px-1.5 py-0.5 text-[10px] text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
                  >
                    delete
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void store.getState().downloadModel(model.id)}
                    disabled={busy}
                    className="rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-surface-hover disabled:opacity-50"
                  >
                    {downloading ? "downloading…" : "download"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {upgradeSuggested && (
        <p className="mt-1.5 rounded border border-border bg-bg px-2 py-1.5 text-[10px] text-text-dim">
          Your machine looks fast enough for {MODEL_BY_ID["small.en"].label.toLowerCase()} voice
          input.{" "}
          <button
            type="button"
            onClick={() => void store.getState().downloadModel("small.en")}
            disabled={busy}
            className="text-accent hover:underline disabled:opacity-50"
          >
            Try it
          </button>
        </p>
      )}

      <label className="mt-2 flex items-center gap-2 text-text-dim">
        <input
          type="checkbox"
          checked={preferences.reviewBeforeInsert}
          onChange={(event) => store.getState().setReviewBeforeInsert(event.target.checked)}
          className="accent-accent"
        />
        Review before inserting
      </label>

      {(cleanupPro || streamingPro || vocabularyPro || commandsPro) && (
        <section className="mt-3 rounded border border-border p-2" aria-labelledby="vox-pro-heading">
          <h3 id="vox-pro-heading" className="text-[11px] font-semibold text-text">
            KödWhisper Pro
          </h3>

          {cleanupPro && (
            <p className="mt-1 text-[10px] text-text-dim">
              Prompt cleanup is on — fillers, spoken symbols, and slash commands
              are tidied for the focused agent before you review.
            </p>
          )}

          {streamingPro && (
            <p className="mt-1 text-[10px] text-text-dim">
              Streaming partials:{" "}
              {streamingCapable
                ? "on — live text appears while you speak."
                : `off — needs ${STREAMING_MIN_CORES}+ CPU cores.`}
            </p>
          )}

          {vocabularyPro && (
            <div className="mt-2">
              <span className="block text-[10px] font-semibold text-text">
                Project vocabulary
              </span>
              {activeProject ? (
                <>
                  <p className="mt-0.5 text-[10px] text-text-dim">
                    Custom terms for <span className="text-text">{activeProject.name}</span>,
                    biased into recognition and used to repair identifiers.
                  </p>
                  <div className="mt-1 flex gap-1">
                    <input
                      type="text"
                      value={vocabDraft}
                      onChange={(event) => setVocabDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addVocabTerm();
                        }
                      }}
                      placeholder="e.g. appStore, KödWhisper"
                      className="min-w-0 flex-1 rounded border border-border bg-bg px-1.5 py-1 text-[11px] text-text"
                    />
                    <button
                      type="button"
                      onClick={addVocabTerm}
                      disabled={!vocabDraft.trim()}
                      className="rounded bg-accent px-2 py-0.5 text-[10px] text-accent-text hover:opacity-90 disabled:opacity-50"
                    >
                      add
                    </button>
                  </div>
                  {vocabTerms.length > 0 && (
                    <ul className="mt-1.5 flex flex-wrap gap-1">
                      {vocabTerms.map((term) => (
                        <li
                          key={term}
                          className="flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] text-text"
                        >
                          {term}
                          <button
                            type="button"
                            onClick={() => removeVocabTerm(term)}
                            aria-label={`Remove ${term}`}
                            className="text-text-dim hover:text-text"
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="mt-0.5 text-[10px] text-text-dim">
                  Open a project to add custom terms.
                </p>
              )}
            </div>
          )}

          {commandsPro && (
            <div className="mt-2">
              <span className="block text-[10px] font-semibold text-text">
                Voice commands
              </span>
              <p className="mt-0.5 text-[10px] text-text-dim">
                Hold <span className="text-text">{commandShortcut}</span> and speak a
                command instead of dictating. Every command is confirmed before it
                runs; unrecognized speech is dictated as usual.
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {COMMAND_REFERENCE.map((row) => (
                  <li key={row.example} className="flex gap-2 text-[10px] text-text-dim">
                    <span className="min-w-[84px] rounded bg-bg px-1 py-0.5 text-text">
                      “{row.example}”
                    </span>
                    <span className="flex-1">{row.effect}</span>
                  </li>
                ))}
              </ul>
              <label className="mt-2 flex items-center gap-2 text-[10px] text-text-dim">
                <input
                  type="checkbox"
                  checked={preferences.commandAutoConfirm}
                  onChange={(event) =>
                    store.getState().setCommandAutoConfirm(event.target.checked)
                  }
                  className="accent-accent"
                />
                Skip confirmation for safe commands (“send” is always confirmed)
              </label>
            </div>
          )}
        </section>
      )}

      <details className="mt-2 rounded border border-border">
        <summary className="cursor-pointer select-none px-2 py-1 text-text-dim hover:text-text">
          advanced
        </summary>
        <div className="space-y-2.5 border-t border-border px-2 py-2">
          <div className="space-y-1.5">
            {models.map((model) => (
              <div key={model.id} className="text-[10px] text-text-dim">
                <span className="font-semibold text-text">{model.label}</span>
                <ul className="mt-0.5 list-none space-y-0.5">
                  <li>Speed: {model.speed}</li>
                  <li>Accuracy: {model.accuracy}</li>
                  <li>RAM: {model.ramGuidance}</li>
                  <li>Language: {model.language}</li>
                  <li title={model.sha256}>Checksum: {truncatedSha(model.sha256)}</li>
                </ul>
              </div>
            ))}
          </div>

          <div>
            <span className="block text-[10px] font-semibold text-text">Microphone</span>
            <select
              value={preferences.inputDeviceId ?? ""}
              onChange={(event) =>
                store.getState().setInputDevice(event.target.value || null)
              }
              disabled={busy}
              className="mt-1 w-full rounded border border-border bg-bg px-1.5 py-1 text-[11px] text-text disabled:opacity-50"
            >
              <option value="">System default</option>
              {inputDevices.map((device) => (
                <option key={device} value={device}>
                  {device}
                </option>
              ))}
            </select>
          </div>

          {pickFolderCapable && (
            <div>
              <span className="block text-[10px] font-semibold text-text">Model storage location</span>
              <p className="mt-0.5 truncate text-[10px] text-text-dim" title={preferences.modelsDir ?? undefined}>
                {preferences.modelsDir ?? "Default (app data folder)"}
              </p>
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  onClick={() => void changeModelsDir(store)}
                  disabled={busy}
                  className="rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-surface-hover disabled:opacity-50"
                >
                  change…
                </button>
                {preferences.modelsDir && (
                  <button
                    type="button"
                    onClick={() => store.getState().setModelsDir(null)}
                    disabled={busy}
                    className="rounded px-1.5 py-0.5 text-[10px] text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
                  >
                    reset to default
                  </button>
                )}
              </div>
              {preferences.modelsDir !== null && preferences.installedModelIds.length === 0 && (
                <p className="mt-1 text-[10px] text-text-dim">
                  Changing location doesn't move existing models — download again at the new
                  location.
                </p>
              )}
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

async function changeModelsDir(store: StoreApi<VoiceStoreState>) {
  const destination = await platform.pickFolder();
  if (destination) store.getState().setModelsDir(destination);
}
