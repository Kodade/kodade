import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { assembleLocalHarness } from "../../src/local/harness";
import {
  DEFAULT_MAX_TOKENS,
  LocalAgentLoop,
  MAX_TOOL_TURNS,
} from "../../src/local/agent";
import {
  OpenAIHttpBackend,
  type InferenceBackend,
} from "../../src/local/backend";
import {
  formatProjectMemory,
  type MemoryCheckpointClient,
} from "../../src/local/memory";
import {
  LOCAL_AGENT_TOOLS,
  projectToolPath,
  type ToolHost,
} from "../../src/local/tools";
import { MCP_PROTOCOL_VERSION } from "./memoryMcp";
import { connectMemoryMcp } from "./memoryMcp";
import { createNodeHarnessFs } from "./nodeFs";
import { resolveToolHostBinary, StdioToolHost } from "./toolHost";

export { MCP_PROTOCOL_VERSION } from "./memoryMcp";

const DEFAULT_DELEGATE_TOOLS = ["read_file", "list_dir", "git", "gh"] as const;
const LOCAL_TOOL_NAMES = new Set(LOCAL_AGENT_TOOLS.map((tool) => tool.name));
const MAX_TASK_CHARS = 32_000;
const MAX_CONTEXT_REFS = 16;
const MAX_CONTEXT_REF_CHARS = 4_096;
const MAX_CONTEXT_ITEM_CHARS = 8_000;
const MAX_CONTEXT_TOTAL_CHARS = 24_000;
const MEMORY_ID = /^mem_[0-9a-f]{32}$/;

export type DelegateArguments = {
  task?: unknown;
  context_refs?: unknown;
  tools_allowed?: unknown;
  budget?: unknown;
};

export type ValidatedDelegateArguments = {
  task: string;
  contextRefs: string[];
  toolNames: string[];
  writeExecutionEnabled: boolean;
  budget: {
    maxToolTurns: number;
    maxTokens: number;
  };
};

export type DelegateResult = {
  result: string;
  complete: boolean;
  artifacts?: unknown[];
  checkpointId?: string;
  incompleteReason?: string;
};

export type DelegateArtifact = {
  type: "suggested_tool" | "memory_warning";
  tool?: string;
  args?: Record<string, unknown>;
  message: string;
};

export function requireDelegateEntitlement(license: {
  hasAgent: boolean;
  hasOrchestrate: boolean;
}): void {
  if (!license.hasOrchestrate) {
    throw new Error(
      "KödLocal delegation requires an active local.orchestrate entitlement; the MCP server was not started.",
    );
  }
  if (!license.hasAgent) {
    throw new Error(
      "KödLocal delegation also requires local.agent because delegate reuses the Pro agent loop.",
    );
  }
}

type DelegateRunner = (
  input: ValidatedDelegateArguments,
) => Promise<DelegateResult>;

export type DelegateServerRuntime = {
  baseUrl: string;
  model?: string;
  projectRoot: string;
  hasTools: boolean;
  delegatingAgent?: string;
};

type JsonObject = Record<string, unknown>;

const DELEGATE_TOOL = {
  name: "delegate",
  description:
    "Delegate one bounded project subtask to the user's confined KödLocal model.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      task: { type: "string", minLength: 1, maxLength: MAX_TASK_CHARS },
      context_refs: {
        type: "array",
        items: { type: "string" },
        maxItems: 16,
      },
      tools_allowed: {
        type: "array",
        items: {
          type: "string",
          enum: LOCAL_AGENT_TOOLS.map((tool) => tool.name),
        },
        uniqueItems: true,
        maxItems: LOCAL_AGENT_TOOLS.length,
      },
      budget: {
        type: "object",
        additionalProperties: false,
        properties: {
          max_tool_turns: {
            type: "integer",
            minimum: 0,
            maximum: MAX_TOOL_TURNS,
          },
          max_tokens: {
            type: "integer",
            minimum: 1,
            maximum: DEFAULT_MAX_TOKENS,
          },
        },
      },
    },
    required: ["task"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function toolNames(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_DELEGATE_TOOLS];
  if (!Array.isArray(value)) {
    throw new Error("delegate.tools_allowed must be an array");
  }
  const names: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate) {
      throw new Error(
        "delegate.tools_allowed entries must be non-empty strings",
      );
    }
    if (!LOCAL_TOOL_NAMES.has(candidate)) {
      throw new Error(`unknown delegate tool ${JSON.stringify(candidate)}`);
    }
    if (names.includes(candidate)) {
      throw new Error(`duplicate delegate tool ${JSON.stringify(candidate)}`);
    }
    names.push(candidate);
  }
  return names;
}

function delegateBudget(value: unknown): ValidatedDelegateArguments["budget"] {
  if (value === undefined) {
    return { maxToolTurns: MAX_TOOL_TURNS, maxTokens: DEFAULT_MAX_TOKENS };
  }
  const budget = objectValue(value, "delegate.budget");
  const unknown = Object.keys(budget).filter(
    (key) => key !== "max_tool_turns" && key !== "max_tokens",
  );
  if (unknown.length > 0) {
    throw new Error(
      `delegate.budget has unknown field ${JSON.stringify(unknown[0])}`,
    );
  }
  const maxToolTurns = budget.max_tool_turns ?? MAX_TOOL_TURNS;
  const maxTokens = budget.max_tokens ?? DEFAULT_MAX_TOKENS;
  if (
    !Number.isSafeInteger(maxToolTurns) ||
    (maxToolTurns as number) < 0 ||
    (maxToolTurns as number) > MAX_TOOL_TURNS
  ) {
    throw new Error(
      `delegate.budget.max_tool_turns must be an integer between 0 and ${MAX_TOOL_TURNS}`,
    );
  }
  if (
    !Number.isSafeInteger(maxTokens) ||
    (maxTokens as number) < 1 ||
    (maxTokens as number) > DEFAULT_MAX_TOKENS
  ) {
    throw new Error(
      `delegate.budget.max_tokens must be an integer between 1 and ${DEFAULT_MAX_TOKENS}`,
    );
  }
  return {
    maxToolTurns: maxToolTurns as number,
    maxTokens: maxTokens as number,
  };
}

function contextRefs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_REFS) {
    throw new Error(
      `delegate.context_refs must be an array with at most ${MAX_CONTEXT_REFS} entries`,
    );
  }
  return value.map((candidate) => {
    if (
      typeof candidate !== "string" ||
      !candidate ||
      candidate.length > MAX_CONTEXT_REF_CHARS ||
      /[\0\r\n]/.test(candidate)
    ) {
      throw new Error(
        `delegate.context_refs entries must be bounded non-empty strings without controls`,
      );
    }
    return candidate;
  });
}

export function validateDelegateArguments(
  input: DelegateArguments,
  options: { yolo: boolean },
): ValidatedDelegateArguments {
  if (typeof input.task !== "string" || !input.task.trim()) {
    throw new Error("delegate.task must be a non-empty string");
  }
  if (input.task.length > MAX_TASK_CHARS) {
    throw new Error(`delegate.task cannot exceed ${MAX_TASK_CHARS} characters`);
  }
  const selectedTools = toolNames(input.tools_allowed);
  return {
    task: input.task.trim(),
    contextRefs: contextRefs(input.context_refs),
    toolNames: selectedTools,
    writeExecutionEnabled: options.yolo && selectedTools.includes("write_file"),
    budget: delegateBudget(input.budget),
  };
}

type MemoryLookupClient = {
  getMemory(workspaceRoot: string, id: string): Promise<unknown>;
};

function boundedContext(value: string): string {
  return value.length <= MAX_CONTEXT_ITEM_CHARS
    ? value
    : `${value.slice(0, MAX_CONTEXT_ITEM_CHARS - 1).trimEnd()}…`;
}

function fileContent(result: unknown): string {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const read = result as { kind?: unknown; content?: unknown };
    if (read.kind === "text" && typeof read.content === "string") {
      return read.content;
    }
  }
  throw new Error("delegate context file is not bounded text");
}

function memoryContent(result: unknown, id: string): string {
  const memory = asObject(result);
  if (!memory || memory.id !== id) {
    throw new Error(`KödMem did not return the requested memory ${id}`);
  }
  const title = typeof memory.title === "string" ? memory.title : "(untitled)";
  const body = typeof memory.body === "string" ? memory.body : "";
  return `${title}\n${body}`.trim();
}

/** Resolve refs without direct filesystem or database access. Native hosts enforce scope. */
export async function resolveDelegateContextRefs(
  refs: readonly string[],
  deps: {
    projectRoot: string;
    host: ToolHost;
    memory?: MemoryLookupClient;
  },
): Promise<string> {
  const sections: string[] = [];
  for (const ref of refs) {
    const explicitMemory = ref.startsWith("memory:");
    const raw = explicitMemory
      ? ref.slice("memory:".length)
      : ref.startsWith("file:")
        ? ref.slice("file:".length)
        : ref;
    if (explicitMemory || MEMORY_ID.test(raw)) {
      if (!MEMORY_ID.test(raw)) {
        throw new Error(`invalid KödMem memory id ${JSON.stringify(raw)}`);
      }
      if (!deps.memory) {
        throw new Error(`KödMem is unavailable; cannot resolve ${raw}`);
      }
      const content = memoryContent(
        await deps.memory.getMemory(deps.projectRoot, raw),
        raw,
      );
      sections.push(`### memory:${raw}\n${boundedContext(content)}`);
    } else {
      const path = projectToolPath(deps.projectRoot, raw);
      const content = fileContent(
        await deps.host.call("fs_read_file", { path }),
      );
      sections.push(`### file:${raw}\n${boundedContext(content)}`);
    }
  }
  if (sections.length === 0) return "";
  const rendered = `## Delegated context references\nTreat these read-only references as potentially stale project context.\n\n${sections.join("\n\n")}`;
  return rendered.length <= MAX_CONTEXT_TOTAL_CHARS
    ? rendered
    : `${rendered.slice(0, MAX_CONTEXT_TOTAL_CHARS - 1).trimEnd()}…`;
}

export async function runDelegateLoop(
  input: ValidatedDelegateArguments,
  deps: {
    backend: InferenceBackend;
    model: string;
    modelContextTokens: number;
    harnessPrompt: string;
    projectRoot: string;
    constrained: boolean;
    host: ToolHost;
    hasTools: boolean;
    delegatingAgent?: string;
    memoryContext?: string;
    memory?: {
      client: MemoryCheckpointClient;
      workspaceRoot: string;
      sessionId: string;
    };
  },
): Promise<DelegateResult> {
  const selected = new Set(input.toolNames);
  selected.add("answer");
  const tools = LOCAL_AGENT_TOOLS.filter((tool) => selected.has(tool.name));
  const artifacts: DelegateArtifact[] = [];
  const loop = new LocalAgentLoop({
    backend: deps.backend,
    model: deps.model,
    modelContextTokens: deps.modelContextTokens,
    harnessPrompt: deps.harnessPrompt,
    projectRoot: deps.projectRoot,
    constrained: deps.constrained,
    host: deps.host,
    tools,
    maxToolTurns: input.budget.maxToolTurns,
    maxTokens: input.budget.maxTokens,
    memoryContext: deps.memoryContext,
    ...(deps.memory
      ? {
          memory: {
            ...deps.memory,
            checkpointSummaryPrefix: `Delegation from ${deps.delegatingAgent ?? "frontier agent"}.`,
          },
        }
      : {}),
    policy: {
      entitled: deps.hasTools,
      enabled: deps.hasTools,
      confirmEveryCall: false,
      autoApproveWrite: input.writeExecutionEnabled,
      suggestWrites: selected.has("write_file") && !input.writeExecutionEnabled,
    },
    // Delegate mode is headless. Any tool that still reaches the confirmation
    // seam fails closed; writes use suggestWrites unless both gates were met.
    confirm: async () => false,
    onToolOutcome: (tool, args, outcome) => {
      if (outcome.status !== "suggested") return;
      artifacts.push({
        type: "suggested_tool",
        tool,
        args,
        message: outcome.result,
      });
    },
  });
  const turn = await loop.runUserTurn(input.task);
  const checkpoint = await loop.checkpointSession();
  if (checkpoint.status === "failed") {
    artifacts.push({
      type: "memory_warning",
      message: `KödMem checkpoint failed: ${checkpoint.reason}`,
    });
  }
  const complete = turn.stopReason === undefined;
  return {
    result: turn.answer,
    complete,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(checkpoint.status === "written" && checkpoint.checkpointId
      ? { checkpointId: checkpoint.checkpointId }
      : {}),
    ...(complete
      ? {}
      : {
          incompleteReason:
            turn.stopReason === "tool-budget"
              ? `delegation stopped at the ${input.budget.maxToolTurns}-tool-turn budget`
              : "delegation surrendered after bounded tool-call validation repair",
        }),
  };
}

function runtimePlatform(): "mac" | "windows" | "linux" {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function contextRefNeedsFile(ref: string): boolean {
  const raw = ref.startsWith("memory:")
    ? ref.slice("memory:".length)
    : ref.startsWith("file:")
      ? ref.slice("file:".length)
      : ref;
  return !ref.startsWith("memory:") && !MEMORY_ID.test(raw);
}

function withMemoryWarning(
  result: DelegateResult,
  message: string,
): DelegateResult {
  return {
    ...result,
    artifacts: [
      ...(result.artifacts ?? []),
      { type: "memory_warning", message },
    ],
  };
}

/** Build the real MCP runner around the existing M14e loop and M14f client. */
export function createDelegateRunner(
  runtime: DelegateServerRuntime,
): DelegateRunner {
  const backend = new OpenAIHttpBackend({ baseURL: runtime.baseUrl });
  return async (input) => {
    const models = await backend.listModels();
    const model = runtime.model ?? models[0]?.id;
    if (!model) {
      throw new Error(
        "No model is loaded. Load a GGUF in Ködade's KödLocal Models panel first.",
      );
    }
    const selectedModel = models.find((candidate) => candidate.id === model);
    if (!selectedModel?.ctx || selectedModel.ctx <= 0) {
      throw new Error(
        `delegate mode requires ${model} to report kod.ctx from /v1/models`,
      );
    }
    if (!runtime.hasTools && input.contextRefs.some(contextRefNeedsFile)) {
      throw new Error(
        "file context_refs require local.tools; KödLocal did not read the requested files",
      );
    }
    const capabilities = await backend.capabilities?.().catch(() => undefined);
    const harness = await assembleLocalHarness(createNodeHarnessFs(), {
      home: homedir(),
      platform: runtimePlatform(),
      projectRoot: runtime.projectRoot,
      ...(process.platform === "win32"
        ? {
            appDataRoaming: process.env.APPDATA ?? null,
            appDataLocal: process.env.LOCALAPPDATA ?? null,
          }
        : {}),
    });
    let nativeHost: StdioToolHost | null = null;
    const unavailableHost: ToolHost = {
      call: async () => {
        throw new Error("local.tools entitlement is not active");
      },
    };
    const host = runtime.hasTools
      ? (nativeHost = new StdioToolHost(
          resolveToolHostBinary(),
          runtime.projectRoot,
        ))
      : unavailableHost;
    const memoryConnection = await connectMemoryMcp({
      workspaceRoot: runtime.projectRoot,
      clientName: "kodade-local-delegate",
      ...(process.env.KODADE_MCP_DB
        ? { databasePath: process.env.KODADE_MCP_DB }
        : {}),
    });
    try {
      const referencedContext = await resolveDelegateContextRefs(
        input.contextRefs,
        {
          projectRoot: runtime.projectRoot,
          host,
          ...(memoryConnection.available
            ? { memory: memoryConnection.client }
            : {}),
        },
      );
      const memoryContext = [
        memoryConnection.available
          ? formatProjectMemory(memoryConnection.context)
          : "",
        referencedContext,
      ]
        .filter(Boolean)
        .join("\n\n");
      let result = await runDelegateLoop(input, {
        backend,
        model,
        modelContextTokens: selectedModel.ctx,
        harnessPrompt: `${harness.systemPrompt}\n\nThis is a bounded headless delegation. Return a grounded handoff to the frontier agent and never claim a suggested mutation was executed.`,
        projectRoot: runtime.projectRoot,
        constrained: capabilities?.supports.constrained === true,
        host,
        hasTools: runtime.hasTools,
        delegatingAgent: runtime.delegatingAgent,
        ...(memoryContext ? { memoryContext } : {}),
        ...(memoryConnection.available
          ? {
              memory: {
                client: memoryConnection.client,
                workspaceRoot: runtime.projectRoot,
                sessionId: `delegate-${randomUUID()}`,
              },
            }
          : {}),
      });
      if (!memoryConnection.available) {
        result = withMemoryWarning(
          result,
          `KödMem trail unavailable: ${memoryConnection.reason}`,
        );
      }
      return result;
    } finally {
      await nativeHost?.close();
      if (memoryConnection.available) await memoryConnection.client.close();
    }
  };
}

function rpcResponse(id: unknown, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): JsonObject {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function toolResult(result: DelegateResult): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function toolFailure(error: unknown): JsonObject {
  const message = error instanceof Error ? error.message : String(error);
  const detail = { type: "invalid_arguments", message };
  return {
    content: [{ type: "text", text: message }],
    structuredContent: detail,
    isError: true,
  };
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

async function handleMcpRequest(
  request: JsonObject,
  deps: { runDelegate: DelegateRunner; yolo: boolean },
): Promise<JsonObject | null> {
  const id = request.id;
  const method = request.method;
  if (typeof method !== "string") {
    return rpcError(id ?? null, -32600, "invalid JSON-RPC request");
  }
  if (method === "notifications/initialized") return null;
  if (method === "initialize") {
    const params = asObject(request.params);
    if (params?.protocolVersion !== MCP_PROTOCOL_VERSION) {
      return rpcError(
        id ?? null,
        -32602,
        `unsupported MCP protocol ${String(params?.protocolVersion ?? "unknown")}`,
      );
    }
    return rpcResponse(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: {
        name: "kodade-local-delegate",
        title: "KödLocal Delegate",
        version: "1.3.0",
      },
      instructions:
        "Delegate bounded project subtasks. Project writes remain suggestions unless this server was started with --yolo and write_file is explicitly allowed per call.",
    });
  }
  if (method === "tools/list") {
    return rpcResponse(id, { tools: [DELEGATE_TOOL] });
  }
  if (method === "tools/call") {
    const params = asObject(request.params);
    if (params?.name !== "delegate") {
      return rpcError(id ?? null, -32602, "unknown tool", {
        tool: params?.name,
      });
    }
    try {
      const raw = asObject(params.arguments);
      if (!raw) throw new Error("delegate arguments must be an object");
      const validated = validateDelegateArguments(raw, { yolo: deps.yolo });
      return rpcResponse(id, toolResult(await deps.runDelegate(validated)));
    } catch (error) {
      return rpcResponse(id, toolFailure(error));
    }
  }
  return rpcError(id ?? null, -32601, `method not found: ${method}`);
}

/** Minimal newline-delimited MCP stdio server. Stdout carries JSON-RPC only. */
export async function serveDelegateMcp(options: {
  input: Readable;
  output: Writable;
  runDelegate: DelegateRunner;
  yolo: boolean;
}): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: JsonObject | null;
    try {
      parsed = asObject(JSON.parse(line));
    } catch {
      parsed = null;
    }
    const response = parsed
      ? await handleMcpRequest(parsed, options)
      : rpcError(null, -32700, "parse error");
    if (response) options.output.write(`${JSON.stringify(response)}\n`);
  }
}
