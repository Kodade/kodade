// Pure layout-math tests (no React). Pins the array<->map conversion and the
// defensive fallback to default sizes.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZES,
  PANEL_IDS,
  layoutToSizes,
  shouldPersistLayout,
  sizesToExpandedSidebarLayout,
  sizesToLayout,
} from "./layout";

describe("layout helpers", () => {
  it("sizesToLayout maps a saved array onto panel ids in order", () => {
    const layout = sizesToLayout([10, 50, 15, 25]);
    expect(layout).toEqual({ sidebar: 10, terminal: 50, files: 15, editor: 25 });
    expect(Object.keys(layout)).toEqual(["sidebar", "terminal", "editor", "files"]);
  });

  it("sizesToLayout falls back to defaults for missing or wrong-length input", () => {
    const fromDefaults = sizesToLayout(undefined);
    const fromDefaultsExplicit: Record<string, number> = {};
    Object.assign(fromDefaultsExplicit, {
      sidebar: DEFAULT_SIZES[0],
      terminal: DEFAULT_SIZES[1],
      editor: DEFAULT_SIZES[3],
      files: DEFAULT_SIZES[2],
    });
    expect(fromDefaults).toEqual(fromDefaultsExplicit);
    // Wrong length is also rejected in favor of defaults.
    expect(sizesToLayout([1, 2])).toEqual(fromDefaultsExplicit);
  });

  it("layoutToSizes returns the array in panel order", () => {
    const sizes = layoutToSizes({ editor: 25, sidebar: 10, files: 15, terminal: 50 });
    expect(sizes).toEqual([10, 50, 15, 25]);
  });

  it("layoutToSizes substitutes a default for any panel missing from the map", () => {
    const sizes = layoutToSizes({ sidebar: 10, terminal: 50 });
    expect(sizes).toEqual([10, 50, DEFAULT_SIZES[2], DEFAULT_SIZES[3]]);
  });

  it("defaults sum to 100", () => {
    expect(DEFAULT_SIZES.reduce((a, b) => a + b, 0)).toBe(100);
    expect(PANEL_IDS).toEqual(["sidebar", "terminal", "editor", "files"]);
  });

  it("only persists user layout changes while the full sidebar is visible", () => {
    expect(shouldPersistLayout(true, "full")).toBe(true);
    expect(shouldPersistLayout(false, "full")).toBe(false);
    expect(shouldPersistLayout(true, "rail")).toBe(false);
  });

  it("restores a visible sidebar when expanding from a persisted collapsed layout", () => {
    expect(sizesToExpandedSidebarLayout([0, 54, 16, 30])).toEqual({
      sidebar: 14,
      terminal: 46.44,
      files: 13.76,
      editor: 25.8,
    });
  });

  it("leaves an already-visible saved sidebar layout untouched", () => {
    expect(sizesToExpandedSidebarLayout([12, 44, 16, 28])).toEqual({
      sidebar: 12,
      terminal: 44,
      files: 16,
      editor: 28,
    });
  });
});
