import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type {
  ConfigDirEntry,
  ConfigFileHash,
  ConfigIpc,
  KodSkillsPackBundle,
} from "../ipc/contract";
import type { ConfigInstallFile } from "../ipc/contract";
import { nativeJoin } from "../platform/native-path";
import { RELEASE_MANIFEST } from "../release/manifest";
import type { ScanContext } from "./model";
import type { HarnessChangeRequest } from "./contract";
import {
  resolveSkillInstallTargets,
  type ManagedSkillTarget,
} from "./skill-targets";

export const KODSKILLS_SOURCE = "https://github.com/ContractorKeith/skills";
export const KODSKILLS_TAG = "v1.0.0";
export const KODSKILLS_SHA = "000087d6fc70e92fc91eb40b89b0c62a67ebc78a";
export const KODSKILLS_MARKER = ".kodskills.json";

export type KodSkillsFile = ConfigFileHash & { contents: string };
export type KodSkill = {
  id: string;
  dir: string;
  description: string;
  files: KodSkillsFile[];
};
export type KodSkillsPack = {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  tag: string;
  sha: string;
  skills: KodSkill[];
};
export type KodSkillsTarget = ManagedSkillTarget;
export type KodSkillsCellStatus =
  | "ready"
  | "installed"
  | "update"
  | "conflict"
  | "modified"
  | "external"
  | "unreadable";
export type KodSkillsCell = {
  skillId: string;
  targetId: string;
  targetPath: string;
  installedPath: string;
  status: KodSkillsCellStatus;
  eligible: boolean;
  reason: string;
  snapshot?: ConfigFileHash[];
};
export type KodSkillsModel = {
  pack: KodSkillsPack;
  targets: KodSkillsTarget[];
  cells: KodSkillsCell[];
};
export type KodSkillsAction = "install" | "update" | "uninstall";
export type KodSkillsPlannedRequest = {
  cli: string;
  title: string;
  request: HarnessChangeRequest;
};

type RawManifest = {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  description?: unknown;
  source?: unknown;
  tag?: unknown;
  sha?: unknown;
  skills?: unknown;
};

function hashText(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function safeSegment(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`invalid KödSkills ${label}`);
  }
  return value;
}

function safeRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid KödSkills file path: ${String(value)}`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid KödSkills ${label}`);
  }
  return value;
}

// Parse and independently verify the bundle before any target is inspected or
// any mutation can be planned. The manifest is the declaration; bundled bytes
// must match it exactly with no missing or undeclared skill files.
export function parseKodSkillsBundle(bundle: KodSkillsPackBundle): KodSkillsPack {
  let raw: RawManifest;
  try {
    raw = JSON.parse(bundle.manifest) as RawManifest;
  } catch {
    throw new Error("KödSkills pack manifest is not valid JSON");
  }
  const source = requiredString(raw.source, "source");
  const tag = requiredString(raw.tag, "tag");
  const commit = requiredString(raw.sha, "sha");
  if (source !== KODSKILLS_SOURCE || tag !== KODSKILLS_TAG || commit !== KODSKILLS_SHA) {
    throw new Error("KödSkills pack source does not match the pinned release");
  }
  if (!Array.isArray(raw.skills)) throw new Error("KödSkills manifest has no skills list");

  const bundled = new Map<string, string>();
  for (const file of bundle.files) {
    const path = safeRelativePath(file.path);
    if (bundled.has(path)) throw new Error(`duplicate vendored file: ${path}`);
    bundled.set(path, file.contents);
  }
  const declared = new Set<string>();
  const skills: KodSkill[] = raw.skills.map((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid KödSkills skill entry");
    const record = value as Record<string, unknown>;
    const id = safeSegment(record.id, "skill id");
    const dir = safeSegment(record.dir, "skill dir");
    if (id !== dir) throw new Error(`KödSkills skill id and dir differ: ${id}`);
    if (!Array.isArray(record.files) || record.files.length === 0) {
      throw new Error(`KödSkills skill ${id} has no files`);
    }
    const files = record.files.map((fileValue) => {
      if (!fileValue || typeof fileValue !== "object") {
        throw new Error(`invalid file entry for ${id}`);
      }
      const file = fileValue as Record<string, unknown>;
      const path = safeRelativePath(file.path);
      const expected = requiredString(file.sha256, `hash for ${id}/${path}`);
      const bundlePath = `skills/${dir}/${path}`;
      const contents = bundled.get(bundlePath);
      if (contents === undefined) throw new Error(`missing vendored file: ${bundlePath}`);
      const actual = hashText(contents);
      if (actual !== expected) throw new Error(`hash mismatch for vendored file: ${bundlePath}`);
      declared.add(bundlePath);
      return { path, sha256: expected, contents };
    });
    return {
      id,
      dir,
      description: requiredString(record.description, `description for ${id}`),
      files,
    };
  });
  for (const path of bundled.keys()) {
    if (!declared.has(path)) throw new Error(`undeclared vendored file: ${path}`);
  }
  return {
    id: safeSegment(raw.id, "pack id"),
    name: requiredString(raw.name, "name"),
    version: requiredString(raw.version, "version"),
    description: requiredString(raw.description, "description"),
    source,
    tag,
    sha: commit,
    skills,
  };
}

// KödSkills is global CLI setup. Discovery may include legacy and compatibility
// roots, but app-managed installs use each provider's preferred catalog target.
// Physical targets are deduplicated before any plans are built.
export function resolveKodSkillsTargets(ctx: ScanContext, pro: boolean): KodSkillsTarget[] {
  const ownerIds = pro
    ? [
        "claude",
        "codex",
        ...(RELEASE_MANIFEST.features.local ? ["kodade-local"] : []),
      ]
    : ["claude"];
  return resolveSkillInstallTargets(
    "global",
    ctx,
    ownerIds,
  );
}

type Provenance = {
  schemaVersion: 1;
  pack: string;
  packVersion: string;
  skillId: string;
  files: ConfigFileHash[];
};

function parseMarker(text: string, pack: KodSkillsPack, skill: KodSkill): Provenance | null {
  try {
    const marker = JSON.parse(text) as Provenance;
    if (
      marker.schemaVersion !== 1 ||
      marker.pack !== pack.id ||
      marker.skillId !== skill.id ||
      typeof marker.packVersion !== "string" ||
      !Array.isArray(marker.files)
    ) return null;
    // A marker is only provenance when its hashes match a version actually
    // present in the vendored manifest. Today pack.json carries one known
    // version, so compare against that version's declared skill hashes.
    if (!equalFiles(marker.files, skill.files)) {
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}

function equalFiles(actual: ConfigFileHash[], expected: ConfigFileHash[]): boolean {
  const normalize = (files: ConfigFileHash[]) =>
    [...files].sort((a, b) => a.path.localeCompare(b.path));
  const left = normalize(actual);
  const right = normalize(expected);
  return left.length === right.length && left.every(
    (file, index) => file.path === right[index].path && file.sha256 === right[index].sha256,
  );
}

function versionParts(version: string): number[] | null {
  if (!/^\d+(?:\.\d+){1,2}$/.test(version)) return null;
  return version.split(".").map(Number);
}

function newerThan(next: string, current: string): boolean {
  const a = versionParts(next);
  const b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function namedEntry(entries: ConfigDirEntry[], id: string): ConfigDirEntry | undefined {
  return entries.find((entry) => entry.name === id || entry.name === `${id}.disabled`);
}

async function inspectExisting(
  config: ConfigIpc,
  projectRoot: string,
  pack: KodSkillsPack,
  skill: KodSkill,
  target: KodSkillsTarget,
  entry: ConfigDirEntry,
): Promise<KodSkillsCell> {
  const base = {
    skillId: skill.id,
    targetId: target.id,
    targetPath: target.path,
    installedPath: entry.path,
  };
  if (entry.isSymlink) {
    return {
      ...base,
      status: "external",
      eligible: false,
      reason: entry.orphaned
        ? "broken symlink — fix before installing"
        : "existing symlink — managed externally",
    };
  }
  const markerEntry = entry.children?.find((child) => child.name === KODSKILLS_MARKER);
  if (!markerEntry) {
    return { ...base, status: "conflict", eligible: false, reason: "conflicts with existing skill" };
  }
  let marker: Provenance | null = null;
  try {
    const read = await config.read(markerEntry.path, projectRoot);
    marker = read.kind === "text" ? parseMarker(read.content, pack, skill) : null;
  } catch {
    marker = null;
  }
  if (!marker) {
    return { ...base, status: "conflict", eligible: false, reason: "conflicts with existing skill" };
  }
  const snapshot = await config.dirSnapshot(entry.path, projectRoot);
  if (snapshot.status !== "snapshot") {
    return { ...base, status: "modified", eligible: false, reason: "modified locally" };
  }
  const withoutMarker = snapshot.files.filter((file) => file.path !== KODSKILLS_MARKER);
  if (!equalFiles(withoutMarker, marker.files)) {
    return { ...base, snapshot: snapshot.files, status: "modified", eligible: false, reason: "modified locally" };
  }
  if (newerThan(pack.version, marker.packVersion)) {
    return { ...base, snapshot: snapshot.files, status: "update", eligible: true, reason: "update available" };
  }
  return { ...base, snapshot: snapshot.files, status: "installed", eligible: true, reason: "already installed" };
}

// Inspect every skill/physical target pair. Reads only: this is the model the
// picker renders and the immutable input later batch planning revalidates.
export async function inspectKodSkills(
  config: ConfigIpc,
  ctx: ScanContext,
  pro: boolean,
): Promise<KodSkillsModel> {
  const pack = parseKodSkillsBundle(await config.kodSkillsPackRead());
  const targets = resolveKodSkillsTargets(ctx, pro);
  const cells: KodSkillsCell[] = [];
  for (const target of targets) {
    const scan = await config.scan(target.path, ctx.projectRoot);
    if ("rootIsSymlink" in scan && scan.rootIsSymlink) {
      for (const skill of pack.skills) {
        cells.push({
          skillId: skill.id,
          targetId: target.id,
          targetPath: target.path,
          installedPath: nativeJoin(target.path, skill.dir),
          status: "external",
          eligible: false,
          reason: "skills dir is symlinked — managed externally",
        });
      }
      continue;
    }
    if (scan.status === "unreadable") {
      for (const skill of pack.skills) {
        cells.push({
          skillId: skill.id,
          targetId: target.id,
          targetPath: target.path,
          installedPath: nativeJoin(target.path, skill.dir),
          status: "unreadable",
          eligible: false,
          reason: scan.error,
        });
      }
      continue;
    }
    const entries = scan.status === "listing" ? scan.entries : [];
    for (const skill of pack.skills) {
      const entry = namedEntry(entries, skill.id);
      if (entry) {
        cells.push(await inspectExisting(config, ctx.projectRoot, pack, skill, target, entry));
      } else {
        cells.push({
          skillId: skill.id,
          targetId: target.id,
          targetPath: target.path,
          installedPath: nativeJoin(target.path, skill.dir),
          status: "ready",
          eligible: true,
          reason: "ready to install",
        });
      }
    }
  }
  return { pack, targets, cells };
}

function markerFor(pack: KodSkillsPack, skill: KodSkill): ConfigInstallFile {
  const contents = `${JSON.stringify(
    {
      schemaVersion: 1,
      pack: pack.id,
      packVersion: pack.version,
      skillId: skill.id,
      files: skill.files.map(({ path, sha256 }) => ({ path, sha256 })),
    },
    null,
    2,
  )}\n`;
  return { path: KODSKILLS_MARKER, contents, sha256: hashText(contents) };
}

function eligibleFor(action: KodSkillsAction, status: KodSkillsCellStatus): boolean {
  if (action === "install") return status === "ready";
  if (action === "update") return status === "update";
  return status === "installed" || status === "update";
}

// Turn picker selections into adapter requests. Ineligible cells are skipped,
// which is the last product-logic gate before each adapter independently
// validates and plans its filesystem change.
export function buildKodSkillsRequests(
  model: KodSkillsModel,
  action: KodSkillsAction,
  selectedSkillIds: readonly string[],
  selectedTargetIds: readonly string[],
  projectRoot: string,
  pro: boolean,
): KodSkillsPlannedRequest[] {
  const selectedSkills = new Set(selectedSkillIds);
  const selectedTargets = new Set(selectedTargetIds);
  const requests: KodSkillsPlannedRequest[] = [];
  for (const cell of model.cells) {
    if (
      !selectedSkills.has(cell.skillId) ||
      !selectedTargets.has(cell.targetId) ||
      !eligibleFor(action, cell.status)
    ) continue;
    const skill = model.pack.skills.find((candidate) => candidate.id === cell.skillId);
    const target = model.targets.find((candidate) => candidate.id === cell.targetId);
    if (!skill || !target) continue;
    if (
      !pro &&
      (action === "update" || target.cli !== "claude")
    ) continue;
    const operation = action === "uninstall" ? "remove" : action;
    const files = operation === "remove" ? undefined : [
      ...skill.files.map(({ path, contents, sha256 }) => ({ path, contents, sha256 })),
      markerFor(model.pack, skill),
    ];
    requests.push({
      cli: target.cli,
      title: `${action} ${skill.id} for ${target.clis.join(" + ")}`,
      request: {
        artifactId: `${target.cli}:global:skill:${skill.id}`,
        action: operation === "remove" ? "remove-skill" : `${operation}-skill`,
        projectRoot,
        payload: {
          skillId: skill.id,
          targetPath: cell.installedPath,
          operation,
          files,
          expectedFiles: operation === "install" ? null : cell.snapshot ?? null,
        },
      },
    });
  }
  return requests;
}
