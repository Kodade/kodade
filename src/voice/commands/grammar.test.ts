import { describe, expect, it } from "vitest";
import {
  COMMAND_REFERENCE,
  commandLabel,
  isAbortCommand,
  isSubmittingCommand,
  parseVoiceCommand,
  type VoiceCommand,
} from "./grammar";

// Convenience: parse and require a command of a given kind.
function parsedCommand(transcript: string): VoiceCommand {
  const result = parseVoiceCommand(transcript);
  if (result.type !== "command") {
    throw new Error(`expected a command for "${transcript}", got dictation`);
  }
  return result.command;
}

describe("parseVoiceCommand — recognized commands", () => {
  const recognized: [string, VoiceCommand][] = [
    ["new terminal", { kind: "new-session" }],
    ["New Terminal", { kind: "new-session" }],
    ["new session", { kind: "new-session" }],
    ["new tab", { kind: "new-session" }],
    ["create terminal", { kind: "new-session" }],
    ["terminal 2", { kind: "switch-terminal", index: 2 }],
    ["terminal two", { kind: "switch-terminal", index: 2 }],
    ["switch to terminal 3", { kind: "switch-terminal", index: 3 }],
    ["go to terminal 1", { kind: "switch-terminal", index: 1 }],
    ["focus session 4", { kind: "switch-terminal", index: 4 }],
    ["jump to tab twelve", { kind: "switch-terminal", index: 12 }],
    ["next terminal", { kind: "next-terminal" }],
    ["next session", { kind: "next-terminal" }],
    ["previous terminal", { kind: "prev-terminal" }],
    ["prev terminal", { kind: "prev-terminal" }],
    ["send", { kind: "send" }],
    ["send it", { kind: "send" }],
    ["submit", { kind: "send" }],
    ["run it", { kind: "send" }],
    ["cancel", { kind: "cancel" }],
    ["never mind", { kind: "cancel" }],
    ["discard", { kind: "discard" }],
    ["scratch that", { kind: "discard" }],
  ];

  it.each(recognized)("parses %j as a command", (transcript, expected) => {
    expect(parseVoiceCommand(transcript)).toEqual({
      type: "command",
      command: expected,
    });
  });

  it("is tolerant of surrounding punctuation and whitespace", () => {
    expect(parsedCommand("  New terminal!  ")).toEqual({ kind: "new-session" });
    expect(parsedCommand("send.")).toEqual({ kind: "send" });
    expect(parsedCommand("terminal, 2")).toEqual({
      kind: "switch-terminal",
      index: 2,
    });
  });
});

describe("parseVoiceCommand — near-misses fall through to dictation", () => {
  // Extra words, embedded commands, and plausible dictation that must NOT be
  // read as a command. The last few are adversarial: they contain a destructive
  // verb or a command word but must dictate, never act.
  const dictation = [
    "",
    "   ",
    "new terminal window on the left",
    "open the new terminal and run the build",
    "switch to terminal two after you finish",
    "send the file to bob",
    "send this pull request when it is ready",
    "please submit the form for me",
    "run it through the linter first",
    "terminal", // no index
    "terminal to", // mis-heard "two" — not a number
    "go to the terminal", // no index, has an article
    "delete the project", // adversarial: destructive verb, no matching command
    "delete terminal 2", // adversarial: "delete" is never a trigger
    "remove that session", // adversarial
    "cancel the deployment", // extra words — not the bare abort
    "discard the changes in the editor", // extra words
    "add a new test for the parser",
  ];

  it.each(dictation)("falls through for %j", (transcript) => {
    expect(parseVoiceCommand(transcript)).toEqual({ type: "dictation" });
  });

  it("does not match a switch to terminal 0 or a non-positive index", () => {
    expect(parseVoiceCommand("terminal 0")).toEqual({ type: "dictation" });
  });
});

describe("command classification helpers", () => {
  it("marks only send as submitting", () => {
    expect(isSubmittingCommand({ kind: "send" })).toBe(true);
    expect(isSubmittingCommand({ kind: "new-session" })).toBe(false);
    expect(isSubmittingCommand({ kind: "switch-terminal", index: 2 })).toBe(false);
  });

  it("marks cancel and discard as aborts, nothing else", () => {
    expect(isAbortCommand({ kind: "cancel" })).toBe(true);
    expect(isAbortCommand({ kind: "discard" })).toBe(true);
    expect(isAbortCommand({ kind: "send" })).toBe(false);
    expect(isAbortCommand({ kind: "new-session" })).toBe(false);
  });

  it("labels every command kind", () => {
    expect(commandLabel({ kind: "new-session" })).toBe("New terminal");
    expect(commandLabel({ kind: "switch-terminal", index: 3 })).toBe(
      "Switch to terminal 3",
    );
    expect(commandLabel({ kind: "send" })).toBe("Send to terminal");
  });

  it("keeps a discoverable command reference", () => {
    expect(COMMAND_REFERENCE.length).toBeGreaterThan(0);
    for (const row of COMMAND_REFERENCE) {
      // Every example must actually parse as a command (reference never drifts).
      expect(parseVoiceCommand(row.example).type).toBe("command");
    }
  });
});
