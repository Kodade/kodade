import { describe, expect, it } from "vitest";
import { MockConfig } from "../ipc/mock";
import { parseByFormat } from "../harness/merge";
import { buildMemoryMcpSetup } from "./mcp-config";
import {
  buildAgentOnboardingPlan,
  ensureKodmemBlock,
  KODMEM_BLOCK_END,
  KODMEM_BLOCK_START,
  removeKodmemBlock,
  type AgentOnboardingInput,
} from "./agent-onboarding";

const ROOT = "/projects/acme.with-dots";
const HOME = "/Users/keith";
const INPUT: AgentOnboardingInput = {
  workspaceId: "ws_01HZX3WQ",
  workspaceRoot: ROOT,
  binaryPath: "/Applications/Kodade/kodade-mcp",
  home: HOME,
  platform: "mac",
  access: "read-write",
};

describe("managed KödMem instruction blocks", () => {
  it("inserts, updates, and removes only its exact block", () => {
    const body = `${KODMEM_BLOCK_START}\nmanaged v1\n${KODMEM_BLOCK_END}`;
    const inserted = ensureKodmemBlock("# Existing\n", body);
    expect(inserted).toBe(`# Existing\n\n${body}\n`);
    expect(ensureKodmemBlock(inserted, body)).toBe(inserted);
    expect(removeKodmemBlock(inserted)).toBe("# Existing\n");
  });

  it("refuses malformed, duplicated, or unknown managed markers", () => {
    expect(() => ensureKodmemBlock(`${KODMEM_BLOCK_START}\nmissing end`, "x")).toThrow(/malformed/);
    expect(() => removeKodmemBlock("<!-- kodade:kodmem-project:v2:start -->\nx")).toThrow(/unsupported/);
    expect(() => ensureKodmemBlock(
      `${KODMEM_BLOCK_START}\na\n${KODMEM_BLOCK_END}\n${KODMEM_BLOCK_START}\nb\n${KODMEM_BLOCK_END}`,
      "x",
    )).toThrow(/malformed/);
  });
});

describe("buildAgentOnboardingPlan", () => {
  it("previews skill, instructions, and both client configs as one ordered transaction", async () => {
    const config = new MockConfig();
    config.reads.set(`${ROOT}/AGENTS.md`, { kind: "text", content: "# Agents\n" });
    config.reads.set(`${ROOT}/CLAUDE.md`, { kind: "text", content: "# Claude\n" });

    const plan = await buildAgentOnboardingPlan(config, INPUT, "connect");

    expect(plan.requests.map((request) => request.request.action)).toEqual([
      "install-skill",
      "install-skill",
      "edit",
      "edit",
      "add-mcp-server",
      "add-mcp-server",
    ]);
    const claude = plan.requests.find((request) => request.request.artifactId === "claude:mcp:kodade-mem")!;
    expect((claude.request.payload as any).keyPath).toEqual(["projects", ROOT, "mcpServers"]);
    const codex = plan.requests.find((request) => request.request.artifactId.includes("codex:mcp"))!;
    expect((codex.request.payload as any).server.name).toBe(`kodade-mem-${INPUT.workspaceId}`);

    const instructionText = plan.requests
      .filter((request) => request.request.action === "edit")
      .map((request) => (request.request.payload as any).newText)
      .join("\n");
    expect(instructionText).not.toContain(ROOT);
    expect(instructionText).not.toContain(INPUT.binaryPath);
    expect(instructionText).not.toMatch(/BridgeMemory|projects\/worklog/i);
  });

  it("reuses exact external skills and becomes idempotent when files and configs already match", async () => {
    const config = new MockConfig();
    const first = await buildAgentOnboardingPlan(config, INPUT, "connect");
    const skillFiles = first.requests
      .filter((request) => request.request.action === "install-skill")
      .flatMap((request) => (request.request.payload as any).files)
      .filter((file: any) => file.path === "SKILL.md")
      .slice(0, 1)
      .map(({ path, sha256 }: any) => ({ path, sha256 }));
    config.externalSkillSnapshots.set(`${HOME}/.claude/skills/kodmem-project`, skillFiles);
    config.externalSkillSnapshots.set(`${HOME}/.codex/skills/kodmem-project`, skillFiles);

    const setup = buildMemoryMcpSetup({
      workspaceId: INPUT.workspaceId,
      workspaceRoot: ROOT,
      binaryPath: INPUT.binaryPath,
      readOnly: false,
    });
    if (setup.state !== "ready") throw new Error("fixture setup failed");
    const agents = ensureKodmemBlock("", `${KODMEM_BLOCK_START}\n## KödMem project context\n\nWhen KödMCP tools are available, use the \`kodmem-project\` skill before planning,\nwhen prior project knowledge is needed, and before a substantive handoff.\nRepository files and the issue tracker remain implementation truth; KödMem holds\ndurable project context.\n${KODMEM_BLOCK_END}`);
    const claude = ensureKodmemBlock("", `${KODMEM_BLOCK_START}\nFollow the managed KödMem project-context rule in \`AGENTS.md\`.\n${KODMEM_BLOCK_END}`);
    config.reads.set(`${ROOT}/AGENTS.md`, { kind: "text", content: agents });
    config.reads.set(`${ROOT}/CLAUDE.md`, { kind: "text", content: claude });
    config.reads.set(`${HOME}/.claude.json`, {
      kind: "text",
      content: JSON.stringify({ projects: { [ROOT]: { mcpServers: { [setup.spec("claude").name]: setup.spec("claude").config } } } }),
    });
    config.reads.set(`${HOME}/.codex/config.toml`, {
      kind: "text",
      content: `[mcp_servers.${setup.spec("codex").name}]\ncommand = "${INPUT.binaryPath}"\nargs = [ "--workspace", "${ROOT}", "--client", "codex" ]\n`,
    });

    const plan = await buildAgentOnboardingPlan(config, INPUT, "connect");
    expect(plan.skill).toEqual({ claude: "external", codex: "external" });
    expect(plan.requests).toEqual([]);
  });

  it("removes a clean managed project copy when an exact global skill now supersedes it", async () => {
    const config = new MockConfig();
    const initial = await buildAgentOnboardingPlan(config, INPUT, "connect");
    const claudeInstall = initial.requests.find(
      (request) => request.cli === "claude" && request.request.action === "install-skill",
    )!;
    const payload = claudeInstall.request.payload as {
      targetPath: string;
      files: { path: string; contents: string; sha256: string }[];
    };
    const container = payload.targetPath.slice(0, payload.targetPath.lastIndexOf("/"));
    const marker = payload.files.find((file) => file.path === ".kodade-skill.json")!;
    config.scans.set(container, {
      status: "listing",
      root: container,
      entries: [{
        name: "kodmem-project",
        path: payload.targetPath,
        isDir: true,
        isSymlink: false,
        target: null,
        orphaned: false,
        children: [{
          name: marker.path,
          path: `${payload.targetPath}/${marker.path}`,
          isDir: false,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: null,
        }],
      }],
    });
    config.reads.set(`${payload.targetPath}/${marker.path}`, {
      kind: "text",
      content: marker.contents,
    });
    config.dirSnapshots.set(payload.targetPath, {
      status: "snapshot",
      path: payload.targetPath,
      files: payload.files.map(({ path, sha256 }) => ({ path, sha256 })),
    });
    const contract = payload.files
      .filter((file) => file.path === "SKILL.md")
      .map(({ path, sha256 }) => ({ path, sha256 }));
    config.externalSkillSnapshots.set(`${HOME}/.claude/skills/kodmem-project`, contract);
    config.externalSkillSnapshots.set(`${HOME}/.agents/skills/kodmem-project`, contract);

    const plan = await buildAgentOnboardingPlan(config, INPUT, "connect");
    const skillChanges = plan.requests.filter((request) =>
      request.request.action.endsWith("-skill")
    );
    expect(plan.skill).toEqual({ claude: "external", codex: "external" });
    expect(skillChanges).toEqual([
      expect.objectContaining({
        cli: "claude",
        request: expect.objectContaining({ action: "remove-skill" }),
      }),
    ]);
  });

  it("removes either configured access mode without touching neighboring config", async () => {
    const config = new MockConfig();
    const readOnly = { ...INPUT, access: "read-only" as const };
    const setup = buildMemoryMcpSetup({
      workspaceId: INPUT.workspaceId,
      workspaceRoot: ROOT,
      binaryPath: INPUT.binaryPath,
      readOnly: false,
    });
    if (setup.state !== "ready") throw new Error("fixture setup failed");
    config.reads.set(`${HOME}/.claude.json`, {
      kind: "text",
      content: JSON.stringify({ theme: "dark", projects: { [ROOT]: { mcpServers: { [setup.spec("claude").name]: setup.spec("claude").config } } } }),
    });
    config.reads.set(`${HOME}/.codex/config.toml`, {
      kind: "text",
      content: `[mcp_servers.${setup.spec("codex").name}]\ncommand = "${INPUT.binaryPath}"\nargs = [ "--workspace", "${ROOT}", "--client", "codex" ]\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n`,
    });

    const plan = await buildAgentOnboardingPlan(config, readOnly, "remove");
    expect(plan.requests.slice(0, 2).map((request) => request.request.action)).toEqual([
      "remove-mcp-server",
      "remove-mcp-server",
    ]);
    const before = config.reads.get(`${HOME}/.codex/config.toml`)!;
    expect(parseByFormat(before.kind === "text" ? before.content : "", "toml")).toBeTruthy();
  });
});
