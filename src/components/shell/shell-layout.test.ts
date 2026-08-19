// Pure model tests for the v2 shell layout: defaults, v1 migration, per-field
// fallback, and "never throws" on junk from disk.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZES,
  layoutToSizes,
  sizesToLayout,
  sizesToRestoredLayout,
} from "../layout";
import {
  type ShellLayout,
  defaultShellLayout,
  isShellLayout,
  migrateShellLayout,
} from "./shell-layout";

// v1 files share of the editor area: 16 / (16 + 30) * 100.
const FILES_PCT = 34.78;

describe("defaultShellLayout", () => {
  it("starts on the Code tab with an even chat/terminal split", () => {
    expect(defaultShellLayout()).toEqual({
      version: 2,
      activeTab: "code",
      sidebarPct: DEFAULT_SIZES[0],
      code: { mode: "both", chatPct: 50, expanded: null },
      editor: {
        filesPct: FILES_PCT,
        panels: { github: false, review: false },
      },
    });
  });

  it("carries the v1 sidebar width and files proportion", () => {
    const layout = defaultShellLayout();
    expect(layout.sidebarPct).toBe(14);
    expect(layout.editor.filesPct).toBeCloseTo(
      (DEFAULT_SIZES[2] / (DEFAULT_SIZES[2] + DEFAULT_SIZES[3])) * 100,
      2,
    );
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = defaultShellLayout();
    const b = defaultShellLayout();
    a.code.chatPct = 80;
    expect(b.code.chatPct).toBe(50);
  });

  it("is accepted by its own validator", () => {
    expect(isShellLayout(defaultShellLayout())).toBe(true);
  });
});

describe("migrateShellLayout from real v1 shapes", () => {
  it("migrates the v1 default map", () => {
    const v1 = sizesToLayout(DEFAULT_SIZES);
    expect(migrateShellLayout(v1)).toEqual({
      ...defaultShellLayout(),
      sidebarPct: 14,
    });
  });

  it("migrates a user-dragged v1 map, keeping the sidebar width", () => {
    // A real drag: sidebar widened to 22, remaining panes summing to ~100.
    const v1 = sizesToLayout([22, 34, 16, 28]);
    expect(v1).toEqual({ sidebar: 22, terminal: 34, editor: 28, files: 16 });
    const migrated = migrateShellLayout(v1);
    expect(migrated.sidebarPct).toBe(22);
    expect(migrated.activeTab).toBe("code");
    expect(migrated.code).toEqual({ mode: "both", chatPct: 50, expanded: null });
  });

  it("migrates the persisted v1 array the projects store writes", () => {
    // The store persists PaneSizes: [sidebar, terminal, files, editor].
    const sizes = layoutToSizes(sizesToLayout([22, 34, 16, 28]));
    expect(sizes).toEqual([22, 34, 16, 28]);
    expect(migrateShellLayout(sizes).sidebarPct).toBe(22);
  });

  it("uses the default width when the persisted sidebar was collapsed", () => {
    // Dragging the sidebar to 0 does persist (shouldPersistLayout only gates
    // rail mode), so a saved zero must not become a 0%-wide v2 sidebar.
    expect(migrateShellLayout(sizesToLayout([0, 54, 16, 30])).sidebarPct).toBe(
      14,
    );
    expect(migrateShellLayout([0, 54, 16, 30]).sidebarPct).toBe(14);
  });

  it("uses the default width for a crushed sub-minimum sidebar", () => {
    expect(migrateShellLayout([3, 51, 16, 30]).sidebarPct).toBe(14);
  });

  it("clamps an absurdly wide persisted sidebar to the v2 ceiling", () => {
    expect(migrateShellLayout([70, 10, 10, 10]).sidebarPct).toBe(40);
  });

  it("migrates a files-collapsed v1 map (files rail never persists a width)", () => {
    // shouldPersistLayout(_, "full", true) is false, so only pre-rail docs can
    // hold a zero files pane; the sidebar still carries over.
    const migrated = migrateShellLayout(sizesToLayout([14, 56, 0, 30]));
    expect(migrated.sidebarPct).toBe(14);
    expect(migrated.editor.filesPct).toBe(FILES_PCT);
  });

  it("carries the user's files/editor ratio into filesPct", () => {
    // Files dragged wide: 25 / (25 + 21) * 100 = 54.35 of the editor area.
    expect(migrateShellLayout([14, 40, 25, 21]).editor.filesPct).toBe(54.35);
    expect(
      migrateShellLayout(sizesToLayout([14, 40, 25, 21])).editor.filesPct,
    ).toBe(54.35);
  });

  it("keeps the default files ratio for the v1 default sizes", () => {
    expect(migrateShellLayout(DEFAULT_SIZES).editor.filesPct).toBe(FILES_PCT);
  });

  it("migrates a sizesToRestoredLayout result (un-collapsed v1 geometry)", () => {
    const restored = sizesToRestoredLayout([0, 54, 16, 30], ["sidebar"]);
    const migrated = migrateShellLayout(restored);
    expect(migrated.sidebarPct).toBe(14);
    // files 13.76 / (13.76 + 25.8) * 100
    expect(migrated.editor.filesPct).toBeCloseTo(34.78, 1);
  });

  it("migrates a v1 map carrying extra keys", () => {
    const migrated = migrateShellLayout({
      ...sizesToLayout([22, 34, 16, 28]),
      preview: 0,
      legacy: "ignored",
    });
    expect(migrated.sidebarPct).toBe(22);
    expect(migrated.editor.filesPct).toBe(36.36);
  });

  it("ignores 4-number arrays that fail the persisted sanity check", () => {
    expect(migrateShellLayout([-14, 40, 46, 28])).toEqual(defaultShellLayout());
    expect(migrateShellLayout([1, 2, 3, 4])).toEqual(defaultShellLayout()); // sum too low
    expect(migrateShellLayout([50, 50, 50, 50])).toEqual(defaultShellLayout()); // sum too high
    expect(migrateShellLayout([0, 0, 0, 0])).toEqual(defaultShellLayout());
  });

  it("ignores a v1-length array of non-numbers", () => {
    expect(migrateShellLayout(["a", "b", "c", "d"])).toEqual(
      defaultShellLayout(),
    );
  });

  it("ignores a wrong-length array", () => {
    expect(migrateShellLayout([22, 34])).toEqual(defaultShellLayout());
  });

  it("ignores an object that merely happens to have a sidebar number", () => {
    expect(migrateShellLayout({ sidebar: 22 })).toEqual(defaultShellLayout());
  });
});

describe("migrateShellLayout with v2 documents", () => {
  const valid: ShellLayout = {
    version: 2,
    activeTab: "editor",
    sidebarPct: 18,
    code: { mode: "terminal", chatPct: 62, expanded: "chat" },
    editor: { filesPct: 25, panels: { github: true, review: false } },
  };

  it("round-trips a valid document unchanged apart from the expand reset", () => {
    expect(migrateShellLayout(valid)).toEqual({
      ...valid,
      code: { ...valid.code, expanded: null },
    });
    expect(isShellLayout(valid)).toBe(true);
  });

  it("never restores an expanded pane (booting into a full-app pane traps the user)", () => {
    for (const expanded of ["chat", "terminal"] as const) {
      // Valid v2 fast path...
      expect(
        migrateShellLayout({ ...valid, code: { ...valid.code, expanded } }).code
          .expanded,
      ).toBeNull();
      // ...and the damaged-document path.
      expect(
        migrateShellLayout({ version: 2, code: { expanded } }).code.expanded,
      ).toBeNull();
    }
  });

  it("preserves unrounded percentages on the fast path", () => {
    const migrated = migrateShellLayout({
      ...valid,
      sidebarPct: 17.1234,
      code: { ...valid.code, chatPct: 62.3456 },
      editor: { ...valid.editor, filesPct: 33.9999 },
    });
    expect(migrated.code.chatPct).toBe(62.3456);
    expect(migrated.sidebarPct).toBe(17.1234);
    expect(migrated.editor.filesPct).toBe(33.9999);
  });

  it("returns a copy, not the persisted object", () => {
    const migrated = migrateShellLayout(valid);
    expect(migrated).not.toBe(valid);
    expect(migrated.code).not.toBe(valid.code);
    expect(migrated.editor.panels).not.toBe(valid.editor.panels);
  });

  it("clamps an out-of-range chatPct", () => {
    expect(migrateShellLayout({ ...valid, code: { ...valid.code, chatPct: 200 } })
      .code.chatPct).toBe(90);
    expect(migrateShellLayout({ ...valid, code: { ...valid.code, chatPct: 1 } })
      .code.chatPct).toBe(10);
  });

  it("clamps an out-of-range filesPct and sidebarPct", () => {
    const migrated = migrateShellLayout({
      ...valid,
      sidebarPct: 95,
      editor: { ...valid.editor, filesPct: -5 },
    });
    expect(migrated.sidebarPct).toBe(40);
    expect(migrated.editor.filesPct).toBe(10);
  });

  it("defaults a non-numeric percentage instead of clamping", () => {
    const migrated = migrateShellLayout({
      ...valid,
      sidebarPct: "wide",
      code: { ...valid.code, chatPct: Number.NaN },
    });
    expect(migrated.sidebarPct).toBe(14);
    expect(migrated.code.chatPct).toBe(50);
    // Untouched fields survive the per-field fallback.
    expect(migrated.activeTab).toBe("editor");
    expect(migrated.code.mode).toBe("terminal");
  });

  it("defaults an unknown tab id but keeps the rest", () => {
    const migrated = migrateShellLayout({ ...valid, activeTab: "browser" });
    expect(migrated.activeTab).toBe("code");
    expect(migrated.sidebarPct).toBe(18);
    expect(migrated.editor.panels).toEqual({ github: true, review: false });
  });

  it("defaults an unknown code mode and expand target", () => {
    const migrated = migrateShellLayout({
      ...valid,
      code: { mode: "split", chatPct: 62, expanded: "files" },
    });
    expect(migrated.code).toEqual({ mode: "both", chatPct: 62, expanded: null });
  });

  it("accepts a null expand target as the real 'not expanded' value", () => {
    const migrated = migrateShellLayout({
      ...valid,
      code: { ...valid.code, expanded: null },
    });
    expect(migrated.code.expanded).toBeNull();
  });

  it("defaults missing panels", () => {
    expect(
      migrateShellLayout({ ...valid, editor: { filesPct: 25 } }).editor,
    ).toEqual({ filesPct: 25, panels: { github: false, review: false } });
  });

  it("defaults individually bad panel flags", () => {
    expect(
      migrateShellLayout({
        ...valid,
        editor: { filesPct: 25, panels: { github: "yes", review: true } },
      }).editor.panels,
    ).toEqual({ github: false, review: true });
  });

  it("defaults a missing code or editor section", () => {
    expect(migrateShellLayout({ version: 2, activeTab: "agents" })).toEqual({
      ...defaultShellLayout(),
      activeTab: "agents",
    });
  });

  it("treats a wrong version number as a damaged v2 document", () => {
    // Fields still readable are kept; the version is normalized to 2.
    const migrated = migrateShellLayout({ ...valid, version: 99 });
    expect(migrated.version).toBe(2);
    expect(migrated.activeTab).toBe("editor");
  });
});

describe("isShellLayout", () => {
  it("rejects near-misses", () => {
    const valid = defaultShellLayout();
    expect(isShellLayout({ ...valid, version: 1 })).toBe(false);
    expect(isShellLayout({ ...valid, activeTab: "browser" })).toBe(false);
    expect(isShellLayout({ ...valid, sidebarPct: 100 })).toBe(false);
    expect(
      isShellLayout({ ...valid, code: { ...valid.code, chatPct: 0 } }),
    ).toBe(false);
    expect(
      isShellLayout({
        ...valid,
        editor: { filesPct: 30, panels: { github: false } },
      }),
    ).toBe(false);
    expect(isShellLayout(null)).toBe(false);
    expect(isShellLayout([])).toBe(false);
  });
});

describe("migrateShellLayout never throws", () => {
  const junk: unknown[] = [
    null,
    undefined,
    42,
    0,
    "",
    "layout",
    true,
    false,
    [],
    [null, null, null, null],
    [[1], [2], [3], [4]],
    {},
    { version: 99 },
    { version: "2" },
    { version: 2, code: null, editor: 5 },
    { version: 2, code: [], editor: [] },
    { sidebar: Number.NaN, terminal: 40, files: 16, editor: 30 },
    { sidebar: Number.POSITIVE_INFINITY, terminal: 40, editor: 30 },
    { activeTab: { nested: true } },
    JSON.parse('{"code":{"chatPct":"50"},"editor":{"panels":null}}'),
  ];

  it.each(junk.map((value, i) => [i, value]))(
    "returns a valid layout for junk input #%i",
    (_i, value) => {
      let migrated: ShellLayout | undefined;
      expect(() => {
        migrated = migrateShellLayout(value);
      }).not.toThrow();
      expect(isShellLayout(migrated)).toBe(true);
    },
  );

  it("garbage inputs land on the defaults", () => {
    for (const value of [null, 42, "", [], { version: 99, junk: true }]) {
      expect(migrateShellLayout(value)).toEqual(defaultShellLayout());
    }
  });
});
