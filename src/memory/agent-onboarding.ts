import type { ConfigFileHash, ConfigIpc, ProjectSkillSourceBundle } from "../ipc/contract";
import type { HarnessChangeRequest } from "../harness/contract";
import {
  buildProjectSkillRequests,
  inspectProjectSkill,
  parseProjectSkillBundle,
} from "../harness/project-skills";
import type { ScanContext } from "../harness/model";
import { nativeJoin } from "../platform/native-path";
import type { PlannedBatchRequest } from "../store/harness";
import {
  buildMemoryMcpSetup,
  memoryMcpConfigMatches,
  type MemoryMcpClient,
} from "./mcp-config";
import SKILL from "../../resources/kodmem/kodmem-project/SKILL.md?raw";

export const KODMEM_BLOCK_START = "<!-- kodade:kodmem-project:v1:start -->";
export const KODMEM_BLOCK_END = "<!-- kodade:kodmem-project:v1:end -->";

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

const MANAGED_MARKER = /<!--\s*kodade:kodmem-project:[^>]+-->/g;

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
  const markers = [...text.matchAll(MANAGED_MARKER)].map((match) => match[0]);
  const start = text.indexOf(KODMEM_BLOCK_START);
  const end = text.indexOf(KODMEM_BLOCK_END);
  if (markers.length === 0) {
    const base = text.trimEnd();
    return `${base}${base ? "\n\n" : ""}${body}\n`;
  }
  if (
    markers.length !== 2 ||
    markers[0] !== KODMEM_BLOCK_START ||
    markers[1] !== KODMEM_BLOCK_END ||
    start < 0 ||
    end < start ||
    text.indexOf(KODMEM_BLOCK_START, start + 1) >= 0 ||
    text.indexOf(KODMEM_BLOCK_END, end + 1) >= 0
  ) {
    throw new Error("the KödMem instruction block is malformed or uses an unsupported version");
  }
  const after = end + KODMEM_BLOCK_END.length;
  return `${text.slice(0, start)}${body}${text.slice(after)}`;
}

export function removeKodmemBlock(text: string): string {
  const markers = [...text.matchAll(MANAGED_MARKER)].map((match) => match[0]);
  if (markers.length === 0) return text;
  const start = text.indexOf(KODMEM_BLOCK_START);
  const end = text.indexOf(KODMEM_BLOCK_END);
  if (
    markers.length !== 2 ||
    markers[0] !== KODMEM_BLOCK_START ||
    markers[1] !== KODMEM_BLOCK_END ||
    start < 0 ||
    end < start
  ) {
    throw new Error("the KödMem instruction block is malformed or uses an unsupported version");
  }
  const after = end + KODMEM_BLOCK_END.length;
  const joined = `${text.slice(0, start).trimEnd()}\n\n${text.slice(after).trimStart()}`.trim();
  return joined ? `${joined}\n` : "";
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
    for (const candidate of candidates[client]) {
      try {
        const snapshot = await config.externalSkillSnapshot(candidate, input.workspaceRoot);
        result[client] = sameHashes(snapshot, expected) ? "external" : "conflict";
        break;
      } catch {
        // An absent/non-symlink candidate is not an externally managed skill.
      }
    }
  }
  return result;
}

async function readText(config: ConfigIpc, path: string, root: string): Promise<string> {
  try {
    const read = await config.read(path, root);
    return read.kind === "text" ? read.content : "";
  } catch {
    return "";
  }
}

function instructionRequest(
  cli: MemoryMcpClient,
  path: string,
  before: string,
  after: string,
  root: string,
): PlannedBatchRequest | null {
  if (before === after) return null;
  return {
    cli,
    title: `update managed KödMem instructions for ${cli}`,
    request: {
      artifactId: `${cli}:project:instruction:kodmem-project`,
      action: "edit",
      projectRoot: root,
      payload: { path, newText: after },
    },
  };
}

function mcpTarget(input: AgentOnboardingInput, client: MemoryMcpClient) {
  return client === "claude"
    ? {
        path: nativeJoin(input.home, ".claude.json"),
        format: "json" as const,
        keyPath: ["projects", input.workspaceRoot, "mcpServers"] as const,
      }
    : {
        path: join(input.home, ".codex", "config.toml"),
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
  if (action === "connect") {
    const blocked = skillModel.cells.find((cell) =>
      cell.status === "conflict" || cell.status === "modified" || cell.status === "external" || cell.status === "unreadable"
    );
    if (blocked) throw new Error(`the project skill cannot be managed: ${blocked.reason}`);
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
  const instructionRequests = [
    instructionRequest(
      "codex",
      agentsPath,
      agentsBefore,
      action === "connect" ? ensureKodmemBlock(agentsBefore, AGENTS_BLOCK) : removeKodmemBlock(agentsBefore),
      input.workspaceRoot,
    ),
    instructionRequest(
      "claude",
      claudePath,
      claudeBefore,
      action === "connect" ? ensureKodmemBlock(claudeBefore, CLAUDE_BLOCK) : removeKodmemBlock(claudeBefore),
      input.workspaceRoot,
    ),
  ].filter((request): request is PlannedBatchRequest => request !== null);

  const mcpRequests: PlannedBatchRequest[] = [];
  for (const client of ["claude", "codex"] as const) {
    const target = mcpTarget(input, client);
    let spec = setup.spec(client);
    const before = await readText(config, target.path, input.workspaceRoot);
    if (action === "connect" && before && memoryMcpConfigMatches(before, target.format, target.keyPath, spec)) {
      continue;
    }
    if (action === "remove") {
      if (!before) continue;
      if (!memoryMcpConfigMatches(before, target.format, target.keyPath, spec)) {
        const alternate = buildMemoryMcpSetup({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
          binaryPath: input.binaryPath,
          readOnly: !readOnly,
        });
        if (alternate.state !== "ready") continue;
        const alternateSpec = alternate.spec(client);
        if (!memoryMcpConfigMatches(before, target.format, target.keyPath, alternateSpec)) continue;
        spec = alternateSpec;
      }
    }
    mcpRequests.push({
      cli: client,
      title: `${action === "connect" ? "configure" : "remove"} KödMCP for ${client}`,
      request: {
        artifactId: `${client}:mcp:${spec.name}`,
        action: action === "connect" ? "add-mcp-server" : "remove-mcp-server",
        projectRoot: input.workspaceRoot,
        payload: { ...target, server: spec },
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
