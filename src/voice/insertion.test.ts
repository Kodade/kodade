import { describe, expect, it, vi } from "vitest";
import {
  frameForInsertion,
  insertAtCaret,
  isTextInsertionTarget,
  terminalTextForInsertion,
} from "./insertion";

describe("frameForInsertion", () => {
  it("removes trailing newlines without submitting the prompt", () => {
    expect(frameForInsertion("write the tests\n\n", false)).toBe("write the tests");
    expect(frameForInsertion("windows\r\n\r\n", false)).toBe("windows");
  });

  it("collapses interior newlines when bracketed paste is unavailable", () => {
    expect(frameForInsertion("first line\nsecond line\n", false)).toBe(
      "first line second line",
    );
    expect(frameForInsertion("a\r\n\r\nb\n", false)).toBe("a b");
  });

  it("treats lone carriage returns as newlines so they cannot submit a terminal command", () => {
    expect(frameForInsertion("first\rsecond\r", false)).toBe("first second");
    expect(frameForInsertion("first\rsecond\r", true)).toBe(
      "\x1b[200~first\rsecond\x1b[201~",
    );
  });

  it("strips control characters so a transcript cannot escape the paste frame", () => {
    // An embedded paste terminator must not survive to break out of the frame.
    expect(frameForInsertion("safe\x1b[201~rm -rf", true)).toBe(
      "\x1b[200~safe[201~rm -rf\x1b[201~",
    );
    // Bare ESC and other C0 controls are removed in the non-bracketed path too.
    expect(frameForInsertion("a\x1b\x07b", false)).toBe("ab");
  });

  it("uses xterm bracketed-paste framing when the terminal enables it", () => {
    expect(frameForInsertion("first\nsecond\n", true)).toBe(
      "\x1b[200~first\nsecond\x1b[201~",
    );
  });

  it("inserts into an app text field at its caret without adding a newline", () => {
    const input = document.createElement("input");
    input.value = "ask agent";
    input.setSelectionRange(4, 4);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);

    insertAtCaret(input, "the ");

    expect(input.value).toBe("ask the agent");
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("reads bracketed-paste mode when terminal text is written, not when capture began", () => {
    const bracketedPasteMode = vi.fn(() => false);

    expect(terminalTextForInsertion("terminal-1", "first\nsecond", bracketedPasteMode)).toBe(
      "first second",
    );
    expect(bracketedPasteMode).toHaveBeenCalledWith("terminal-1");
  });

  it("accepts only text-entry input types as text insertion targets", () => {
    const text = document.createElement("input");
    text.type = "text";
    const search = document.createElement("input");
    search.type = "search";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const radio = document.createElement("input");
    radio.type = "radio";

    expect(isTextInsertionTarget(text)).toBe(true);
    expect(isTextInsertionTarget(search)).toBe(true);
    expect(isTextInsertionTarget(checkbox)).toBe(false);
    expect(isTextInsertionTarget(radio)).toBe(false);
  });
});
