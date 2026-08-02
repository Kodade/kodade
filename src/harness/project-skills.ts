import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type {
  ConfigDirEntry,
  ConfigFileHash,
  ConfigInstallFile,
  ConfigIpc,
  ProjectSkillSourceBundle,
} from "../ipc/contract";
import { nativeJoin } from "../platform/native-path";
import type { HarnessChangeRequest } from "./contract";
import type { ScanContext } from "./model";
import { KODADE_PROJECT_SKILL_MARKER } from "./skill-identity";
import {
  resolveSkillInstallTargets,
  type ManagedSkillTarget,
} from "./skill-targets";

export type ProjectSkill = {
  id: string;
  description: string;
  sourceRoot: string;
  sourceHash: string;
  files: ConfigInstallFile[];
};

export type ProjectSkillTarget = ManagedSkillTarget;

export type ProjectSkillCellStatus =
  | "ready"
  | "installed"
  | "update"
  | "conflict"
  | "modified"
  | "external"
  | "unreadable";

export type ProjectSkillCell = {
  targetId: string;
  targetPath: string;
  installedPath: string;
  status: ProjectSkillCellStatus;
  eligible: boolean;
  reason: string;
  snapshot?: ConfigFileHash[];
};

export type ProjectSkillModel = {
  skill: ProjectSkill;
  targets: ProjectSkillTarget[];
  cells: ProjectSkillCell[];
};

export type ProjectSkillAction = "install" | "update" | "uninstall";
export type ProjectSkillPlannedRequest = {
  cli: string;
  title: string;
  request: HarnessChangeRequest;
};

type ProjectSkillMarker = {
  schemaVersion: 1;
  managedBy: "kodade";
  skillId: string;
  sourceHash: string;
  files: ConfigFileHash[];
};

function hashText(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function ordered<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

function safeRelativePath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid project skill file path: ${path}`);
  }
  return path;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function manifestMetadata(contents: string): { name: string; description: string } {
  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") throw new Error("SKILL.md must start with YAML frontmatter");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("SKILL.md frontmatter is not closed");
  let name = "";
  let description = "";
  const frontmatter = lines.slice(1, end);
  for (let index = 0; index < frontmatter.length; index++) {
    const line = frontmatter[index];
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) name = scalar(nameMatch[1]);
    const descriptionMatch = line.match(/^description:\s*(.+)$/);
    if (descriptionMatch) {
      const value = scalar(descriptionMatch[1]);
      if (/^[>|]-?$/.test(value)) {
        const continuation: string[] = [];
        while (
          index + 1 < frontmatter.length &&
          /^[ \t]+/.test(frontmatter[index + 1])
        ) {
          continuation.push(frontmatter[++index].trim());
        }
        description = value.startsWith("|")
          ? continuation.join("\n").trim()
          : continuation.join(" ").trim();
      } else {
        description = value;
      }
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("SKILL.md needs a portable skill name (lowercase letters, numbers, and hyphens)");
  }
  if (!description) {
    throw new Error("SKILL.md needs a description");
  }
  return { name, description };
}

export function parseProjectSkillBundle(bundle: ProjectSkillSourceBundle): ProjectSkill {
  if (!bundle.root) throw new Error("selected skill folder has no path");
  const seen = new Set<string>();
  const files = ordered(bundle.files.map((file) => {
    const path = safeRelativePath(file.path);
    if (seen.has(path)) throw new Error(`duplicate project skill file: ${path}`);
    if (path === KODADE_PROJECT_SKILL_MARKER || path === ".kodskills.json") {
      throw new Error(`project skill source contains reserved metadata: ${path}`);
    }
    seen.add(path);
    return { path, contents: file.contents, sha256: hashText(file.contents) };
  }));
  const manifest = files.find((file) => file.path === "SKILL.md");
  if (!manifest) throw new Error("selected folder must contain SKILL.md at its root");
  const metadata = manifestMetadata(manifest.contents);
  const sourceHash = hashText(JSON.stringify(
    files.map(({ path, sha256: fileHash }) => ({ path, sha256: fileHash })),
  ));
  return {
    id: metadata.name,
    description: metadata.description,
    sourceRoot: bundle.root,
    sourceHash,
    files,
  };
}

export function resolveProjectSkillTargets(
  ctx: ScanContext,
  pro: boolean,
  ownerIds?: readonly string[],
): ProjectSkillTarget[] {
  return resolveSkillInstallTargets(
    "project",
    ctx,
    ownerIds ?? (pro ? ["claude", "codex"] : ["claude"]),
  );
}

function markerContents(skill: ProjectSkill): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      managedBy: "kodade",
      skillId: skill.id,
      sourceHash: skill.sourceHash,
      files: skill.files.map(({ path, sha256: fileHash }) => ({ path, sha256: fileHash })),
    } satisfies ProjectSkillMarker,
    null,
    2,
  )}\n`;
}

function installFiles(skill: ProjectSkill): ConfigInstallFile[] {
  const contents = markerContents(skill);
  return [
    ...skill.files,
    { path: KODADE_PROJECT_SKILL_MARKER, contents, sha256: hashText(contents) },
  ];
}

function parseMarker(contents: string, skillId: string): ProjectSkillMarker | null {
  try {
    const marker = JSON.parse(contents) as ProjectSkillMarker;
    if (
      marker.schemaVersion !== 1 ||
      marker.managedBy !== "kodade" ||
      marker.skillId !== skillId ||
      typeof marker.sourceHash !== "string" ||
      !Array.isArray(marker.files)
    ) {
      return null;
    }
    const files = marker.files.map((file) => ({
      path: safeRelativePath(file.path),
      sha256: file.sha256,
    }));
    if (files.some((file) => typeof file.sha256 !== "string" || !file.sha256)) return null;
    return { ...marker, files: ordered(files) };
  } catch {
    return null;
  }
}

function equalFiles(actual: readonly ConfigFileHash[], expected: readonly ConfigFileHash[]): boolean {
  const left = ordered(actual);
  const right = ordered(expected);
  return left.length === right.length && left.every(
    (file, index) => file.path === right[index].path && file.sha256 === right[index].sha256,
  );
}

function namedEntry(entries: ConfigDirEntry[], id: string): ConfigDirEntry | undefined {
  return entries.find((entry) => entry.name === id || entry.name === `${id}.disabled`);
}

async function inspectExisting(
  config: ConfigIpc,
  projectRoot: string,
  skill: ProjectSkill,
  target: ProjectSkillTarget,
  entry: ConfigDirEntry,
): Promise<ProjectSkillCell> {
  const base = {
    targetId: target.id,
    targetPath: target.path,
    installedPath: entry.path,
  };
  if (entry.isSymlink) {
    return {
      ...base,
      status: "external",
      eligible: false,
      reason: entry.orphaned ? "broken symlink — managed externally" : "symlink — managed externally",
    };
  }
  const markerEntry = entry.children?.find(
    (child) => child.name === KODADE_PROJECT_SKILL_MARKER,
  );
  if (!markerEntry) {
    return { ...base, status: "conflict", eligible: false, reason: "conflicts with existing skill" };
  }
  let marker: ProjectSkillMarker | null = null;
  try {
    const read = await config.read(markerEntry.path, projectRoot);
    marker = read.kind === "text" ? parseMarker(read.content, skill.id) : null;
  } catch {
    marker = null;
  }
  if (!marker) {
    return { ...base, status: "conflict", eligible: false, reason: "invalid Kodade provenance" };
  }
  const snapshot = await config.dirSnapshot(entry.path, projectRoot);
  if (snapshot.status !== "snapshot") {
    return { ...base, status: "modified", eligible: false, reason: "could not verify installed files" };
  }
  const withoutMarker = snapshot.files.filter(
    (file) => file.path !== KODADE_PROJECT_SKILL_MARKER,
  );
  if (!equalFiles(withoutMarker, marker.files)) {
    return {
      ...base,
      snapshot: snapshot.files,
      status: "modified",
      eligible: false,
      reason: "modified locally",
    };
  }
  return marker.sourceHash === skill.sourceHash
    ? {
        ...base,
        snapshot: snapshot.files,
        status: "installed",
        eligible: true,
        reason: "already installed",
      }
    : {
        ...base,
        snapshot: snapshot.files,
        status: "update",
        eligible: true,
        reason: "selected source differs",
      };
}

export async function inspectProjectSkill(
  config: ConfigIpc,
  bundle: ProjectSkillSourceBundle,
  ctx: ScanContext,
  pro: boolean,
  ownerIds?: readonly string[],
): Promise<ProjectSkillModel> {
  const skill = parseProjectSkillBundle(bundle);
  const targets = resolveProjectSkillTargets(ctx, pro, ownerIds);
  const cells: ProjectSkillCell[] = [];
  for (const target of targets) {
    const scan = await config.scan(target.path, ctx.projectRoot);
    const installedPath = nativeJoin(target.path, skill.id);
    if ("rootIsSymlink" in scan && scan.rootIsSymlink) {
      cells.push({
        targetId: target.id,
        targetPath: target.path,
        installedPath,
        status: "external",
        eligible: false,
        reason: "skills dir is symlinked — managed externally",
      });
      continue;
    }
    if (scan.status === "unreadable") {
      cells.push({
        targetId: target.id,
        targetPath: target.path,
        installedPath,
        status: "unreadable",
        eligible: false,
        reason: scan.error,
      });
      continue;
    }
    const entry = namedEntry(scan.status === "listing" ? scan.entries : [], skill.id);
    cells.push(entry
      ? await inspectExisting(config, ctx.projectRoot, skill, target, entry)
      : {
          targetId: target.id,
          targetPath: target.path,
          installedPath,
          status: "ready",
          eligible: true,
          reason: "ready to install",
        });
  }
  return { skill, targets, cells };
}

function eligibleFor(action: ProjectSkillAction, status: ProjectSkillCellStatus): boolean {
  if (action === "install") return status === "ready";
  if (action === "update") return status === "update";
  return status === "installed" || status === "update";
}

export function buildProjectSkillRequests(
  model: ProjectSkillModel,
  action: ProjectSkillAction,
  selectedTargetIds: readonly string[],
  projectRoot: string,
  pro: boolean,
  ownerIds?: readonly string[],
): ProjectSkillPlannedRequest[] {
  const selected = new Set(selectedTargetIds);
  const allowedOwners = ownerIds ? new Set(ownerIds) : null;
  const requests: ProjectSkillPlannedRequest[] = [];
  for (const cell of model.cells) {
    if (!selected.has(cell.targetId) || !eligibleFor(action, cell.status)) continue;
    const target = model.targets.find((candidate) => candidate.id === cell.targetId);
    if (
      !target ||
      (allowedOwners ? !allowedOwners.has(target.cli) : !pro && target.cli !== "claude")
    ) continue;
    const operation = action === "uninstall" ? "remove" : action;
    requests.push({
      cli: target.cli,
      title: `${action} ${model.skill.id} for ${target.clis.join(" + ")}`,
      request: {
        artifactId: `${target.cli}:project:skill:${model.skill.id}`,
        action: operation === "remove" ? "remove-skill" : `${operation}-skill`,
        projectRoot,
        payload: {
          skillId: model.skill.id,
          targetPath: cell.installedPath,
          operation,
          files: operation === "remove" ? undefined : installFiles(model.skill),
          expectedFiles: operation === "install" ? null : cell.snapshot ?? null,
        },
      },
    });
  }
  return requests;
}
