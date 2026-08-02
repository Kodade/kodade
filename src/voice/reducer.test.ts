import { describe, expect, it } from "vitest";
import {
  MIN_CAPTURE_MS,
  initialVoiceState,
  reduceVoice,
  type VoiceTarget,
} from "./reducer";

const target: VoiceTarget = {
  kind: "terminal",
  sessionId: "session-1",
};

describe("voice reducer", () => {
  it("moves through capture, transcription, review, and back to idle", () => {
    const capturing = reduceVoice(initialVoiceState, {
      type: "capture-requested",
      at: 100,
      target,
    });
    const acknowledged = reduceVoice(capturing, {
      type: "capture-acknowledged",
      at: 100,
    });
    const withUtterance = reduceVoice(acknowledged, {
      type: "capture-started",
      utteranceId: "utterance-1",
    });
    const transcribing = reduceVoice(withUtterance, {
      type: "released",
      at: 100 + MIN_CAPTURE_MS,
    });
    const review = reduceVoice(transcribing, {
      type: "transcript-ready",
      text: "add a voice test",
      reviewBeforeInsert: true,
    });

    expect(capturing.phase).toBe("capturing");
    expect(acknowledged).toMatchObject({ phase: "capturing", startedAt: 100 });
    expect(withUtterance).toMatchObject({
      phase: "capturing",
      utteranceId: "utterance-1",
    });
    expect(transcribing.phase).toBe("transcribing");
    expect(review).toMatchObject({
      phase: "review",
      text: "add a voice test",
      target,
    });
    expect(reduceVoice(review, { type: "discarded" })).toEqual(initialVoiceState);
  });

  it("cancels a release shorter than the minimum capture time", () => {
    const capturing = reduceVoice(initialVoiceState, {
      type: "capture-requested",
      at: 100,
      target,
    });

    expect(
      reduceVoice(capturing, { type: "released", at: 100 + MIN_CAPTURE_MS - 1 }),
    ).toEqual(initialVoiceState);
  });

  it("recovers from capture errors and reports a missing model", () => {
    const noModel = reduceVoice(initialVoiceState, { type: "model-missing" });
    const error = reduceVoice(noModel, {
      type: "error",
      message: "Microphone permission is off.",
    });

    expect(noModel.phase).toBe("no-model");
    expect(error).toMatchObject({ phase: "error", message: "Microphone permission is off." });
    expect(reduceVoice(error, { type: "dismissed" })).toEqual(initialVoiceState);
  });

  it("returns to idle with a quiet notice when the device disappears", () => {
    expect(
      reduceVoice(initialVoiceState, { type: "device-lost" }),
    ).toMatchObject({ phase: "idle", notice: "Microphone disconnected." });
  });

  it("returns to idle without covering the terminal after a model download", () => {
    const downloading = reduceVoice(
      reduceVoice(initialVoiceState, { type: "model-missing" }),
      { type: "download-started" },
    );

    expect(reduceVoice(downloading, { type: "downloaded" })).toEqual(
      initialVoiceState,
    );
  });

  it("records a streaming partial only while capturing", () => {
    const capturing = reduceVoice(initialVoiceState, {
      type: "capture-requested",
      at: 100,
      target,
    });
    const withPartial = reduceVoice(capturing, {
      type: "partial",
      text: "add a focused",
    });
    expect(withPartial).toMatchObject({ phase: "capturing", partial: "add a focused" });

    // A partial arriving outside capture is ignored (no phase to attach it to).
    expect(reduceVoice(initialVoiceState, { type: "partial", text: "late" })).toEqual(
      initialVoiceState,
    );
  });
});
