import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearTerminalDropTarget,
  isTerminalDropPosition,
  setTerminalDropTarget,
} from "./drop-target";

const rect = { left: 250, top: 350, right: 650, bottom: 750 };

function installTarget() {
  const target = document.createElement("div");
  Object.defineProperty(target, "getBoundingClientRect", {
    value: () => ({ ...rect }) as DOMRect,
  });
  setTerminalDropTarget(target);
}

beforeEach(() => {
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 2,
  });
});

afterEach(() => clearTerminalDropTarget());

describe("terminal drop target", () => {
  it("uses logical CSS coordinates for macOS drops", () => {
    installTarget();

    expect(isTerminalDropPosition({ x: 400, y: 600 }, true)).toBe(true);
    expect(isTerminalDropPosition({ x: 200, y: 300 }, true)).toBe(false);
  });

  it("converts physical coordinates for non-macOS drops", () => {
    installTarget();

    expect(isTerminalDropPosition({ x: 800, y: 1200 }, false)).toBe(true);
    expect(isTerminalDropPosition({ x: 400, y: 600 }, false)).toBe(false);
  });

  it("misses when no terminal target is registered", () => {
    expect(isTerminalDropPosition({ x: 400, y: 600 }, true)).toBe(false);
  });
});
