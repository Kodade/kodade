import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  MemoryCheckpointClient,
  MemoryCheckpointInput,
  ProjectMemoryContext,
} from "../../src/local/memory";

// Mirrors `ProtocolVersion::V_2026_07_28` in src-tauri/src/mcp.rs. Keep this
// value in lockstep with the server's advertised rmcp protocol gate.
export const MCP_PROTOCOL_VERSION = "2026-07-28";

const CALL_TIMEOUT_MS = 20_000;
const MAX_STDERR_CHARS = 4_000;

type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  scriptPath?: string;
  cwd?: string;
  execPath?: string;
};

type ConnectOptions = {
  workspaceRoot: string;
  binary?: string;
  /** Explicit scratch/test database; normal clients use Ködade app data. */
  databasePath?: string;
  requestTimeoutMs?: number;
  clientName?: string;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type JsonObject = Record<string, unknown>;

export type MemoryMcpConnection =
  | {
      available: true;
      client: StdioMemoryMcpClient;
      context: ProjectMemoryContext;
      protocolVersion: string;
    }
  | { available: false; reason: string };

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function errorMessage(value: unknown): string {
  const object = asObject(value);
  if (!object) return String(value);
  return typeof object.message === "string"
    ? object.message
    : JSON.stringify(object);
}

/** Resolve the packaged KödMCP sibling before explicit and development fallbacks. */
export function resolveMcpBinary(options: ResolveOptions = {}): string {
  const env = options.env ?? process.env;
  const name = process.platform === "win32" ? "kodade-mcp.exe" : "kodade-mcp";
  const scriptDir = dirname(
    options.scriptPath ?? fileURLToPath(import.meta.url),
  );
  const cwd = options.cwd ?? process.cwd();
  const execDir = dirname(options.execPath ?? process.execPath);
  const bundled = [
    join(scriptDir, name),
    join(scriptDir, "bin", name),
    resolve(scriptDir, "..", "..", "MacOS", name),
  ].find(isFile);
  if (bundled) return bundled;

  const override = env.KODADE_MCP_PATH;
  if (override) {
    if (!isFile(override))
      throw new Error(`KODADE_MCP_PATH does not point to a file: ${override}`);
    return override;
  }

  const debug = [
    resolve(scriptDir, "..", "..", "src-tauri", "target", "debug", name),
    resolve(cwd, "src-tauri", "target", "debug", name),
    join(execDir, name),
  ].find(isFile);
  if (debug) return debug;
  throw new Error(
    `Could not find ${name}. Set KODADE_MCP_PATH or build it with cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin kodade-mcp.`,
  );
}

/** Minimal JSON-RPC client for the newline-delimited MCP stdio transport used by rmcp. */
export class StdioMemoryMcpClient implements MemoryCheckpointClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private stderrTail = "";
  private closed = false;

  constructor(
    binary: string,
    workspaceRoot: string,
    private readonly requestTimeoutMs = CALL_TIMEOUT_MS,
    private readonly clientName = "kodade-local",
    databasePath?: string,
  ) {
    const args = [
      ...(databasePath ? ["--db", databasePath] : []),
      "--workspace",
      workspaceRoot,
      "--client",
      clientName,
    ];
    this.child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(
        -MAX_STDERR_CHARS,
      );
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        this.failAll(
          new Error(
            `kodade-mcp exited before completing the request (${signal ?? `code ${code ?? "unknown"}`})${this.stderrHint()}`,
          ),
        );
      }
    });
  }

  async initialize(): Promise<string> {
    const result = asObject(
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: "1.3.0" },
      }),
    );
    if (!result) {
      throw new Error("kodade-mcp returned a malformed initialize result");
    }
    if (result?.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new Error(
        `kodade-mcp negotiated unsupported protocol ${String(result?.protocolVersion ?? "unknown")}`,
      );
    }
    this.notify("notifications/initialized");
    return MCP_PROTOCOL_VERSION;
  }

  async getContext(workspaceRoot: string): Promise<ProjectMemoryContext> {
    return (await this.callTool("get_context", {
      workspaceRoot,
    })) as ProjectMemoryContext;
  }

  async searchMemories(input: {
    workspaceRoot: string;
    query: string;
    kinds?: string[];
    sources?: string[];
    limit?: number;
    offset?: number;
  }): Promise<unknown> {
    return this.callTool("search_memories", input);
  }

  async getMemory(workspaceRoot: string, id: string): Promise<unknown> {
    return this.callTool("get_memory", { workspaceRoot, id });
  }

  async remember(input: {
    workspaceRoot: string;
    kind: "summary" | "decision" | "task" | "fact" | "preference";
    title: string;
    body: string;
    sessionId?: string;
    idempotencyKey?: string;
  }): Promise<unknown> {
    return this.callTool("remember", input);
  }

  async checkpoint(input: MemoryCheckpointInput): Promise<unknown> {
    return this.callTool("checkpoint", input);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill();
  }

  private notify(method: string): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error("kodade-mcp client is closed"));
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(
          new Error(
            `kodade-mcp timed out calling ${method}${this.stderrHint()}`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          pending.reject(
            new Error(`failed to write to kodade-mcp: ${error.message}`),
          );
        },
      );
    });
  }

  private async callTool(
    name: string,
    arguments_: JsonObject,
  ): Promise<unknown> {
    const result = asObject(
      await this.request("tools/call", { name, arguments: arguments_ }),
    );
    if (!result)
      throw new Error(`kodade-mcp returned an invalid ${name} result`);
    if (result.isError === true) {
      throw new Error(
        errorMessage(result.structuredContent ?? result.content ?? result),
      );
    }
    if (!("structuredContent" in result)) {
      throw new Error(`kodade-mcp returned an unstructured ${name} result`);
    }
    return result.structuredContent;
  }

  private handleLine(line: string): void {
    let message: JsonObject | null;
    try {
      message = asObject(JSON.parse(line));
    } catch {
      this.failAll(new Error("kodade-mcp returned a malformed JSON frame"));
      return;
    }
    const id = message?.id;
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if ("error" in message && message.error !== undefined) {
      pending.reject(
        new Error(`kodade-mcp RPC error: ${errorMessage(message.error)}`),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stderrHint(): string {
    const detail = this.stderrTail.trim();
    return detail ? `: ${detail}` : "";
  }
}

/** Connect once at agent-session start; all failures are enhancement-only. */
export async function connectMemoryMcp(
  options: ConnectOptions,
): Promise<MemoryMcpConnection> {
  let client: StdioMemoryMcpClient | null = null;
  try {
    const binary = options.binary ?? resolveMcpBinary();
    if (!isFile(binary))
      return {
        available: false,
        reason: `kodade-mcp is unavailable at ${binary}`,
      };
    client = new StdioMemoryMcpClient(
      binary,
      options.workspaceRoot,
      options.requestTimeoutMs,
      options.clientName,
      options.databasePath,
    );
    const protocolVersion = await client.initialize();
    const context = await client.getContext(options.workspaceRoot);
    return { available: true, client, context, protocolVersion };
  } catch (error) {
    await client?.close();
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
