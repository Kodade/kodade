import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ToolHost } from "../../src/local/tools";
import { callBrowserBridge } from "./browserBridge";

type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  scriptPath?: string;
  cwd?: string;
  execPath?: string;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve the shipped sibling first, with source-tree fallbacks for development. */
export function resolveToolHostBinary(options: ResolveOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.KODADE_TOOL_HOST_PATH;
  if (override) {
    if (!isFile(override)) {
      throw new Error(`KODADE_TOOL_HOST_PATH does not point to a file: ${override}`);
    }
    return override;
  }

  const name = process.platform === "win32" ? "kodade-tool-host.exe" : "kodade-tool-host";
  const scriptDir = dirname(options.scriptPath ?? fileURLToPath(import.meta.url));
  const cwd = options.cwd ?? process.cwd();
  const execDir = dirname(options.execPath ?? process.execPath);
  const candidates = [
    join(scriptDir, name),
    join(scriptDir, "bin", name),
    resolve(scriptDir, "..", "..", "MacOS", name),
    resolve(scriptDir, "..", "..", "src-tauri", "target", "debug", name),
    resolve(cwd, "src-tauri", "target", "debug", name),
    join(execDir, name),
  ];
  const found = [...new Set(candidates)].find(isFile);
  if (found) return found;
  throw new Error(
    `Could not find ${name}. Set KODADE_TOOL_HOST_PATH or build it with cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --features development-features --bin kodade-tool-host.`,
  );
}

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ToolResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: unknown;
};

const CALL_TIMEOUT_MS = 20_000;
const MAX_STDERR_CHARS = 4_000;

/** One fixed-root JSON-lines process per KödLocal agent session. */
export class StdioToolHost implements ToolHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private stderrTail = "";
  private closed = false;
  private readonly projectRoot: string;

  constructor(binary: string, projectRoot: string) {
    this.projectRoot = projectRoot;
    this.child = spawn(binary, ["--project", projectRoot], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      lines.close();
      const detail = this.stderrTail.trim();
      this.failAll(
        new Error(
          `kodade-tool-host exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  }

  private failAll(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timeout);
      call.reject(error);
    }
    this.pending.clear();
  }

  private protocolFailure(message: string): void {
    this.closed = true;
    this.failAll(new Error(message));
    this.child.kill();
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.protocolFailure("kodade-tool-host returned malformed JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.protocolFailure("kodade-tool-host returned a malformed response frame");
      return;
    }
    const response = parsed as ToolResponse;
    if (!Number.isSafeInteger(response.id) || typeof response.ok !== "boolean") {
      this.protocolFailure("kodade-tool-host returned a malformed response frame");
      return;
    }
    const call = this.pending.get(response.id);
    if (!call) return;
    this.pending.delete(response.id);
    clearTimeout(call.timeout);
    if (response.ok) {
      call.resolve(response.result);
    } else {
      call.reject(new Error(typeof response.error === "string" ? response.error : "tool command failed"));
    }
  }

  call(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    if (cmd === "browser_agent_command") {
      return callBrowserBridge(this.projectRoot, args);
    }
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new Error("kodade-tool-host is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`kodade-tool-host call timed out: ${cmd}`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolveCall, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolveClose();
      }, 1_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }
}
