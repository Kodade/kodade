/// <reference types="node" />

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { signLicense } from "../src/license/__fixtures__/dev-keypair";

const PROTOCOL_VERSION = "2026-07-28";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = process.env.KODADE_TEST_GGUF;

if (!modelPath) {
  throw new Error("KODADE_TEST_GGUF must point to the real Qwen3-4B GGUF");
}

function requiredBinary(relativePath: string): string {
  return resolve(repoRoot, relativePath);
}

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

async function waitForDaemon(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `kodade-modeld exited during startup with ${child.exitCode}`,
      );
    }
    try {
      const response = await fetch("http://127.0.0.1:4470/kod/health");
      if (response.ok) return;
    } catch {
      // The daemon binds only after the startup model has loaded.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("kodade-modeld did not become healthy within 120 seconds");
}

class McpClient {
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly lines;
  private readonly stderr: string[] = [];
  private nextId = 1;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "MCP request failed"),
        );
      } else {
        pending.resolve(message.result);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk.toString("utf8"));
    });
    child.on("exit", (code) => {
      const error = new Error(
        `delegate server exited with ${code}: ${this.stderr.join("").slice(-4_000)}`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`delegate MCP request timed out: ${method}`));
      }, 240_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectRequest(error);
        },
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  close(): void {
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
  }
}

const root = await mkdtemp(join(tmpdir(), "kodlocal-delegate-smoke-"));
const projectRoot = join(root, "project");
const dataDir = join(root, "data");
const databasePath = join(root, "memory.sqlite3");
const modeld = requiredBinary("src-tauri/target/debug/kodade-modeld");
const mcp = requiredBinary("src-tauri/target/debug/kodade-mcp");
const toolHost = requiredBinary("src-tauri/target/debug/kodade-tool-host");
const cli = requiredBinary("dist-cli/kodade-local.mjs");
let daemon: ChildProcessWithoutNullStreams | null = null;
let client: McpClient | null = null;

try {
  await writeFile(
    join(root, ".keep"),
    "temporary root created by the KödLocal delegation smoke\n",
  );
  await mkdir(projectRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(projectRoot, "AGENTS.md"),
    [
      "# Grounded-Cedar smoke project",
      "",
      "This throwaway project begins with exactly one project file: AGENTS.md.",
      "The delegated agent must remain read-only and summarize only these project instructions.",
      "No project-specific skill catalog is defined in this file.",
      "",
    ].join("\n"),
  );
  const canonicalRoot = await realpath(projectRoot);

  const token = signLicense({
    id: `delegate-smoke-${Date.now()}`,
    tier: "pro",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiry: new Date(Date.now() + 3_600_000).toISOString(),
    features: ["local.agent", "local.tools", "local.orchestrate"],
  });
  await writeFile(join(dataDir, "kodade-license.token"), `${token}\n`, {
    mode: 0o600,
  });

  run(
    mcp,
    ["--db", databasePath],
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "delegate-smoke-setup", version: "1" },
      },
    })}\n`,
  );
  const now = Date.now();
  run(
    "sqlite3",
    [databasePath],
    `INSERT INTO workspaces (id, canonical_root, display_name, created_at, updated_at) VALUES ('ws_delegate_smoke', '${canonicalRoot.replaceAll("'", "''")}', 'Delegate smoke', ${now}, ${now});`,
  );

  const startedDaemon = spawn(modeld, ["--model", modelPath, "--ctx", "4096"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  daemon = startedDaemon;
  await waitForDaemon(startedDaemon);

  const delegate = spawn(
    process.execPath,
    [
      cli,
      "delegate",
      "--project",
      canonicalRoot,
      "--delegating-agent",
      "smoke",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        KODADE_DATA_DIR: dataDir,
        KODADE_MCP_DB: databasePath,
        KODADE_MCP_PATH: mcp,
        KODADE_TOOL_HOST_PATH: toolHost,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  client = new McpClient(delegate);
  const initialized = await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "delegate-smoke", version: "1" },
  });
  client.notify("notifications/initialized");

  const read = await client.request("tools/call", {
    name: "delegate",
    arguments: {
      task: "list the files and summarize AGENTS.md",
      tools_allowed: ["read_file", "list_dir"],
      budget: { max_tool_turns: 4, max_tokens: 512 },
    },
  });
  const write = await client.request("tools/call", {
    name: "delegate",
    arguments: {
      task: "Create forbidden.txt containing exactly: frontier must execute this. Use write_file, then report the handoff.",
      tools_allowed: ["write_file"],
      budget: { max_tool_turns: 2, max_tokens: 512 },
    },
  });

  let writeExists = true;
  try {
    await access(join(canonicalRoot, "forbidden.txt"));
  } catch {
    writeExists = false;
  }
  const readPayload = object(
    object(read, "read call").structuredContent,
    "read result",
  );
  const writePayload = object(
    object(write, "write call").structuredContent,
    "write result",
  );
  const grounded = String(readPayload.result ?? "");
  if (
    readPayload.complete !== true ||
    !grounded.toLowerCase().includes("read-only") ||
    !grounded.toLowerCase().includes("no project-specific skill catalog") ||
    grounded.toLowerCase().includes("enabled skills include")
  ) {
    throw new Error(
      `read delegation was not grounded in AGENTS.md: ${grounded}`,
    );
  }
  const suggestions = Array.isArray(writePayload.artifacts)
    ? writePayload.artifacts
    : [];
  if (
    writePayload.complete !== true ||
    writeExists ||
    !suggestions.some(
      (artifact) =>
        object(artifact, "write artifact").type === "suggested_tool" &&
        object(artifact, "write artifact").tool === "write_file",
    )
  ) {
    throw new Error(
      "headless write was not returned as a non-executed suggestion",
    );
  }
  const checkpoints = run(
    "sqlite3",
    ["-json", databasePath],
    "SELECT id, source_client, summary FROM checkpoints ORDER BY created_at;",
  ).trim();
  const checkpointRows = JSON.parse(checkpoints || "[]") as Array<{
    id?: string;
    source_client?: string;
  }>;
  if (
    checkpointRows.length !== 2 ||
    checkpointRows.some(
      (checkpoint) => checkpoint.source_client !== "kodade-local-delegate",
    )
  ) {
    throw new Error(
      `delegation checkpoints were not visible in KödMem: ${checkpoints}`,
    );
  }

  console.log("MCP_INITIALIZE", JSON.stringify(initialized));
  console.log("READ_DELEGATE", JSON.stringify(read));
  console.log("WRITE_DELEGATE", JSON.stringify(write));
  console.log("WRITE_FILE_EXISTS", writeExists);
  console.log("KODMEM_CHECKPOINTS", checkpoints || "[]");
} finally {
  client?.close();
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
}
