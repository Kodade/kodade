#!/usr/bin/env node
// KödLocal raw chat and Pro agent REPL. Tool execution is always delegated to
// one fixed-root native tool-host process; this Node entry point owns no file I/O
// beyond read-only harness assembly and its small license/config files.

import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  assembleLocalHarness,
  type LocalHarness,
} from "../../src/local/harness";
import { LocalAgentLoop } from "../../src/local/agent";
import { OpenAIHttpBackend, type ChatMessage } from "../../src/local/backend";
import { formatProjectMemory } from "../../src/local/memory";
import {
  toolCapabilityTier,
  type ToolCapabilityTier,
} from "../../src/local/models";
import { KODADE_BROWSER_TOOL_NAMES } from "../../src/local/tools";
import { approvalBanner } from "./approval";
import { loadProjectToolConfig, saveProjectToolConfig } from "./config";
import {
  createDelegateRunner,
  requireDelegateEntitlement,
  serveDelegateMcp,
} from "./delegate";
import { readHeadlessLicense, resolveAppDataDir } from "./license";
import { connectMemoryMcp } from "./memoryMcp";
import { createNodeHarnessFs } from "./nodeFs";
import { resolveToolHostBinary, StdioToolHost } from "./toolHost";
import { BrowserToolHost } from "./browserBridge";

type Options = {
  baseUrl: string;
  model?: string;
  agent: boolean;
  project: string;
  yolo: boolean | null;
};

type DelegateOptions = {
  baseUrl: string;
  model?: string;
  project: string;
  yolo: boolean;
  delegatingAgent?: string;
};

function usage(): string {
  return `Usage: kodade-local [--base-url http://127.0.0.1:4470] [--model <id>]
                    [--agent] [--project <root>] [--yolo | --confirm-each]
       kodade-local delegate [--base-url <url>] [--model <id>] [--project <root>]
                    [--delegating-agent <name>] [--yolo]`;
}

function parseDelegateArgs(args: string[]): DelegateOptions {
  let baseUrl = "http://127.0.0.1:4470";
  let model: string | undefined;
  let project = process.cwd();
  let yolo = false;
  let delegatingAgent: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base-url") {
      baseUrl = args[++index] ?? "";
      if (!baseUrl) throw new Error("--base-url requires a URL");
    } else if (arg === "--model") {
      model = args[++index] ?? "";
      if (!model) throw new Error("--model requires a model id");
    } else if (arg === "--project") {
      project = args[++index] ?? "";
      if (!project) throw new Error("--project requires a directory");
    } else if (arg === "--delegating-agent") {
      delegatingAgent = args[++index] ?? "";
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(delegatingAgent)) {
        throw new Error(
          "--delegating-agent must be 1-64 letters, digits, dots, underscores, or hyphens",
        );
      }
    } else if (arg === "--yolo") {
      yolo = true;
    } else if (arg === "-h" || arg === "--help") {
      stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`unknown delegate argument: ${arg}`);
    }
  }
  return {
    baseUrl,
    ...(model ? { model } : {}),
    project,
    yolo,
    ...(delegatingAgent ? { delegatingAgent } : {}),
  };
}

function parseArgs(args: string[]): Options {
  let baseUrl = "http://127.0.0.1:4470";
  let model: string | undefined;
  let agent = false;
  let project = process.cwd();
  let yolo: boolean | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base-url") {
      baseUrl = args[++index] ?? "";
      if (!baseUrl) throw new Error("--base-url requires a URL");
    } else if (arg === "--model") {
      model = args[++index] ?? "";
      if (!model) throw new Error("--model requires a model id");
    } else if (arg === "--agent") {
      agent = true;
    } else if (arg === "--project") {
      project = args[++index] ?? "";
      if (!project) throw new Error("--project requires a directory");
    } else if (arg === "--yolo") {
      yolo = true;
    } else if (arg === "--confirm-each") {
      yolo = false;
    } else if (arg === "-h" || arg === "--help") {
      stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { baseUrl, model, agent, project, yolo };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function projectPlatform(): "mac" | "windows" | "linux" {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "windows";
  return "linux";
}

async function resolveProject(path: string): Promise<string> {
  const root = await realpath(resolve(path));
  if (!(await stat(root)).isDirectory())
    throw new Error(`project is not a directory: ${root}`);
  return root;
}

function installCancellation(readline: Interface): {
  controller: () => AbortController;
  clear: () => void;
  dispose: () => void;
} {
  let active: AbortController | null = null;
  const abortGeneration = () => {
    if (active && !active.signal.aborted) {
      active.abort();
      stdout.write("\n^C generation cancelled\n");
    }
  };
  readline.on("SIGINT", abortGeneration);
  process.on("SIGINT", abortGeneration);
  return {
    controller: () => {
      active = new AbortController();
      return active;
    },
    clear: () => {
      active = null;
    },
    dispose: () => {
      readline.off("SIGINT", abortGeneration);
      process.off("SIGINT", abortGeneration);
    },
  };
}

async function rawChat(
  backend: OpenAIHttpBackend,
  model: string,
  upsell: string | null,
): Promise<void> {
  const readline = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  const cancellation = installCancellation(readline);
  const history: ChatMessage[] = [];
  stdout.write(
    `KödLocal raw chat · ${model} · /quit to exit · Ctrl-C cancels a reply\n`,
  );
  if (upsell) stdout.write(`${upsell}\n`);
  try {
    while (true) {
      let prompt: string;
      try {
        prompt = (await readline.question("\nYou> ")).trim();
      } catch {
        break;
      }
      if (!prompt) continue;
      if (prompt === "/quit" || prompt === "/exit") break;

      const controller = cancellation.controller();
      let measuredSpeed: number | undefined;
      let answer = "";
      history.push({ role: "user", content: prompt });
      stdout.write("KödLocal> ");
      try {
        for await (const delta of backend.chat(
          { model, messages: history },
          { signal: controller.signal },
        )) {
          if (delta.content) {
            answer += delta.content;
            stdout.write(delta.content);
          }
          if (delta.tokensPerSecond !== undefined)
            measuredSpeed = delta.tokensPerSecond;
        }
        stdout.write("\n");
        if (measuredSpeed !== undefined)
          stdout.write(`measured ${measuredSpeed.toFixed(1)} tok/s\n`);
      } catch (error) {
        if (!isAbort(error)) {
          stdout.write(
            `\nKödLocal error: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      } finally {
        cancellation.clear();
        if (answer) history.push({ role: "assistant", content: answer });
        if (history.length > 12) history.splice(0, history.length - 12);
      }
    }
  } finally {
    readline.close();
    cancellation.dispose();
  }
}

function printHarness(harness: LocalHarness): void {
  stdout.write("\n--- assembled harness ---\n");
  stdout.write(`${harness.systemPrompt}\n`);
  stdout.write("--- sources ---\n");
  for (const source of harness.sources) {
    stdout.write(`${source.scope} ${source.kind}: ${source.path}\n`);
  }
  for (const error of harness.errors)
    stdout.write(`scan warning: ${error.path}: ${error.message}\n`);
  stdout.write("--- end harness ---\n");
}

function printModel(
  model: string,
  ctx: number,
  tier: ToolCapabilityTier,
  constrained: boolean,
): void {
  stdout.write(
    `model: ${model}\ncontext: ${ctx} tokens (reported by /v1/models)\n`,
  );
  stdout.write(`${tier.banner}\n`);
  stdout.write(
    `tool grammar: ${constrained ? "backend-constrained" : "strict JSON + bounded repair"}\n`,
  );
}

async function agentChat(
  backend: OpenAIHttpBackend,
  model: string,
  projectRoot: string,
  hasTools: boolean,
  yoloFlag: boolean | null,
): Promise<void> {
  const models = await backend.listModels();
  const selected = models.find((candidate) => candidate.id === model);
  if (!selected?.ctx || selected.ctx <= 0) {
    throw new Error(
      `agent mode requires ${model} to report kod.ctx from /v1/models`,
    );
  }
  const capabilities = await backend.capabilities?.().catch(() => undefined);
  const constrained = capabilities?.supports.constrained === true;
  const tier = toolCapabilityTier(model);
  const harness = await assembleLocalHarness(createNodeHarnessFs(), {
    home: homedir(),
    platform: projectPlatform(),
    projectRoot,
    ...(process.platform === "win32"
      ? {
          appDataRoaming: process.env.APPDATA ?? null,
          appDataLocal: process.env.LOCALAPPDATA ?? null,
        }
      : {}),
  });
  const dataDir = resolveAppDataDir();
  let projectConfig = await loadProjectToolConfig(dataDir, projectRoot);
  if (yoloFlag !== null) {
    projectConfig = { autoApproveWrite: yoloFlag };
    await saveProjectToolConfig(dataDir, projectRoot, projectConfig);
  }

  const readline = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  const cancellation = installCancellation(readline);
  let nativeHost: StdioToolHost | null = null;
  const host = hasTools
    ? (nativeHost = new StdioToolHost(resolveToolHostBinary(), projectRoot))
    : new BrowserToolHost(projectRoot);
  // KödMem is enhancement-only. A missing binary, unregistered workspace, or
  // failed handshake never prevents the Pro agent loop from starting.
  const memoryConnection = await connectMemoryMcp({
    workspaceRoot: projectRoot,
  });
  const memoryContext = memoryConnection.available
    ? formatProjectMemory(memoryConnection.context)
    : undefined;
  const sessionId = randomUUID();
  let answerStarted = false;
  const loop = new LocalAgentLoop({
    backend,
    model,
    modelContextTokens: selected.ctx,
    harnessPrompt: harness.systemPrompt,
    memoryContext,
    ...(memoryConnection.available
      ? {
          memory: {
            client: memoryConnection.client,
            workspaceRoot: projectRoot,
            sessionId,
          },
        }
      : {}),
    projectRoot,
    constrained,
    host,
    policy: {
      entitled: hasTools,
      enabled: true,
      confirmEveryCall: tier.mode === "suggest",
      autoApproveWrite: projectConfig.autoApproveWrite,
      alwaysAllowedTools: KODADE_BROWSER_TOOL_NAMES,
    },
    confirm: async (preview) => {
      stdout.write(approvalBanner(preview));
      try {
        return /^(y|yes)$/i.test(
          (await readline.question("Approve? [y/N] ")).trim(),
        );
      } catch {
        return false;
      }
    },
    onActivity: (line) => stdout.write(`\n[tool] ${line}\n`),
    onAnswerDelta: (text) => {
      if (!answerStarted) {
        stdout.write("KödLocal> ");
        answerStarted = true;
      }
      stdout.write(text);
    },
  });

  stdout.write(`KödLocal agent · ${model} · project ${projectRoot}\n`);
  printModel(model, selected.ctx, tier, constrained);
  stdout.write(
    hasTools
      ? `tools: on · writes ${projectConfig.autoApproveWrite ? "auto-approved for this project" : "confirm each"}\n`
      : "tools: internal browser on · project tools suggest-only\n",
  );
  if (memoryConnection.available) {
    stdout.write(
      "memory: KödMem project context loaded · /memory to inspect\n",
    );
  } else {
    stdout.write(
      `memory: unavailable; continuing without KödMem (${memoryConnection.reason})\n`,
    );
  }
  stdout.write(
    "commands: /tools on|off · /harness · /memory · /model · /quit\n",
  );
  let cleanQuit = false;
  try {
    while (true) {
      let prompt: string;
      try {
        prompt = (await readline.question("\nYou> ")).trim();
      } catch {
        break;
      }
      if (!prompt) continue;
      if (prompt === "/quit" || prompt === "/exit") {
        cleanQuit = true;
        break;
      }
      if (prompt === "/harness") {
        printHarness(harness);
        continue;
      }
      if (prompt === "/model") {
        printModel(model, selected.ctx, tier, constrained);
        continue;
      }
      if (prompt === "/memory") {
        stdout.write("\n--- project memory (KödMem) ---\n");
        if (memoryConnection.available) {
          stdout.write(`${memoryContext}\n`);
        } else {
          stdout.write(`unavailable: ${memoryConnection.reason}\n`);
        }
        stdout.write("--- end project memory ---\n");
        continue;
      }
      if (prompt.startsWith("/tools")) {
        const value = prompt.split(/\s+/)[1];
        if (value !== "on" && value !== "off") {
          stdout.write("usage: /tools on|off\n");
          continue;
        }
        loop.setToolsEnabled(value === "on");
        stdout.write(
          `tools: ${
            loop.toolsEnabled()
              ? hasTools
                ? "on"
                : "internal browser on · project tools suggest-only"
              : "off (suggest-only)"
          }\n`,
        );
        continue;
      }

      const controller = cancellation.controller();
      answerStarted = false;
      try {
        const result = await loop.runUserTurn(prompt, controller.signal);
        if (answerStarted) stdout.write("\n");
        if (result.tokensPerSecond !== undefined) {
          stdout.write(`measured ${result.tokensPerSecond.toFixed(1)} tok/s\n`);
        }
      } catch (error) {
        if (!isAbort(error)) {
          stdout.write(
            `\nKödLocal error: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      } finally {
        cancellation.clear();
      }
    }
  } finally {
    if (cleanQuit) {
      const checkpoint = await loop.checkpointSession();
      if (checkpoint.status === "written") {
        stdout.write(
          `KödMem checkpoint saved (${checkpoint.idempotencyKey})\n`,
        );
      } else if (checkpoint.status === "failed") {
        stdout.write(`KödMem checkpoint skipped: ${checkpoint.reason}\n`);
      }
    }
    await nativeHost?.close();
    if (memoryConnection.available) await memoryConnection.client.close();
    readline.close();
    cancellation.dispose();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "delegate") {
    const options = parseDelegateArgs(args.slice(1));
    const license = await readHeadlessLicense();
    requireDelegateEntitlement(license);
    const projectRoot = await resolveProject(options.project);
    await serveDelegateMcp({
      input: stdin,
      output: stdout,
      yolo: options.yolo,
      runDelegate: createDelegateRunner({
        baseUrl: options.baseUrl,
        ...(options.model ? { model: options.model } : {}),
        projectRoot,
        hasTools: license.hasTools,
        ...(options.delegatingAgent
          ? { delegatingAgent: options.delegatingAgent }
          : {}),
      }),
    });
    return;
  }
  const options = parseArgs(args);
  const backend = new OpenAIHttpBackend({ baseURL: options.baseUrl });
  const models = await backend.listModels();
  const model = options.model ?? models[0]?.id;
  if (!model)
    throw new Error(
      "No model is loaded. Load a GGUF in Ködade's KödLocal Models panel first.",
    );
  if (!models.some((candidate) => candidate.id === model)) {
    throw new Error(`Model is not loaded: ${model}`);
  }

  const license = await readHeadlessLicense();
  const upsell = license.hasAgent
    ? null
    : "KödLocal Pro adds project harness and confined tools; this session remains free raw chat.";
  if (!options.agent || !license.hasAgent) {
    await rawChat(backend, model, upsell);
    return;
  }
  await agentChat(
    backend,
    model,
    await resolveProject(options.project),
    license.hasTools,
    options.yolo,
  );
}

void main().catch((error: unknown) => {
  stderr(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function stderr(message: string): void {
  process.stderr.write(`kodade-local: ${message}\n`);
}
