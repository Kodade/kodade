// The generic adapter engine. Detection and read-scanning are entirely
// data-driven from the catalog's HarnessLocations plus the pure scan.ts
// functions, so adding a CLI is a catalog edit plus a one-line adapter file
// (claude.ts / codex.ts). Mutation methods throw until M10d/M10e implement them.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ConfigIpc } from "../../ipc/contract";
import type {
  AddMcpServerPayload,
  ChangeReceipt,
  ConfigChange,
  HarnessAdapter,
  HarnessChangeRequest,
  InstructionEditPayload,
  RemoveFilePayload,
  SkillDirPayload,
  VerifyResult,
} from "../contract";
import { lineDiff, mergeMcpServer, removeMcpServer, type McpFormat } from "../merge";
import { nativeDirname } from "../../platform/native-path";
import { harnessReadHalf } from "./read";

// sha-256 of a string as lowercase hex — the same fingerprint Rust's config_write
// compares against for optimistic concurrency (sha256_hex there). Reuses the
// @noble/hashes already vendored for M9d licensing, so no new dependency.
function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

// KödHarness's portable disable mechanic: a reversible `.disabled` suffix on the
// skill/subagent entry (no CLI ships a disable switch). The same constant the
// pure scanner uses to detect a disabled entry.
const DISABLED_SUFFIX = ".disabled";

// The enable/disable target path: add the suffix to disable, strip it to enable.
// Idempotent — disabling an already-disabled path (or enabling an enabled one)
// returns the path unchanged, and plan() guards against that no-op.
function togglePath(before: string, action: "enable" | "disable"): string {
  if (action === "disable") {
    return before.endsWith(DISABLED_SUFFIX) ? before : `${before}${DISABLED_SUFFIX}`;
  }
  return before.endsWith(DISABLED_SUFFIX)
    ? before.slice(0, -DISABLED_SUFFIX.length)
    : before;
}

// A cheap, dependency-free content fingerprint (FNV-1a, 32-bit hex). Only used
// to confirm a single-file skill's bytes survived a rename — an equality check,
// not a security boundary (the Rust config_write uses real sha-256 for the
// optimistic-concurrency guard). Keeping it here avoids a Web Crypto / async
// dependency in the headless store path.
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

type OptionalText = { exists: boolean; text: string };

async function readOptionalText(
  config: ConfigIpc,
  path: string,
  projectRoot: string,
): Promise<OptionalText> {
  const text = await config.readOptionalText(path, projectRoot);
  return { exists: text !== null, text: text ?? "" };
}

// Read one artifact's current text (for the pre-rename fingerprint), or null for
// a directory skill / unreadable path. A guard rejection or dir read resolves to
// null, so apply treats it as "no byte fingerprint" (a dir rename).
async function readText(
  config: ConfigIpc,
  path: string,
  projectRoot: string,
): Promise<string | null> {
  try {
    const read = await config.read(path, projectRoot);
    return read.kind === "text" ? read.content : null;
  } catch {
    return null;
  }
}

// Build an adapter for one CLI over the injected ConfigIpc. detect() reads the
// CLI's catalog templates; scan() dispatches each location to the matching pure
// scanner. Both are the M10a read half.
export function createHarnessAdapter(
  cli: string,
  config: ConfigIpc,
  now: () => number = Date.now,
): HarnessAdapter {
  return {
    ...harnessReadHalf(cli, config),

    // --- Reversible mutation half (M10d dir-rename + M10e byte writes) ---
    //
    // Three change kinds, one discipline: plan never touches disk; apply is the
    // sole writer; verify rescans/re-reads; restore inverts. A `dir-rename`
    // (M10d skills enable/disable) toggles a `.disabled` suffix. A `markdown`
    // (M10e instruction edit) or structured `json`/`jsonc`/`toml` (M10e MCP
    // safe-merge) change writes bytes through the guarded config_write, backing
    // up the prior file first.

    async plan(change: HarnessChangeRequest): Promise<ConfigChange> {
      switch (change.action) {
        case "enable":
        case "disable":
          return planToggle(change);
        case "edit":
          return planEdit(config, change);
        case "remove-file":
          return planRemoveFile(config, change);
        case "add-mcp-server":
          return planAddMcpServer(config, change);
        case "remove-mcp-server":
          return planRemoveMcpServer(config, change);
        case "install-skill":
        case "update-skill":
        case "remove-skill":
          return planSkillDir(change);
        default:
          throw new Error(`harness.plan does not implement "${change.action}"`);
      }
    },

    async apply(change: ConfigChange): Promise<ChangeReceipt> {
      if (change.format === "skill-dir") {
        const operation = change.skillOperation;
        if (!operation || !change.expectedFiles && operation !== "install") {
          throw new Error("invalid KödSkills directory change");
        }
        const backupPath = operation === "remove"
          ? await config.removeDir(
              change.path,
              change.expectedFiles ?? [],
              change.projectRoot,
              true,
            )
          : await config.installDir(
              change.path,
              change.files ?? [],
              change.expectedFiles ?? null,
              change.projectRoot,
            );
        return {
          path: change.path,
          backupPath,
          appliedAt: now(),
          hash: "",
          change,
        };
      }
      // A dir-rename is the M10d path: no bytes written, the inverse rename is the
      // restore. A byte write (markdown edit / structured merge) goes through the
      // guarded config_write, which backs up the prior file and enforces the
      // optimistic-concurrency hash.
      if (change.format === "dir-rename") {
        // Fingerprint the current bytes BEFORE renaming so verify can confirm a
        // single-file skill survived byte-for-byte. A directory skill reads as
        // null and carries an empty fingerprint.
        const priorText = await readText(config, change.before, change.projectRoot);
        const hash = priorText === null ? "" : fingerprint(priorText);
        await config.rename(change.before, change.after, change.projectRoot);
        return { path: change.after, backupPath: "", appliedAt: now(), hash, change };
      }
      if (change.fileOperation === "remove") {
        const backupPath = await config.backup(change.path, change.projectRoot);
        await config.removeFile(
          change.path,
          change.expectedHash ?? "",
          change.projectRoot,
        );
        return {
          path: change.path,
          backupPath,
          appliedAt: now(),
          hash: "",
          change,
        };
      }
      const backupPath = await config.write(
        change.path,
        change.after,
        change.expectedHash ?? "",
        change.projectRoot,
      );
      // The receipt's hash fingerprints the bytes we wrote, so verify can confirm
      // the file on disk still matches the merge result (nothing raced the write).
      return {
        path: change.path,
        backupPath,
        appliedAt: now(),
        hash: fingerprint(change.after),
        change,
      };
    },

    async verify(receipt: ChangeReceipt): Promise<VerifyResult> {
      if (receipt.change.format === "skill-dir") {
        const snapshot = await config.dirSnapshot(receipt.path, receipt.change.projectRoot);
        if (receipt.change.skillOperation === "remove") {
          return snapshot.status === "missing"
            ? { ok: true }
            : { ok: false, reason: "the removed skill directory is still present" };
        }
        if (snapshot.status !== "snapshot") {
          return { ok: false, reason: "the installed skill directory could not be re-read" };
        }
        const expected = (receipt.change.files ?? []).map(({ path, sha256 }) => ({ path, sha256 }));
        return sameFileHashes(snapshot.files, expected)
          ? { ok: true }
          : { ok: false, reason: "the installed skill files do not match the planned pack" };
      }
      if (receipt.change.format !== "dir-rename") {
        if (receipt.change.fileOperation === "remove") {
          try {
            const current = await config.readOptionalText(
              receipt.path,
              receipt.change.projectRoot,
            );
            return current === null
              ? { ok: true }
              : { ok: false, reason: "the managed file is still present" };
          } catch {
            return { ok: false, reason: "the removed file state could not be verified" };
          }
        }
        // A byte write verifies by re-reading: the file must still be exactly the
        // bytes we merged. Any drift (a racing writer, a truncated write) fails,
        // and the store auto-restores from the backup the receipt carries.
        const text = await readText(config, receipt.path, receipt.change.projectRoot);
        if (text === null) {
          return { ok: false, reason: "the written config could not be re-read" };
        }
        if (fingerprint(text) !== receipt.hash) {
          return { ok: false, reason: "the config on disk does not match what was written" };
        }
        return { ok: true };
      }
      const { change, hash } = receipt;
      const dir = nativeDirname(change.after);
      if (!dir) return { ok: false, reason: "could not resolve the artifact's directory" };
      const scan = await config.scan(dir, change.projectRoot);
      if (scan.status !== "listing") {
        return { ok: false, reason: `could not rescan ${dir} (${scan.status})` };
      }
      const renamed = scan.entries.some((entry) => entry.path === change.after);
      const originalGone = !scan.entries.some((entry) => entry.path === change.before);
      if (!renamed) {
        return { ok: false, reason: "the renamed entry was not found after apply" };
      }
      if (!originalGone) {
        return { ok: false, reason: "the original entry still exists after apply" };
      }
      // Content survival: a single-file skill must hash identically after the
      // strip/add. A directory skill has no byte fingerprint — its presence at
      // the new path (with the source gone) is the survival evidence.
      if (hash) {
        const afterText = await readText(config, change.after, change.projectRoot);
        if (afterText === null) {
          return { ok: false, reason: "the renamed file could not be re-read" };
        }
        if (fingerprint(afterText) !== hash) {
          return { ok: false, reason: "the file's contents changed during the rename" };
        }
      }
      return { ok: true };
    },

    async restore(receipt: ChangeReceipt): Promise<void> {
      if (receipt.change.format === "skill-dir") {
        const desired = (receipt.change.files ?? []).map(({ path, sha256 }) => ({ path, sha256 }));
        if (receipt.change.skillOperation === "install") {
          await config.removeDir(receipt.path, desired, receipt.change.projectRoot, false);
          return;
        }
        await config.restoreDir(
          receipt.path,
          receipt.backupPath,
          receipt.change.skillOperation === "update" ? desired : null,
          receipt.change.projectRoot,
        );
        return;
      }
      if (receipt.change.format !== "dir-rename") {
        if (receipt.change.fileOperation === "remove") {
          await config.restore(
            receipt.path,
            receipt.backupPath,
            receipt.change.projectRoot,
          );
          return;
        }
        // A byte write restores from the prior backup. A brand-new file has no
        // backup, so remove only the exact bytes this receipt wrote.
        if (!receipt.backupPath) {
          await config.removeFile(
            receipt.path,
            sha256Hex(receipt.change.after),
            receipt.change.projectRoot,
          );
          return;
        }
        await config.restore(receipt.path, receipt.backupPath, receipt.change.projectRoot);
        return;
      }
      // Invert the rename: the reverse direction is itself a valid ± ".disabled"
      // rename, so the same guarded primitive restores the prior state.
      const { change } = receipt;
      await config.rename(change.after, change.before, change.projectRoot);
    },
  };
}

function sameFileHashes(
  left: { path: string; sha256: string }[],
  right: { path: string; sha256: string }[],
): boolean {
  const sorted = (files: { path: string; sha256: string }[]) =>
    [...files].sort((a, b) => a.path.localeCompare(b.path));
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every(
    (file, index) => file.path === b[index].path && file.sha256 === b[index].sha256,
  );
}

// --- M10d/M10e plan builders (pure over the injected ConfigIpc) ---

// M10d: the reversible `.disabled` toggle for a skill/subagent. Reads no disk —
// the rename target is derived from the artifact path.
function planToggle(change: HarnessChangeRequest): ConfigChange {
  const artifact = change.artifact;
  if (!artifact) {
    throw new Error("harness.plan needs the target artifact");
  }
  if (change.action !== "enable" && change.action !== "disable") {
    throw new Error(`planToggle called for "${change.action}"`);
  }
  if (artifact.kind !== "skill" && artifact.kind !== "subagent") {
    throw new Error(`only skills and subagents can be toggled, not ${artifact.kind}`);
  }
  // artifact.path is the entry itself — the LINK for a symlinked skill — so the
  // rename operates on the link, never writing through into a dotfiles target.
  const before = artifact.path;
  const after = togglePath(before, change.action);
  if (before === after) {
    throw new Error(`skill is already ${change.action}d`);
  }
  const verb = change.action;
  const via = artifact.source.via === "symlink" ? " (symlink — the link entry is renamed)" : "";
  return {
    path: before,
    format: "dir-rename",
    before,
    after,
    diff: [{ before, after, context: `${verb} ${artifact.name}${via}` }],
    backupPath: "", // the inverse rename IS the restore — no byte backup
    projectRoot: change.projectRoot,
  };
}

function planSkillDir(change: HarnessChangeRequest): ConfigChange {
  const payload = change.payload as SkillDirPayload | undefined;
  if (!payload || typeof payload.targetPath !== "string" || typeof payload.skillId !== "string") {
    throw new Error("KödSkills change needs a skill directory payload");
  }
  const expectedAction = `${payload.operation}-skill`;
  if (change.action !== expectedAction) {
    throw new Error(`KödSkills action does not match ${payload.operation}`);
  }
  if (payload.operation !== "remove" && (!payload.files || payload.files.length === 0)) {
    throw new Error(`KödSkills ${payload.operation} needs the complete skill files`);
  }
  if (payload.operation !== "install" && !payload.expectedFiles) {
    throw new Error(`KödSkills ${payload.operation} needs the installed file snapshot`);
  }
  const beforeFiles = payload.expectedFiles ?? [];
  const afterFiles = payload.operation === "remove" ? [] : payload.files ?? [];
  const paths = new Set([...beforeFiles.map((file) => file.path), ...afterFiles.map((file) => file.path)]);
  const before = new Map(beforeFiles.map((file) => [file.path, file.sha256]));
  const after = new Map(afterFiles.map((file) => [file.path, file.sha256]));
  const diff = [...paths]
    .sort()
    .filter((path) => before.get(path) !== after.get(path))
    .map((path) => ({
      before: before.has(path) ? `${path} ${before.get(path)}` : "",
      after: after.has(path) ? `${path} ${after.get(path)}` : "",
      context: `${payload.operation} ${payload.skillId}`,
    }));
  return {
    path: payload.targetPath,
    format: "skill-dir",
    before: payload.operation === "install" ? "absent" : `${beforeFiles.length} files`,
    after: payload.operation === "remove" ? "absent" : `${afterFiles.length} files`,
    diff,
    backupPath: "",
    projectRoot: change.projectRoot,
    skillOperation: payload.operation,
    files: payload.files,
    expectedFiles: payload.expectedFiles,
  };
}

// M10e: whole-file instruction edit through the guarded write surface. `plan`
// reads the CURRENT bytes to build the diff and the optimistic-concurrency hash,
// so a file that changed between read and apply is rejected by config_write. A
// full replace is safe here — it is the user's own instruction file, not a
// third-party structured config (those go through planAddMcpServer's merge).
async function planEdit(config: ConfigIpc, change: HarnessChangeRequest): Promise<ConfigChange> {
  const payload = change.payload as InstructionEditPayload | undefined;
  if (!payload || typeof payload.path !== "string" || typeof payload.newText !== "string") {
    throw new Error("edit needs a { path, newText } payload");
  }
  const current = await readOptionalText(config, payload.path, change.projectRoot);
  const before = current.text;
  const isNewFile = !current.exists;
  if (payload.expectedText !== undefined && before !== payload.expectedText) {
    throw new Error("instructions changed while Ködade was preparing the preview; review again");
  }
  if (before === payload.newText) {
    throw new Error("no changes to save");
  }
  return {
    path: payload.path,
    format: payload.format ?? "markdown",
    before,
    after: payload.newText,
    diff: lineDiff(before, payload.newText),
    backupPath: "", // config_write takes the backup at apply time
    projectRoot: change.projectRoot,
    expectedHash: isNewFile ? "" : sha256Hex(before),
    isNewFile,
  };
}

async function planRemoveFile(config: ConfigIpc, change: HarnessChangeRequest): Promise<ConfigChange> {
  const payload = change.payload as RemoveFilePayload | undefined;
  if (!payload || typeof payload.path !== "string" || typeof payload.expectedText !== "string") {
    throw new Error("remove-file needs a { path, format, expectedText } payload");
  }
  const current = await readOptionalText(config, payload.path, change.projectRoot);
  if (!current.exists) throw new Error("the managed file is already absent");
  if (current.text !== payload.expectedText) {
    throw new Error("the managed file changed while Ködade was preparing the preview; review again");
  }
  return {
    path: payload.path,
    format: payload.format,
    before: current.text,
    after: "",
    diff: lineDiff(current.text, ""),
    backupPath: "",
    projectRoot: change.projectRoot,
    expectedHash: sha256Hex(current.text),
    isNewFile: false,
    fileOperation: "remove",
  };
}

// M10e: the format-preserving MCP safe-merge. Reads the target config, delegates
// the single-key merge + invariant assertion to merge.ts, and packages the result
// as a ConfigChange the shared preview/apply surface consumes. A corrupt source or
// a duplicate/over-broad merge throws here, before anything is staged for apply.
async function planAddMcpServer(
  config: ConfigIpc,
  change: HarnessChangeRequest,
): Promise<ConfigChange> {
  const payload = change.payload as AddMcpServerPayload | undefined;
  if (!payload || typeof payload.path !== "string" || !payload.server) {
    throw new Error("add-mcp-server needs a { path, format, keyPath, server } payload");
  }
  const current = await readOptionalText(config, payload.path, change.projectRoot);
  const before = current.text;
  if (
    payload.expectedText !== undefined &&
    (before !== payload.expectedText || current.exists === payload.expectedMissing)
  ) {
    throw new Error("MCP config changed while Ködade was preparing the preview; review again");
  }
  const merge = mergeMcpServer(before, payload.format as McpFormat, payload.keyPath, payload.server);
  return {
    path: payload.path,
    format: payload.format,
    before,
    after: merge.after,
    diff: merge.diff,
    backupPath: "", // config_write takes the backup at apply time
    projectRoot: change.projectRoot,
    touchedKeys: [merge.touchedKey],
    mcpOperation: merge.operation,
    expectedHash: current.exists ? sha256Hex(before) : "",
    isNewFile: !current.exists,
  };
}

async function planRemoveMcpServer(
  config: ConfigIpc,
  change: HarnessChangeRequest,
): Promise<ConfigChange> {
  const payload = change.payload as AddMcpServerPayload | undefined;
  if (!payload || typeof payload.path !== "string" || !payload.server) {
    throw new Error("remove-mcp-server needs a { path, format, keyPath, server } payload");
  }
  const current = await readOptionalText(config, payload.path, change.projectRoot);
  if (!current.exists) throw new Error("the managed MCP config is not present");
  if (
    payload.expectedText !== undefined &&
    (current.text !== payload.expectedText || payload.expectedMissing === true)
  ) {
    throw new Error("MCP config changed while Ködade was preparing the preview; review again");
  }
  const merge = removeMcpServer(
    current.text,
    payload.format as McpFormat,
    payload.keyPath,
    payload.server,
  );
  return {
    path: payload.path,
    format: payload.format,
    before: current.text,
    after: merge.after,
    diff: merge.diff,
    backupPath: "",
    projectRoot: change.projectRoot,
    touchedKeys: [merge.touchedKey],
    mcpOperation: "remove",
    expectedHash: sha256Hex(current.text),
    isNewFile: false,
  };
}
