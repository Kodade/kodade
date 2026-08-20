// Persisted layout model for the v2 tabbed shell (Agents / Code / Editor).
//
// Pure data + math only: no React, no store imports, so it tests headless the
// same way `../layout.ts` does. This module is additive — the v1 four-pane
// path in `../layout.ts` is untouched and still owns the shipping shell.
//
// The `version` field exists so a future v3 can tell a real v2 document from a
// half-written or foreign one without guessing at its shape: migration keys off
// the literal, never off "does it happen to have the fields I want".

import { DEFAULT_SIZES } from "../layout";

export type ShellTabId = "agents" | "code" | "editor";
export type CodePaneMode = "both" | "chat" | "terminal"; // which panes are open
export type CodeExpandTarget = "chat" | "terminal" | null; // temporarily full-app

export interface ShellLayout {
  version: 2;
  activeTab: ShellTabId;
  sidebarPct: number; // full-sidebar width as % of window
  code: { mode: CodePaneMode; chatPct: number; expanded: CodeExpandTarget };
  editor: { filesPct: number; panels: { github: boolean; review: boolean } };
}

const SHELL_TAB_IDS: readonly ShellTabId[] = ["agents", "code", "editor"];
const CODE_PANE_MODES: readonly CodePaneMode[] = ["both", "chat", "terminal"];
const CODE_EXPAND_TARGETS: readonly CodeExpandTarget[] = [
  "chat",
  "terminal",
  null,
];

// Bounds. A split pane may be dragged nearly anywhere but never to a sliver the
// user can't drag back; the sidebar has a tighter ceiling because it holds a
// fixed-width project list.
// Exported so the panes that WRITE geometry clamp to exactly what load
// enforces — one source of truth for the split bounds.
export const SPLIT_MIN = 10;
export const SPLIT_MAX = 90;
export const SIDEBAR_MIN = 8;
export const SIDEBAR_MAX = 40;

// v1 persisted array order (see ../layout.ts PERSISTED_PANEL_IDS):
// [sidebar, terminal, files, editor].
const V1_SIDEBAR = 0;
const V1_FILES = 2;
const V1_EDITOR = 3;

// v1 defaults translated into v2 terms:
// - sidebarPct is the same window-relative percentage (14).
// - filesPct is window-relative in v1 but editor-area-relative in v2, so it is
//   the files share of the files+editor region: 16 / (16 + 30) ≈ 34.78 -> 34.78.
const DEFAULT_SIDEBAR_PCT = DEFAULT_SIZES[V1_SIDEBAR];
const DEFAULT_FILES_PCT = round2(
  (DEFAULT_SIZES[V1_FILES] / (DEFAULT_SIZES[V1_FILES] + DEFAULT_SIZES[V1_EDITOR])) *
    100,
);
const DEFAULT_CHAT_PCT = 50; // even split is the neutral first-run chat/terminal

export function defaultShellLayout(): ShellLayout {
  return {
    version: 2,
    activeTab: "code", // the workflow default: chat + terminal side by side
    // Clamped even though the v1 constants satisfy the contract today: a future
    // DEFAULT_SIZES edit must not be able to emit an out-of-contract default.
    sidebarPct: clampOr(DEFAULT_SIDEBAR_PCT, SIDEBAR_MIN, SIDEBAR_MAX, 14),
    code: { mode: "both", chatPct: DEFAULT_CHAT_PCT, expanded: null },
    editor: {
      filesPct: DEFAULT_FILES_PCT,
      panels: { github: false, review: false },
    },
  };
}

// Full structural validator for a v2 document. Used by migrate to take the
// fast path (and exported so callers can assert a value before trusting it).
export function isShellLayout(value: unknown): value is ShellLayout {
  if (!isRecord(value)) return false;
  if (value.version !== 2) return false;
  if (!isTab(value.activeTab)) return false;
  if (!inRange(value.sidebarPct, SIDEBAR_MIN, SIDEBAR_MAX)) return false;

  const code = value.code;
  if (!isRecord(code)) return false;
  if (!CODE_PANE_MODES.includes(code.mode as CodePaneMode)) return false;
  if (!inRange(code.chatPct, SPLIT_MIN, SPLIT_MAX)) return false;
  if (!CODE_EXPAND_TARGETS.includes(code.expanded as CodeExpandTarget))
    return false;

  const editor = value.editor;
  if (!isRecord(editor)) return false;
  if (!inRange(editor.filesPct, SPLIT_MIN, SPLIT_MAX)) return false;
  const panels = editor.panels;
  if (!isRecord(panels)) return false;
  if (typeof panels.github !== "boolean") return false;
  if (typeof panels.review !== "boolean") return false;

  return true;
}

// Read whatever is in storage and always produce a usable layout.
//
// Per-field fallback (rather than all-or-nothing) is deliberate: one bad number
// from a hand-edited document or a partially-written doc should cost the user
// that single preference, not the whole remembered shell. Never throws.
export function migrateShellLayout(persisted: unknown): ShellLayout {
  const defaults = defaultShellLayout();

  // Fast path: already a fully valid v2 document. `expanded` is still dropped —
  // see the note on the reset below.
  if (isShellLayout(persisted)) {
    return {
      version: 2,
      activeTab: persisted.activeTab,
      sidebarPct: persisted.sidebarPct,
      code: {
        mode: persisted.code.mode,
        chatPct: persisted.code.chatPct,
        expanded: null,
      },
      editor: {
        filesPct: persisted.editor.filesPct,
        panels: {
          github: persisted.editor.panels.github,
          review: persisted.editor.panels.review,
        },
      },
    };
  }

  if (!isRecord(persisted) && !Array.isArray(persisted)) return defaults;

  // v1 shapes: the `Record<string, number>` map from sizesToLayout, or the
  // persisted `[sidebar, terminal, files, editor]` array the projects store
  // writes. Two things carry over: the sidebar width, and the files/editor
  // ratio (v1 stores both window-relative, v2 stores files relative to the
  // editor area). chatPct has no v1 analog — the tabbed shell's chat/terminal
  // split is a new pane arrangement — so it starts at the default.
  const v1 = readV1Geometry(persisted);
  if (v1) {
    return {
      ...defaults,
      sidebarPct: v1.sidebarPct,
      editor: { ...defaults.editor, filesPct: v1.filesPct },
    };
  }

  // Partial / damaged v2: keep every field that validates, default the rest.
  const source = isRecord(persisted) ? persisted : {};
  const code = isRecord(source.code) ? source.code : {};
  const editor = isRecord(source.editor) ? source.editor : {};
  const panels = isRecord(editor.panels) ? editor.panels : {};

  return {
    version: 2,
    activeTab: isTab(source.activeTab) ? source.activeTab : defaults.activeTab,
    sidebarPct: clampOr(
      source.sidebarPct,
      SIDEBAR_MIN,
      SIDEBAR_MAX,
      defaults.sidebarPct,
    ),
    code: {
      mode: CODE_PANE_MODES.includes(code.mode as CodePaneMode)
        ? (code.mode as CodePaneMode)
        : defaults.code.mode,
      chatPct: clampOr(
        code.chatPct,
        SPLIT_MIN,
        SPLIT_MAX,
        defaults.code.chatPct,
      ),
      // `expanded` is deliberately never restored: booting into a full-app
      // pane with the rest of the shell hidden is a trap with no obvious way
      // out. It stays in the type because it is legitimate runtime state — it
      // just always loads as null.
      expanded: null,
    },
    editor: {
      filesPct: clampOr(
        editor.filesPct,
        SPLIT_MIN,
        SPLIT_MAX,
        defaults.editor.filesPct,
      ),
      panels: {
        github:
          typeof panels.github === "boolean"
            ? panels.github
            : defaults.editor.panels.github,
        review:
          typeof panels.review === "boolean"
            ? panels.review
            : defaults.editor.panels.review,
      },
    },
  };
}

// --- helpers ---------------------------------------------------------------

// Recognize a v1 document and translate its geometry, or null if this isn't v1.
function readV1Geometry(
  persisted: object,
): { sidebarPct: number; filesPct: number } | null {
  const sizes = readV1Sizes(persisted);
  if (!sizes) return null;

  const files = sizes[V1_FILES];
  const editorArea = files + sizes[V1_EDITOR];
  // Window-relative v1 widths become an editor-area-relative ratio.
  const ratio = editorArea > 0 ? (files / editorArea) * 100 : Number.NaN;

  return {
    sidebarPct: v1Pct(sizes[V1_SIDEBAR], SIDEBAR_MIN, SIDEBAR_MAX, DEFAULT_SIDEBAR_PCT),
    filesPct: v1Pct(ratio, SPLIT_MIN, SPLIT_MAX, DEFAULT_FILES_PCT),
  };
}

// Normalize one migrated v1 percentage. A pane the user collapsed (0, or any
// value under the v2 floor) restores its default rather than clamping to the
// floor — mirroring sizesToRestoredLayout, where a saved zero must never be
// reapplied and strand a pane off-screen. Oversized values still clamp.
function v1Pct(raw: number, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(raw) || raw < min) return fallback;
  return round2(Math.min(raw, max));
}

// Both v1 encodings normalized to the persisted array
// [sidebar, terminal, files, editor], or null when this isn't v1 geometry.
// The sanity check mirrors the store's isPaneSizes (4 non-negative percentages
// summing to ~100) so a hand-edited or unrelated document can't be read as
// saved pane sizes.
function readV1Sizes(persisted: object): number[] | null {
  const sizes = Array.isArray(persisted)
    ? persisted
    : v1MapToSizes(persisted as Record<string, unknown>);
  if (!sizes || sizes.length !== 4) return null;
  if (!sizes.every((n) => isFiniteNumber(n) && n >= 0)) return null;
  const sum = sizes.reduce((total, n) => total + n, 0);
  if (sum < 90 || sum > 110) return null;
  return sizes;
}

// A v1 map is the sizesToLayout output: all four panes as numbers, and no
// `version` key. Extra keys are tolerated (older docs carried strays); the
// strictness keeps an unrelated object with a `sidebar` field from being
// mistaken for saved v1 geometry.
function v1MapToSizes(map: Record<string, unknown>): number[] | null {
  if ("version" in map) return null;
  const sizes = ["sidebar", "terminal", "files", "editor"].map((id) => map[id]);
  if (!sizes.every(isFiniteNumber)) return null;
  return sizes as number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTab(value: unknown): value is ShellTabId {
  return SHELL_TAB_IDS.includes(value as ShellTabId);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function inRange(value: unknown, min: number, max: number): boolean {
  return isFiniteNumber(value) && value >= min && value <= max;
}

// Out-of-range but plausible values clamp (a slightly overshot drag keeps the
// user's intent); non-numbers and NaN fall back to the default.
function clampOr(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!isFiniteNumber(value)) return fallback;
  return round2(Math.min(Math.max(value, min), max));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
