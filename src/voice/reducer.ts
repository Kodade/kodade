// The voice state machine is deliberately side-effect free. Capture commands,
// timers, and DOM/PTY insertion live in the store that drives this reducer.

import type { VoiceCommand } from "./commands/grammar";

export const MIN_CAPTURE_MS = 300;

// Which intent a capture carries (M9f). "dictation" is the default free/Pro
// path (transcript → terminal). "command" is the Pro voice-command path where
// the transcript is parsed against the closed grammar; it is only ever set when
// vox.commands is entitled (the store downgrades to dictation otherwise), so the
// mode itself is a visible, honest signal of what a release will do.
export type VoiceMode = "dictation" | "command";

export type VoiceTarget =
  | {
      kind: "terminal";
      sessionId: string;
      anchor?: DOMRect;
    }
  | {
      kind: "text-input";
      element: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
      anchor?: DOMRect;
    };

export type VoiceState =
  | { phase: "idle"; level: number; notice?: string }
  | { phase: "no-model"; level: number }
  | { phase: "downloading"; level: number; downloaded: number; total: number | null }
  | {
      phase: "capturing";
      level: number;
      // The local key press is not a recording acknowledgement. This remains
      // null until the native channel says the microphone is capturing.
      startedAt: number | null;
      target: VoiceTarget;
      utteranceId?: string;
      // Live streaming hypothesis (KödWhisper Pro). Present only when a capture
      // ran with streaming enabled; the stabilized prefix shown in the indicator.
      partial?: string;
      // Dictation vs command intent (M9f) — drives the mode indicator.
      mode: VoiceMode;
    }
  | {
      phase: "transcribing";
      level: number;
      target: VoiceTarget;
      utteranceId: string;
      mode: VoiceMode;
    }
  | {
      // A recognized voice command awaiting the confirm guard (M9f). The store
      // executes only on an explicit confirm; cancel returns to idle.
      phase: "command";
      level: number;
      command: VoiceCommand;
      label: string;
    }
  | {
      phase: "review";
      level: number;
      text: string;
      target: VoiceTarget;
      error?: string;
    }
  | { phase: "inserting"; level: number; text: string; target: VoiceTarget }
  | { phase: "error"; level: number; message: string };

export type VoiceEvent =
  | { type: "capture-requested"; at: number; target: VoiceTarget; mode?: VoiceMode }
  | { type: "capture-acknowledged"; at: number }
  | { type: "capture-started"; utteranceId: string }
  | { type: "released"; at: number }
  | { type: "level"; rms: number }
  | { type: "partial"; text: string }
  | { type: "transcribing" }
  | { type: "command-pending"; command: VoiceCommand; label: string }
  | { type: "command-resolved"; notice?: string }
  | { type: "transcript-ready"; text: string; reviewBeforeInsert: boolean }
  | { type: "insertion-started"; text: string }
  | { type: "empty-transcript" }
  | { type: "model-missing" }
  | { type: "target-missing" }
  | { type: "download-started" }
  | { type: "download-progress"; downloaded: number; total: number | null }
  | { type: "downloaded" }
  | { type: "error"; message: string }
  | { type: "review-error"; message: string }
  | { type: "device-lost" }
  | { type: "cancelled" }
  | { type: "inserted" }
  | { type: "discarded" }
  | { type: "dismissed" }
  | { type: "idle-timeout" };

export const initialVoiceState: VoiceState = { phase: "idle", level: 0 };

function idle(notice?: string): VoiceState {
  return notice ? { phase: "idle", level: 0, notice } : initialVoiceState;
}

export function reduceVoice(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "capture-requested":
      if (state.phase !== "idle" && state.phase !== "error") return state;
      return {
        phase: "capturing",
        level: 0,
        startedAt: null,
        target: event.target,
        mode: event.mode ?? "dictation",
      };

    case "capture-acknowledged":
      return state.phase === "capturing"
        ? { ...state, startedAt: event.at }
        : state;

    case "capture-started":
      return state.phase === "capturing"
        ? { ...state, utteranceId: event.utteranceId }
        : state;

    case "released":
      if (state.phase !== "capturing") return state;
      if (
        state.startedAt === null ||
        !state.utteranceId ||
        event.at - state.startedAt < MIN_CAPTURE_MS
      )
        return idle();
      return {
        phase: "transcribing",
        level: 0,
        target: state.target,
        utteranceId: state.utteranceId,
        mode: state.mode,
      };

    case "level":
      return state.phase === "capturing"
        ? { ...state, level: Math.max(0, Math.min(1, event.rms)) }
        : state;

    case "partial":
      return state.phase === "capturing" ? { ...state, partial: event.text } : state;

    case "transcribing":
      return state.phase === "capturing" && state.utteranceId
        ? {
            phase: "transcribing",
            level: 0,
            target: state.target,
            utteranceId: state.utteranceId,
            mode: state.mode,
          }
        : state;

    case "command-pending":
      // Only a command-mode capture that finished transcribing can surface a
      // pending command; dictation never reaches here.
      return state.phase === "transcribing"
        ? {
            phase: "command",
            level: 0,
            command: event.command,
            label: event.label,
          }
        : state;

    case "command-resolved":
      // Executed, confirmed-and-run, or cancelled — either from the pending
      // confirm state or straight from transcribing (auto-confirm / aborts).
      return state.phase === "command" || state.phase === "transcribing"
        ? idle(event.notice)
        : state;

    case "transcript-ready":
      if (state.phase !== "transcribing") return state;
      return event.reviewBeforeInsert
        ? { phase: "review", level: 0, text: event.text, target: state.target }
        : state;

    case "insertion-started":
      return state.phase === "review" || state.phase === "transcribing"
        ? {
            phase: "inserting",
            level: 0,
            text: event.text,
            target: state.target,
          }
        : state;

    case "empty-transcript":
      return state.phase === "transcribing" ? idle("Didn't catch that.") : state;

    case "model-missing":
      return state.phase === "idle" || state.phase === "error" || state.phase === "capturing"
        ? { phase: "no-model", level: 0 }
        : state;

    case "target-missing":
      return state.phase === "idle" || state.phase === "error"
        ? idle("Focus a terminal or text field first.")
        : state;

    case "download-started":
      return state.phase === "no-model" || state.phase === "idle" || state.phase === "error"
        ? { phase: "downloading", level: 0, downloaded: 0, total: null }
        : state;

    case "download-progress":
      return state.phase === "downloading"
        ? { ...state, downloaded: event.downloaded, total: event.total }
        : state;

    case "downloaded":
      return state.phase === "downloading" ? idle() : state;

    case "device-lost":
      return idle("Microphone disconnected.");

    case "error":
      return { phase: "error", level: 0, message: event.message };

    case "review-error":
      return state.phase === "review" ? { ...state, error: event.message } : state;

    case "cancelled":
    case "inserted":
    case "discarded":
    case "dismissed":
      return idle();

    case "idle-timeout":
      return state;
  }
}
