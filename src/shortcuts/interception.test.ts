import { describe, expect, it } from "vitest";
import { shouldInterceptXtermKey } from "./interception";

function key(
  key: string,
  modifiers: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

describe("xterm app-chord interception", () => {
  it("releases Windows Ctrl app chords but keeps shell controls", () => {
    expect(shouldInterceptXtermKey(key("t", { ctrlKey: true }), false)).toBe(
      true,
    );
    expect(shouldInterceptXtermKey(key("c", { ctrlKey: true }), false)).toBe(
      false,
    );
    expect(shouldInterceptXtermKey(key("Tab", { ctrlKey: true }), false)).toBe(
      false,
    );
  });

  it("preserves macOS Cmd semantics", () => {
    expect(shouldInterceptXtermKey(key("t", { metaKey: true }), true)).toBe(
      true,
    );
    expect(shouldInterceptXtermKey(key("t", { ctrlKey: true }), true)).toBe(
      false,
    );
  });
});
