// The KödHarness domain model: a flat list of harness artifacts under one
// envelope, derived by a pure scan (scan.ts). This module is a leaf — it holds
// only types and tiny pure helpers, so both the adapter contract and the scan
// engine can depend on it without cycles. Projections (per-CLI matrix cells,
// per-kind grouping) are computed at view time, never stored here.

// Where an artifact lives: the active project, or the user's global config.
export type HarnessScope = "global" | "project";

// The four things a harness is made of. MCP servers are artifacts too (not a
// special case), so a safe merge later targets exactly one server entry.
export type ArtifactKind = "instruction" | "skill" | "subagent" | "mcp-server";

// Scan health for one artifact. "orphaned-symlink" is a broken dotfiles link —
// surfaced explicitly so it never becomes a silent empty row.
export type ArtifactStatus = "ok" | "unreadable" | "malformed" | "orphaned-symlink";

// How the artifact is reached on disk. A symlink carries its resolved target so
// the UI can show "⇲ symlink → dotfiles/…" and enable/disable operates on the
// link entry itself, never writing through it into the dotfiles repo.
export type ArtifactSource =
  | { via: "file" }
  | { via: "dir" }
  | { via: "symlink"; target: string };

// Per-kind detail. Minimal-but-typed for M10a; later milestones enrich these
// (e.g. MCP transport/command for the safe-merge preview). `kind` tags the
// union so a consumer can narrow without inspecting the parent artifact.
export type InstructionDetail = {
  kind: "instruction";
  lines: number | null; // null when the file is present but unreadable/too large
  bytes: number | null;
};

export type SkillDetail = {
  kind: "skill";
  // Absolute path to the skill's SKILL.md when one was found in its directory.
  manifestPath: string | null;
};

export type McpServerDetail = {
  kind: "mcp-server";
  server: string; // the server key/name inside the config file
  configPath: string; // the raw config file this server was read from
  format: "json" | "jsonc" | "toml";
  // Minimal for M10a: transport ("stdio"/"http"/…) and command/url when the
  // format was cheap to parse; full parse-tree detail is M10e's concern.
  transport: string | null;
  command: string | null;
};

export type ArtifactDetail = InstructionDetail | SkillDetail | McpServerDetail;

export type HarnessArtifact = {
  id: string; // stable: `${cli}:${scope}:${kind}:${relpath}`
  cli: string; // provider id from catalog.ts
  scope: HarnessScope;
  kind: ArtifactKind;
  name: string; // display name (the `.disabled` suffix stripped)
  path: string; // absolute real path (the link entry for a symlink)
  source: ArtifactSource;
  enabled: boolean; // false when the entry carries the reversible `.disabled` suffix
  status: ArtifactStatus;
  canonicalGroupId?: string; // instruction linkage; v1 = badge only, sync is M10f
  detail?: ArtifactDetail;
};

// A location that could not be read (e.g. a skills dir with permission denied).
// Errors are collected alongside artifacts so the inventory carries them without
// a side channel and the pane can render an inline `role="alert"` banner.
export type HarnessScanError = {
  cli: string;
  scope: HarnessScope;
  kind: ArtifactKind;
  path: string;
  message: string;
};

// The whole harness state for one scan pass: a flat artifact list plus the
// locations that failed, stamped with when the scan ran (for the rescan clock).
export type HarnessInventory = {
  scannedAt: number;
  artifacts: HarnessArtifact[];
  errors: HarnessScanError[];
};

// Runtime context injected into a scan. Absolute paths are resolved from these
// (home from the login shell, projectRoot from the active project) so the
// catalog only ever stores separator-free path templates. `platform` is carried
// for adapters that need OS-specific behavior later.
export type ScanContext = {
  home: string; // absolute home dir, from ShellEnvironment
  platform: "mac" | "windows" | "linux";
  projectRoot: string; // absolute active project root
  // M10g: the real %APPDATA%/%LOCALAPPDATA% roots on Windows (undefined on
  // mac/linux, and off real Windows in tests that don't exercise a template's
  // `windows` override). A catalog entry's `windows` override resolves
  // against these instead of `home` for the one confirmed case (opencode)
  // where a CLI's Windows global config lives outside the dotfile-under-home
  // pattern every other adapter uses.
  appDataRoaming?: string | null;
  appDataLocal?: string | null;
};

// Build the stable artifact id. Kept in one place so the id format never drifts
// between the scanner and any future consumer that reconstructs it.
export function artifactId(
  cli: string,
  scope: HarnessScope,
  kind: ArtifactKind,
  relpath: string,
): string {
  return `${cli}:${scope}:${kind}:${relpath}`;
}
