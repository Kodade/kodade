import { useEffect, useRef, type CSSProperties } from "react";
import { useStore } from "zustand";
import { MODEL_BY_ID } from "./models";
import type { VoiceStoreState } from "./store";
import type { StoreApi } from "zustand/vanilla";
import { comboFor, labelForCombo } from "../shortcuts/bindings";
import { isTextInsertionTarget } from "./insertion";

// A stale pending voice command must not sit armed forever (M9f hardening
// follow-up) — auto-dismiss (cancel, never confirm) if nobody responds.
const COMMAND_CONFIRM_TIMEOUT_MS = 15_000;

// M9f hardening follow-up: a global window Enter listener previously
// confirmed/inserted regardless of what had focus — any Enter press anywhere
// in the app (an unrelated dialog, an input, a PTY pane) silently ran a
// state-changing voice action while the popover happened to be open. Enter
// now only counts as confirm when the popover itself (or a child of it, e.g.
// its autofocused button) holds focus, or when the key's target isn't an
// element Enter is already spoken for (a text input, textarea/xterm helper
// textarea, or contenteditable).
function isSafeConfirmKey(dialogEl: HTMLElement | null, event: KeyboardEvent): boolean {
  const target = event.target;
  if (dialogEl && target instanceof Node && dialogEl.contains(target)) return true;
  return !isTextInsertionTarget(target instanceof Element ? target : null);
}

export function VoiceControls({
  store,
  disabled,
}: {
  store: StoreApi<VoiceStoreState>;
  disabled: boolean;
}) {
  const voice = useStore(store, (state) => state.voice);
  const pushToTalkCombo = useStore(store, (state) => state.preferences.pushToTalkCombo);
  const shortcut = labelForCombo(pushToTalkCombo ?? comboFor("push-to-talk"));
  const active = voice.phase === "capturing";

  useEffect(() => {
    if (voice.phase !== "capturing" && voice.phase !== "transcribing") return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      void store.getState().cancelCapture();
    };
    window.addEventListener("keydown", onKeydown, { capture: true });
    return () => window.removeEventListener("keydown", onKeydown, { capture: true });
  }, [store, voice.phase]);

  return (
    <>
      <div className="absolute right-3 bottom-3 z-20 flex items-end gap-2">
        {voice.phase === "idle" && voice.notice && <Notice>{voice.notice}</Notice>}
        {/* Mode indicator (M9f): make command captures unmistakable — a command
            capture dictates nothing; it runs a guarded action on release. */}
        {(voice.phase === "capturing" || voice.phase === "transcribing") &&
          voice.mode === "command" && (
            <span
              role="status"
              className="rounded-md border border-accent bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-accent shadow-md"
            >
              Command
            </span>
          )}
        {voice.phase === "capturing" && voice.partial && (
          <p
            role="status"
            className="max-w-xs rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-dim shadow-md"
          >
            {voice.partial}
          </p>
        )}
        {(voice.phase === "no-model" || voice.phase === "downloading" || voice.phase === "error") && (
          <VoicePrompt store={store} />
        )}
        <button
          type="button"
          data-voice-terminal-control
          // WKWebView clicks can blur xterm even though buttons do not become
          // document.activeElement, so preserve the terminal/text target.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void store.getState().toggle()}
          disabled={
            disabled ||
            voice.phase === "downloading" ||
            voice.phase === "transcribing" ||
            voice.phase === "inserting" ||
            voice.phase === "command"
          }
          aria-label={active ? "Stop voice capture" : "Start voice capture"}
          aria-pressed={active}
          title={active ? "Stop voice capture" : `Hold to talk (${shortcut})`}
          className={`relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-border bg-surface text-text shadow-md hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 ${
            active ? "border-accent text-accent" : ""
          }`}
        >
          {active && (
            <span
              aria-hidden="true"
              className="kd-voice-level absolute inset-y-0 left-0 bg-accent opacity-20"
              style={{ width: `${Math.max(8, voice.level * 100)}%` }}
            />
          )}
          <MicIcon />
        </button>
      </div>
      {voice.phase === "review" && <ReviewPopover store={store} />}
      {voice.phase === "command" && <CommandConfirmPopover store={store} />}
    </>
  );
}

// The confirm guard (M9f): a recognized voice command never runs until the user
// confirms it here. Enter confirms, Escape cancels — the same keys as review.
// Hardened (M9f follow-up): Enter is scoped to focus (see isSafeConfirmKey),
// an outside click dismisses instead of doing nothing, and a stale pending
// command auto-cancels after COMMAND_CONFIRM_TIMEOUT_MS.
function CommandConfirmPopover({ store }: { store: StoreApi<VoiceStoreState> }) {
  const voice = useStore(store, (state) => state.voice);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (voice.phase !== "command") return;
    confirmButtonRef.current?.focus();
  }, [voice.phase]);

  useEffect(() => {
    if (voice.phase !== "command") return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        if (!isSafeConfirmKey(dialogRef.current, event)) return;
        event.preventDefault();
        event.stopPropagation();
        void store.getState().confirmCommand();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        store.getState().cancelCommand();
      }
    };
    window.addEventListener("keydown", onKeydown, { capture: true });
    return () => window.removeEventListener("keydown", onKeydown, { capture: true });
  }, [store, voice.phase]);

  // Click (or tap) outside dismisses — same as cancel, never confirm.
  useEffect(() => {
    if (voice.phase !== "command") return;
    const onPointerDown = (event: PointerEvent) => {
      if (dialogRef.current?.contains(event.target as Node)) return;
      store.getState().cancelCommand();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [store, voice.phase]);

  // A pending confirm that nobody answers must not sit armed indefinitely.
  useEffect(() => {
    if (voice.phase !== "command") return;
    const timer = window.setTimeout(() => {
      store.getState().cancelCommand();
    }, COMMAND_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [store, voice.phase]);

  if (voice.phase !== "command") return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Confirm voice command"
      className="absolute right-3 bottom-14 z-30 w-72 rounded-md border border-border bg-surface p-3 text-xs shadow-lg"
    >
      <p className="text-text-dim">Run command</p>
      <p className="mt-0.5 text-sm font-semibold text-text">{voice.label}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => store.getState().cancelCommand()}
          className="rounded px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
        >
          Cancel
        </button>
        <button
          ref={confirmButtonRef}
          type="button"
          onClick={() => void store.getState().confirmCommand()}
          className="rounded bg-accent px-2 py-1 text-accent-text hover:opacity-90"
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

function VoicePrompt({ store }: { store: StoreApi<VoiceStoreState> }) {
  const voice = useStore(store, (state) => state.voice);
  const selected = useStore(store, (state) => state.preferences.modelId);

  if (voice.phase === "no-model") {
    const size = selected === "base.en" ? "142 MB" : "466 MB";
    return (
      <div className="w-64 rounded-md border border-border bg-surface p-3 text-xs shadow-lg">
        <p className="text-text">Download the voice model ({size})?</p>
        <button
          type="button"
          onClick={() => void store.getState().downloadSelectedModel()}
          className="mt-2 rounded bg-accent px-2 py-1 text-xs text-accent-text hover:opacity-90"
        >
          Download
        </button>
      </div>
    );
  }

  if (voice.phase === "downloading") {
    const percent = voice.total ? Math.round((voice.downloaded / voice.total) * 100) : null;
    return (
      <div className="w-64 rounded-md border border-border bg-surface p-3 text-xs shadow-lg">
        <p className="text-text">Downloading {MODEL_BY_ID[selected].label.toLowerCase()} voice model…</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-bg">
          <div className="h-full bg-accent" style={{ width: `${percent ?? 0}%` }} />
        </div>
        <p className="mt-1 text-text-dim">{percent === null ? "Preparing…" : `${percent}%`}</p>
      </div>
    );
  }

  if (voice.phase === "error") {
    // friendlyError() in store.ts renders this exact phrase for a denied
    // microphone permission on both macOS and Windows.
    const isPermissionDenied = /microphone access/i.test(voice.message);
    return (
      <div role="alert" className="w-72 rounded-md border border-border bg-surface p-3 text-xs shadow-lg">
        <p className="text-text">{voice.message}</p>
        {/download|verify/i.test(voice.message) && (
          <button
            type="button"
            onClick={() => void store.getState().downloadSelectedModel()}
            className="mt-2 rounded bg-accent px-2 py-1 text-xs text-accent-text hover:opacity-90"
          >
            Download again
          </button>
        )}
        {isPermissionDenied && (
          <button
            type="button"
            onClick={() => void store.getState().openPrivacySettings()}
            className="mt-2 rounded bg-accent px-2 py-1 text-xs text-accent-text hover:opacity-90"
          >
            Open privacy settings
          </button>
        )}
      </div>
    );
  }

  return null;
}

// Hardened (M9f follow-up): same Enter-scoping and click-outside-dismiss
// discipline as CommandConfirmPopover — see isSafeConfirmKey.
function ReviewPopover({ store }: { store: StoreApi<VoiceStoreState> }) {
  const voice = useStore(store, (state) => state.voice);
  const dialogRef = useRef<HTMLDivElement>(null);
  const insertButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (voice.phase !== "review") return;
    insertButtonRef.current?.focus();
  }, [voice.phase]);

  useEffect(() => {
    if (voice.phase !== "review") return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        if (!isSafeConfirmKey(dialogRef.current, event)) return;
        event.preventDefault();
        event.stopPropagation();
        void store.getState().insertReview();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        store.getState().discardReview();
      }
    };
    window.addEventListener("keydown", onKeydown, { capture: true });
    return () => window.removeEventListener("keydown", onKeydown, { capture: true });
  }, [store, voice.phase]);

  // Click (or tap) outside dismisses — discards the transcript, never inserts.
  useEffect(() => {
    if (voice.phase !== "review") return;
    const onPointerDown = (event: PointerEvent) => {
      if (dialogRef.current?.contains(event.target as Node)) return;
      store.getState().discardReview();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [store, voice.phase]);

  if (voice.phase !== "review") return null;
  const rect = voice.target.anchor;
  const style: CSSProperties | undefined = rect
    ? {
        position: "fixed",
        top: Math.max(12, rect.top + 12),
        left: Math.max(12, rect.right - 300),
      }
    : undefined;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Review voice transcript"
      style={style}
      className="absolute right-3 bottom-14 z-30 w-72 rounded-md border border-border bg-surface p-3 text-xs shadow-lg"
    >
      <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-text">{voice.text}</p>
      {voice.error && <p role="alert" className="mt-2 text-text-dim">{voice.error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => store.getState().discardReview()}
          className="rounded px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
        >
          Discard
        </button>
        <button
          ref={insertButtonRef}
          type="button"
          onClick={() => void store.getState().insertReview()}
          className="rounded bg-accent px-2 py-1 text-accent-text hover:opacity-90"
        >
          Insert
        </button>
      </div>
    </div>
  );
}

function Notice({ children }: { children: string }) {
  return (
    <p role="status" className="rounded bg-surface px-2 py-1 text-xs text-text-dim shadow-sm">
      {children}
    </p>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 16 16" className="relative h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="5.25" y="1.75" width="5.5" height="8" rx="2.75" />
      <path d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2M5.5 14.25h5" />
    </svg>
  );
}
