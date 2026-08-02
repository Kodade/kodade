import type { HarnessAdapter } from "../harness/contract";
import {
  createReadOnlyHarnessAdapter,
  type HarnessReadFs,
} from "../harness/adapters/read";
import type { HarnessArtifact, HarnessScanError, ScanContext } from "../harness/model";
import { scanInventory } from "../harness/scan";

export type LocalHarnessSource = {
  scope: "global" | "project";
  kind: "instruction" | "skill";
  name: string;
  path: string;
};

export type LocalHarness = {
  systemPrompt: string;
  sources: LocalHarnessSource[];
  errors: HarnessScanError[];
};

export function createLocalHarnessAdapter(fs: HarnessReadFs): HarnessAdapter {
  return createReadOnlyHarnessAdapter("kodade-local", fs);
}

async function readText(fs: HarnessReadFs, path: string, projectRoot: string): Promise<string | null> {
  try {
    const read = await fs.read(path, projectRoot);
    return read.kind === "text" ? read.content : null;
  } catch {
    return null;
  }
}

function skillDescription(content: string, fallback: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  const frontmatterLines = frontmatter?.split(/\r?\n/) ?? [];
  const descriptionIndex = frontmatterLines.findIndex((line) => /^description\s*:/i.test(line));
  const scalar =
    descriptionIndex >= 0
      ? frontmatterLines[descriptionIndex].replace(/^description\s*:\s*/i, "").trim()
      : "";
  const blockLines: string[] = [];
  if (scalar === "|" || scalar === ">") {
    for (const line of frontmatterLines.slice(descriptionIndex + 1)) {
      if (!/^\s+/.test(line)) break;
      blockLines.push(line.trim());
    }
  }
  const raw = blockLines.length > 0 ? blockLines.join(" ") : scalar;
  if (raw) return brief(raw.replace(/^(["'])(.*)\1$/, "$2"));
  const firstLine = content
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return brief(firstLine || `${fallback} is enabled for this project`);
}

function brief(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 47).trimEnd()}…`;
}

async function instructionSection(
  fs: HarnessReadFs,
  artifact: HarnessArtifact | undefined,
  projectRoot: string,
  sources: LocalHarnessSource[],
): Promise<string | null> {
  if (!artifact || !artifact.enabled || artifact.status !== "ok") return null;
  const content = await readText(fs, artifact.path, projectRoot);
  if (content === null) return null;
  sources.push({
    scope: artifact.scope,
    kind: "instruction",
    name: artifact.name,
    path: artifact.path,
  });
  const label = artifact.scope === "project" ? "Project AGENTS.md" : "Global AGENTS.md";
  return `## ${label}\n${content.trim()}`;
}

/** Assemble the same AGENTS.md + enabled-skill artifacts the matrix scans. */
export async function assembleLocalHarness(
  fs: HarnessReadFs,
  ctx: ScanContext,
): Promise<LocalHarness> {
  const adapter = createLocalHarnessAdapter(fs);
  const [globalInventory, projectInventory] = await Promise.all([
    scanInventory([adapter], "global", ctx),
    scanInventory([adapter], "project", ctx),
  ]);
  const sources: LocalHarnessSource[] = [];
  const globalInstruction = globalInventory.artifacts.find(
    (artifact) => artifact.kind === "instruction",
  );
  const projectInstruction = projectInventory.artifacts.find(
    (artifact) => artifact.kind === "instruction",
  );
  const globalSection = await instructionSection(
    fs,
    globalInstruction,
    ctx.projectRoot,
    sources,
  );
  const projectSection = await instructionSection(
    fs,
    projectInstruction,
    ctx.projectRoot,
    sources,
  );
  const instructionSections = [globalSection, projectSection].filter(
    (section): section is string => section !== null,
  );

  // A future project-scope skill with the same name replaces the global one.
  // The catalog currently exposes Codex's global skills root only, but the
  // precedence rule is explicit here so widening locations cannot change it.
  const skills = new Map<string, HarnessArtifact>();
  for (const artifact of [...globalInventory.artifacts, ...projectInventory.artifacts]) {
    if (artifact.kind === "skill" && artifact.enabled && artifact.status === "ok") {
      skills.set(artifact.name, artifact);
    }
  }
  const skillLines: string[] = [];
  for (const artifact of skills.values()) {
    if (artifact.detail?.kind !== "skill" || !artifact.detail.manifestPath) continue;
    const content = await readText(fs, artifact.detail.manifestPath, ctx.projectRoot);
    if (content === null) continue;
    sources.push({
      scope: artifact.scope,
      kind: "skill",
      name: artifact.name,
      path: artifact.detail.manifestPath,
    });
    skillLines.push(`- ${artifact.name}: ${skillDescription(content, artifact.name)}`);
  }

  const parts = [
    "You are KödLocal, working inside the selected project.",
    "Harness precedence: project instructions override conflicting global instructions.",
    ...instructionSections,
    ...(skillLines.length > 0 ? [`## Enabled skills\n${skillLines.join("\n")}`] : []),
  ];
  return {
    systemPrompt: parts.join("\n\n"),
    sources,
    errors: [...globalInventory.errors, ...projectInventory.errors],
  };
}
