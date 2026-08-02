import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { ToolHost } from "../../src/local/tools";
import { resolveAppDataDir } from "./license";

const DESCRIPTOR_FILE = "kodade-browser.json";
const MAX_DESCRIPTOR_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;

type BrowserBridgeDescriptor = {
  version: number;
  port: number;
  token: string;
  pid: number;
};

function validDescriptor(value: unknown): value is BrowserBridgeDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const descriptor = value as Partial<BrowserBridgeDescriptor>;
  return (
    descriptor.version === 1 &&
    Number.isInteger(descriptor.port) &&
    Number(descriptor.port) > 0 &&
    Number(descriptor.port) <= 65_535 &&
    typeof descriptor.token === "string" &&
    /^[a-f0-9]{64}$/.test(descriptor.token) &&
    Number.isInteger(descriptor.pid) &&
    Number(descriptor.pid) > 0
  );
}

async function readDescriptor(dataDir: string): Promise<BrowserBridgeDescriptor> {
  const path = join(dataDir, DESCRIPTOR_FILE);
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.size > MAX_DESCRIPTOR_BYTES) {
    throw new Error(
      "Kodade's internal browser is unavailable; keep the Kodade desktop app open",
    );
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  let text: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_DESCRIPTOR_BYTES) {
      throw new Error("Kodade's internal browser connection file is invalid");
    }
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Kodade's internal browser connection file is invalid");
  }
  if (!validDescriptor(parsed)) {
    throw new Error("Kodade's internal browser connection is incompatible");
  }
  return parsed;
}

export async function callBrowserBridge(
  projectRoot: string,
  args: Record<string, unknown>,
  options: {
    dataDir?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<unknown> {
  const descriptor = await readDescriptor(options.dataDir ?? resolveAppDataDir());
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `http://127.0.0.1:${descriptor.port}/command`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...args, project_root: projectRoot }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  ).catch((error: unknown) => {
    throw new Error(
      `Kodade's internal browser did not respond: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (!response.ok) {
    throw new Error(
      `Kodade's internal browser rejected the request (${response.status})`,
    );
  }
  const reply = (await response.json()) as {
    result?: unknown;
    error?: unknown;
  };
  if (typeof reply.error === "string") throw new Error(reply.error);
  if (!Object.hasOwn(reply, "result")) {
    throw new Error("Kodade's internal browser returned an invalid outcome");
  }
  return reply.result;
}

export class BrowserToolHost implements ToolHost {
  constructor(private readonly projectRoot: string) {}

  call(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    if (cmd !== "browser_agent_command") {
      return Promise.reject(new Error(`project tool is unavailable: ${cmd}`));
    }
    return callBrowserBridge(this.projectRoot, args);
  }
}
