import type { ConfigFileHash, ConfigIpc, ProjectSkillSourceBundle } from "../ipc/contract";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { HarnessChangeRequest } from "../harness/contract";
import {
  buildProjectSkillRequests,
  inspectProjectSkill,
  parseProjectSkillBundle,
} from "../harness/project-skills";
import type { ScanContext } from "../harness/model";
import { mergeMcpServer } from "../harness/merge";
import { nativeJoin } from "../platform/native-path";
import type { PlannedBatchRequest } from "../store/harness";
import {
  buildMemoryMcpSetup,
  inspectMemoryMcpConfig,
  withMemoryMcpBaseline,
  type MemoryMcpClient,
} from "./mcp-config";
import SKILL from "../../resources/kodmem/kodmem-project/SKILL.md?raw";

export const KODMEM_BLOCK_START = "<!-- kodade:kodmem-project:v1:start -->";
export const KODMEM_BLOCK_END = "<!-- kodade:kodmem-project:v1:end -->";
export const KODMEM_CREATED_FILE_MARKER = "<!-- kodade:artifact-origin:created-file -->";

const AGENTS_BLOCK = `${KODMEM_BLOCK_START}
## KödMem project context

When KödMCP tools are available, use the \`kodmem-project\` skill before planning,
when prior project knowledge is needed, and before a substantive handoff.
Repository files and the issue tracker remain implementation truth; KödMem holds
durable project context.
${KODMEM_BLOCK_END}`;

const CLAUDE_BLOCK = `${KODMEM_BLOCK_START}
Follow the managed KödMem project-context rule in \`AGENTS.md\`.
${KODMEM_BLOCK_END}`;

function createdFileBlock(body: string): string {
  return body.replace(KODMEM_BLOCK_END, `${KODMEM_CREATED_FILE_MARKER}\n${KODMEM_BLOCK_END}`);
}

const MANAGED_MARKER = /<!--\s*kodade:kodmem-project:[^>]+-->/g;

type ManagedBlock = { start: number; after: number; eol: "\n" | "\r\n" };
type OptionalText = { exists: boolean; text: string };

function hashText(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function managedBlock(text: string): ManagedBlock | null {
  const markers = [...text.matchAll(MANAGED_MARKER)].map((match) => match[0]);
  if (markers.length === 0) return null;
  const start = text.indexOf(KODMEM_BLOCK_START);
  const end = text.indexOf(KODMEM_BLOCK_END);
  const after = end + KODMEM_BLOCK_END.length;
  const blockText = start >= 0 && end >= start ? text.slice(start, after) : "";
  const eol = blockText.includes("\r\n") ? "\r\n" : "\n";
  if (
    markers.length !== 2 ||
    markers[0] !== KODMEM_BLOCK_START ||
    markers[1] !== KODMEM_BLOCK_END ||
    start < 0 ||
    end < start ||
    text.indexOf(KODMEM_BLOCK_START, start + 1) >= 0 ||
    text.indexOf(KODMEM_BLOCK_END, end + 1) >= 0 ||
    (text.slice(after) !== "" && text.slice(after) !== eol)
  ) {
    throw new Error("the KödMem instruction block is malformed or uses an unsupported version");
  }
  return { start, after, eol };
}

export type OnboardingAccess = "read-only" | "read-write";
export type OnboardingAction = "connect" | "remove";

export type AgentOnboardingInput = {
  workspaceId: string;
  workspaceRoot: string;
  binaryPath: string;
  home: string;
  platform: "mac" | "windows";
  appDataRoaming?: string | null;
  appDataLocal?: string | null;
  access: OnboardingAccess;
};

export type AgentOnboardingPlan = {
  action: OnboardingAction;
  requests: PlannedBatchRequest[];
  skill: Record<MemoryMcpClient, "external" | "managed" | "unchanged">;
};

export function ensureKodmemBlock(text: string, body: string): string {
  const existing = managedBlock(text);
  if (!existing) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const rendered = body.replaceAll("\r\n", "\n").replaceAll("\n", eol);
    return `${text}${text ? eol : ""}${rendered}${eol}`;
  }
  const rendered = body.replaceAll("\r\n", "\n").replaceAll("\n", existing.eol);
  if (text.slice(existing.start, existing.after) !== rendered) {
    throw new Error("the managed KödMem instruction block differs from Ködade's contract");
  }
  return `${text.slice(0, existing.start)}${rendered}${text.slice(existing.after)}`;
}

export function removeKodmemBlock(text: string, body: string): string {
  const existing = managedBlock(text);
  if (!existing) return text;
  const rendered = body.replaceAll("\r\n", "\n").replaceAll("\n", existing.eol);
  if (text.slice(existing.start, existing.after) !== rendered) {
    throw new Error("the managed KödMem instruction block differs from Ködade's contract");
  }
  const prefix = text.slice(0, existing.start);
  if (prefix && !prefix.endsWith(existing.eol)) {
    throw new Error("the KödMem instruction block is malformed or uses an unsupported version");
  }
  return prefix ? prefix.slice(0, -existing.eol.length) : "";
}

function sourceBundle(): ProjectSkillSourceBundle {
  return {
    root: "kodade://bundled/kodmem-project",
    files: [{ path: "SKILL.md", contents: SKILL }],
  };
}

function sameHashes(actual: readonly ConfigFileHash[], expected: readonly ConfigFileHash[]): boolean {
  const order = (files: readonly ConfigFileHash[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));
  const left = order(actual);
  const right = order(expected);
  return left.length === right.length && left.every(
    (file, index) => file.path === right[index].path && file.sha256 === right[index].sha256,
  );
}

function join(...segments: string[]): string {
  return segments.slice(1).reduce((path, segment) => nativeJoin(path, segment), segments[0]);
}

async function externalSkillState(
  config: ConfigIpc,
  input: AgentOnboardingInput,
): Promise<Record<MemoryMcpClient, "external" | "missing" | "conflict">> {
  const expected = parseProjectSkillBundle(sourceBundle()).files.map(({ path, sha256 }) => ({ path, sha256 }));
  const candidates: Record<MemoryMcpClient, string[]> = {
    claude: [join(input.home, ".claude", "skills", "kodmem-project")],
    codex: [
      join(input.home, ".agents", "skills", "kodmem-project"),
      join(input.home, ".codex", "skills", "kodmem-project"),
    ],
  };
  const result = {} as Record<MemoryMcpClient, "external" | "missing" | "conflict">;
  for (const client of ["claude", "codex"] as const) {
    result[client] = "missing";
    let foundExact = false;
    for (const candidate of candidates[client]) {
      try {
        const snapshot = await config.externalSkillSnapshot(candidate, input.workspaceRoot);
        if (!sameHashes(snapshot, expected)) {
          result[client] = "conflict";
          break;
        }
        foundExact = true;
      } catch {
        // An absent/non-symlink candidate is not an externally managed skill.
      }
    }
    if (result[client] !== "conflict" && foundExact) result[client] = "external";
  }
  return result;
}

async function readText(config: ConfigIpc, path: string, root: string): Promise<OptionalText> {
  const text = await config.readOptionalText(path, root);
  return { exists: text !== null, text: text ?? "" };
}

function instructionRequest(
  cli: MemoryMcpClient,
  path: string,
  before: string,
  after: string,
  root: string,
  removeFile = false,
): PlannedBatchRequest | null {
  if (before === after) return null;
  return {
    cli,
    title: `update managed KödMem instructions for ${cli}`,
    request: {
      artifactId: `${cli}:project:instruction:kodmem-project`,
      action: removeFile ? "remove-file" : "edit",
      projectRoot: root,
      payload: removeFile
        ? { path, expectedText: before, format: "markdown" }
        : { path, newText: after, expectedText: before },
    },
  };
}

function removeInstructionBlock(
  text: string,
  regular: string,
): { text: string; removeFile: boolean } {
  try {
    return { text: removeKodmemBlock(text, regular), removeFile: false };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("differs")) throw error;
  }
  const removed = removeKodmemBlock(text, createdFileBlock(regular));
  return { text: removed, removeFile: removed === "" };
}

export function memoryMcpTarget(
  home: string,
  workspaceRoot: string,
  client: MemoryMcpClient,
) {
  return client === "claude"
    ? {
        path: nativeJoin(home, ".claude.json"),
        format: "json" as const,
        keyPath: ["projects", workspaceRoot, "mcpServers"] as const,
      }
    : {
        path: join(home, ".codex", "config.toml"),
        format: "toml" as const,
        keyPath: "mcp_servers" as const,
      };
}

export async function buildAgentOnboardingPlan(
  config: ConfigIpc,
  input: AgentOnboardingInput,
  action: OnboardingAction,
): Promise<AgentOnboardingPlan> {
  const readOnly = input.access === "read-only";
  const setup = buildMemoryMcpSetup({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    binaryPath: input.binaryPath,
    readOnly,
  });
  if (setup.state !== "ready") throw new Error("KödMCP onboarding prerequisites are unavailable");

  const ctx: ScanContext = {
    home: input.home,
    platform: input.platform,
    projectRoot: input.workspaceRoot,
    appDataRoaming: input.appDataRoaming ?? null,
    appDataLocal: input.appDataLocal ?? null,
  };
  const external = await externalSkillState(config, input);
  if (action === "connect" && Object.values(external).includes("conflict")) {
    throw new Error("an externally managed kodmem-project skill differs from Ködade's contract");
  }
  const managedOwners = (["claude", "codex"] as const).filter((client) => external[client] !== "external");
  // Always inspect both project-local targets. A newly installed global skill
  // must not hide a stale or modified Ködade-owned project copy that takes
  // precedence in the client.
  const skillModel = await inspectProjectSkill(
    config,
    sourceBundle(),
    ctx,
    true,
    ["claude", "codex"],
  );
  const skillRequests: PlannedBatchRequest[] = [];
  const blockedSkill = skillModel.cells.find((cell) =>
    action === "connect"
      ? cell.status === "conflict" || cell.status === "modified" || cell.status === "external" || cell.status === "unreadable"
      : cell.status === "modified" || cell.status === "unreadable" ||
        (cell.status === "conflict" && cell.reason === "invalid Kodade provenance")
  );
  if (blockedSkill) {
    throw new Error(`the project skill cannot be managed: ${blockedSkill.reason}`);
  }
  if (action === "connect") {
    skillRequests.push(
      ...buildProjectSkillRequests(
        skillModel,
        "uninstall",
        skillModel.cells
          .filter((cell) => {
            const target = skillModel.targets.find((candidate) => candidate.id === cell.targetId);
            return target && external[target.cli as MemoryMcpClient] === "external" &&
              (cell.status === "installed" || cell.status === "update");
          })
          .map((cell) => cell.targetId),
        input.workspaceRoot,
        true,
        (["claude", "codex"] as const).filter((client) => external[client] === "external"),
      ),
      ...buildProjectSkillRequests(
        skillModel,
        "install",
        skillModel.cells.filter((cell) => cell.status === "ready").map((cell) => cell.targetId),
        input.workspaceRoot,
        true,
        managedOwners,
      ),
      ...buildProjectSkillRequests(
        skillModel,
        "update",
        skillModel.cells.filter((cell) => cell.status === "update").map((cell) => cell.targetId),
        input.workspaceRoot,
        true,
        managedOwners,
      ),
    );
  } else {
    skillRequests.push(...buildProjectSkillRequests(
      skillModel,
      "uninstall",
      skillModel.cells.filter((cell) => cell.status === "installed" || cell.status === "update").map((cell) => cell.targetId),
      input.workspaceRoot,
      true,
      ["claude", "codex"],
    ));
  }

  const agentsPath = nativeJoin(input.workspaceRoot, "AGENTS.md");
  const claudePath = nativeJoin(input.workspaceRoot, "CLAUDE.md");
  const agentsBefore = await readText(config, agentsPath, input.workspaceRoot);
  const claudeBefore = await readText(config, claudePath, input.workspaceRoot);
  const agentsAfter = action === "connect"
    ? {
        text: ensureKodmemBlock(
          agentsBefore.text,
          agentsBefore.exists ? AGENTS_BLOCK : createdFileBlock(AGENTS_BLOCK),
        ),
        removeFile: false,
      }
    : removeInstructionBlock(agentsBefore.text, AGENTS_BLOCK);
  const claudeAfter = action === "connect"
    ? {
        text: ensureKodmemBlock(
          claudeBefore.text,
          claudeBefore.exists ? CLAUDE_BLOCK : createdFileBlock(CLAUDE_BLOCK),
        ),
        removeFile: false,
      }
    : removeInstructionBlock(claudeBefore.text, CLAUDE_BLOCK);
  const instructionRequests = [
    instructionRequest(
      "codex",
      agentsPath,
      agentsBefore.text,
      agentsAfter.text,
      input.workspaceRoot,
      agentsAfter.removeFile,
    ),
    instructionRequest(
      "claude",
      claudePath,
      claudeBefore.text,
      claudeAfter.text,
      input.workspaceRoot,
      claudeAfter.removeFile,
    ),
  ].filter((request): request is PlannedBatchRequest => request !== null);

  const mcpRequests: PlannedBatchRequest[] = [];
  const alternate = buildMemoryMcpSetup({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    binaryPath: input.binaryPath,
    readOnly: !readOnly,
  });
  if (alternate.state !== "ready") throw new Error("KödMCP onboarding prerequisites are unavailable");
  for (const client of ["claude", "codex"] as const) {
    const target = memoryMcpTarget(input.home, input.workspaceRoot, client);
    const requestedSpec = setup.spec(client);
    const before = await readText(config, target.path, input.workspaceRoot);
    const inspected = before.exists
      ? inspectMemoryMcpConfig(
          before.text,
          target.format,
          target.keyPath,
          action === "connect"
            ? [requestedSpec]
            : [requestedSpec, alternate.spec(client)],
        )
      : { state: "absent" as const };
    if (inspected.state === "unreadable") {
      throw new Error(`the ${client} MCP config is unreadable; no onboarding changes were staged`);
    }
    if (inspected.state === "drifted") {
      throw new Error(`the ${client} KödMCP entry drifted; repair or remove it before retrying`);
    }
    if (action === "connect") {
      if (inspected.state === "matched") continue;
      const baseline = before.exists ? hashText(before.text) : "absent";
      const spec = withMemoryMcpBaseline(requestedSpec, baseline);
      mcpRequests.push({
        cli: client,
        title: `configure KödMCP for ${client}`,
        request: {
          artifactId: `${client}:mcp:${spec.name}`,
          action: "add-mcp-server",
          projectRoot: input.workspaceRoot,
          payload: {
            ...target,
            server: spec,
            expectedText: before.text,
            expectedMissing: !before.exists,
          },
        } satisfies HarnessChangeRequest,
      });
      continue;
    }
    if (inspected.state === "absent") continue;

    if (inspected.baseline !== null) {
      const baseline = inspected.baseline === "absent"
        ? null
        : await config.baselineText(target.path, inspected.baseline, input.workspaceRoot);
      const connected = mergeMcpServer(
        baseline ?? "",
        target.format,
        target.keyPath,
        inspected.spec,
      ).after;
      if (connected === before.text) {
        mcpRequests.push({
          cli: client,
          title: `restore ${client} MCP config baseline`,
          request: {
            artifactId: `${client}:mcp:${inspected.spec.name}`,
            action: baseline === null ? "remove-file" : "edit",
            projectRoot: input.workspaceRoot,
            payload: baseline === null
              ? { path: target.path, expectedText: before.text, format: target.format }
              : {
                  path: target.path,
                  newText: baseline,
                  expectedText: before.text,
                  format: target.format,
                },
          } satisfies HarnessChangeRequest,
        });
        continue;
      }
    }
    mcpRequests.push({
      cli: client,
      title: `remove KödMCP for ${client}`,
      request: {
        artifactId: `${client}:mcp:${inspected.spec.name}`,
        action: "remove-mcp-server",
        projectRoot: input.workspaceRoot,
        payload: {
          ...target,
          server: inspected.spec,
          expectedText: before.text,
          expectedMissing: false,
        },
      } satisfies HarnessChangeRequest,
    });
  }

  // Install workflow first, then instructions, then machine-local discovery
  // config. Removal reverses that dependency order.
  const requests = action === "connect"
    ? [...skillRequests, ...instructionRequests, ...mcpRequests]
    : [...mcpRequests, ...instructionRequests, ...skillRequests];
  return {
    action,
    requests,
    skill: {
      claude: external.claude === "external" ? "external" : skillRequests.some((request) => request.cli === "claude") ? "managed" : "unchanged",
      codex: external.codex === "external" ? "external" : skillRequests.some((request) => request.cli === "codex") ? "managed" : "unchanged",
    },
  };
}
