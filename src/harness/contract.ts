// The shared adapter contract for harness inspection and mutation. It is
// imported by KödHarness AND by M8's KödMCP client-setup module — both mutate
// third-party config under the same detect → plan → apply → verify → restore
// discipline, so the contract is defined once here.
//
// M10a implements only the read half (detect + scan) in the Claude and Codex
// adapters. plan/apply/verify/restore are declared so downstream milestones
// (M10d mutation, M10e MCP merge) and M8 slot in without a second contract;
// M10a adapters throw "not implemented in M10a" for those.

import type {
  ArtifactKind,
  HarnessArtifact,
  HarnessScanError,
  HarnessScope,
  ScanContext,
} from "./model";
import type { McpKeyPath } from "./merge";
import type { ConfigFileHash, ConfigInstallFile } from "../ipc/contract";

// One place an adapter looks for artifacts. A "file" location is read whole (an
// instruction file, an MCP config); a "dir" location is enumerated (a skills or
// subagents directory). Resolved from a catalog PathTemplate at detect time, so
// the path is already absolute and OS-correct.
export type ArtifactLocation = {
  cli: string;
  scope: HarnessScope;
  kind: ArtifactKind;
  container: "file" | "dir";
  path: string; // absolute, resolved from template + ScanContext
  format?: "markdown" | "json" | "jsonc" | "toml"; // file locations only
  mcpKeyPath?: string; // catalog locations use one static server-map key
};

// Artifacts plus the optional error from scanning one location.
//
// Deviation from the plan sketch (`scan(): Promise<HarnessArtifact[]>`): scan
// returns this envelope so an unreadable location's HarnessScanError reaches
// the inventory without a side channel. The alternative — a phantom
// status:"unreadable" artifact — would pollute the artifact list, so a small,
// explicit result type is the honest shape.
export type LocationScan = {
  artifacts: HarnessArtifact[];
  error: HarnessScanError | null;
};

// --- Mutation types (declared now, implemented M10d/M10e) ---

// One hunk of a proposed change, enough to render a diff preview. Minimal for
// now; the mutation milestones flesh this out.
export type DiffHunk = {
  before: string;
  after: string;
  context?: string;
};

// A proposed change produced by `plan` — never touches disk. For structured
// third-party configs `after` is a MERGE result (format-preserving), never a
// whole-file replace, and `touchedKeys` records exactly which keys changed so
// `apply` can reject an over-broad diff. For a `dir-rename` (M10d skills
// enable/disable) `before`/`after` are the old/new PATHS and no byte backup is
// needed — the inverse rename IS the restore.
export type ConfigChange = {
  path: string;
  format: "markdown" | "json" | "jsonc" | "toml" | "dir-rename" | "skill-dir";
  before: string; // current bytes (or, for dir-rename, the old path)
  after: string; // merge result (or, for dir-rename, the new path)
  diff: DiffHunk[];
  backupPath: string;
  touchedKeys?: string[];
  // An existing MCP entry is only updated after the merge layer proves it uses
  // the same Ködade command path; the preview must distinguish that from adding.
  mcpOperation?: "add" | "update" | "remove";
  fileOperation?: "write" | "remove";
  // M10d: the guarded config IPC authorizes writes per project root, so a change
  // carries it end-to-end (apply/verify/restore all call guarded commands). The
  // plan sketch predated the per-call projectRoot allowlist.
  projectRoot: string;
  // M10e (byte-write changes — markdown edit, structured MCP merge): the sha-256
  // the file was read at, for config_write's optimistic-concurrency guard. "" for
  // a brand-new file (no prior bytes); absent for a dir-rename (no byte write).
  expectedHash?: string;
  // M10e: true when the write CREATES the file (no prior version on disk), so
  // restore removes only the exact bytes written instead of looking for a backup.
  isNewFile?: boolean;
  // M15: an atomic whole-skill-directory mutation. Install has no expected
  // prior files; update/remove carry the exact inspected snapshot for
  // optimistic concurrency. Install/update include the complete desired tree.
  skillOperation?: "install" | "update" | "remove";
  files?: ConfigInstallFile[];
  expectedFiles?: ConfigFileHash[] | null;
};

// The receipt `apply` returns and `verify`/`restore` consume. For a dir-rename
// the receipt keeps the whole originating change (so verify can rescan the new
// location and restore can invert the rename) plus a content fingerprint —
// non-empty for a single-file skill, "" for a directory — that verify uses to
// confirm the bytes survived the rename.
export type ChangeReceipt = {
  path: string; // the path after apply (renamed entry / written file)
  backupPath: string;
  appliedAt: number;
  hash: string; // content fingerprint of a file artifact, "" for a dir rename
  change: ConfigChange;
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

// Payload for action "edit" (M10e): the full new text of an instruction file.
// `plan` reads the file's current bytes itself (for the diff and the
// optimistic-concurrency hash), so the request only needs the target path and the
// replacement text. The path may sit OUTSIDE the project root (a global-scope
// CLAUDE.md), which is exactly why this routes through the configguard write
// surface rather than the pathguard-confined file editor.
export type InstructionEditPayload = {
  path: string;
  newText: string;
  format?: "markdown" | "json" | "jsonc" | "toml";
  // Optional plan-time ownership guard. Managed workflows use this to refuse
  // replacing instruction bytes that drifted before preview construction.
  expectedText?: string;
  expectedMissing?: boolean;
};

export type RemoveFilePayload = {
  path: string;
  expectedText: string;
  expectedMissing: boolean;
  format: "markdown" | "json" | "jsonc" | "toml";
};

// Payload for action "add-mcp-server" (M10e): which config file to merge into
// (path + format + the key holding the server map, all from the CLI's catalog MCP
// location) and the one server to add. Carried on the request so the adapter
// merges without a second store round-trip — M8's client setup builds the same
// shape.
export type McpServerPayload = {
  path: string;
  format: "json" | "jsonc" | "toml";
  keyPath: McpKeyPath;
  server: { name: string; config: Record<string, unknown> };
  expectedText?: string;
  expectedMissing?: boolean;
};

export type AddMcpServerPayload = McpServerPayload;

export type SkillDirPayload = {
  skillId: string;
  targetPath: string;
  operation: "install" | "update" | "remove";
  files?: ConfigInstallFile[];
  expectedFiles: ConfigFileHash[] | null;
};

// A user's request to change one artifact (enable/disable, edit, add/remove an
// MCP server). M10d pins enable/disable: it carries the target artifact and the
// guarded projectRoot so `plan` can build the ConfigChange without a store
// round-trip. `payload` carries the M10e structured actions' input (typed above).
export type HarnessChangeRequest = {
  artifactId: string;
  action:
    | "enable"
    | "disable"
    | "edit"
    | "remove-file"
    | "add-mcp-server"
    | "remove-mcp-server"
    | "install-skill"
    | "update-skill"
    | "remove-skill";
  projectRoot: string;
  artifact?: HarnessArtifact;
  payload?: InstructionEditPayload | RemoveFilePayload | AddMcpServerPayload | unknown;
};

// The contract every CLI adapter satisfies. detect/scan are the read half
// (M10a); the rest are the reversible mutation half (later milestones).
export interface HarnessAdapter {
  readonly cli: string;
  detect(scope: HarnessScope, ctx: ScanContext): Promise<ArtifactLocation[]>;
  scan(loc: ArtifactLocation, ctx: ScanContext): Promise<LocationScan>;
  plan(change: HarnessChangeRequest): Promise<ConfigChange>; // never mutates
  apply(change: ConfigChange): Promise<ChangeReceipt>; // sole writer
  verify(receipt: ChangeReceipt): Promise<VerifyResult>;
  restore(receipt: ChangeReceipt): Promise<void>;
}
