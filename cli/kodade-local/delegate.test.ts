/// <reference types="node" />

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  BackendCapabilities,
  ChatDelta,
  ChatRequest,
  ChatResponse,
  InferenceBackend,
  InferenceModel,
} from "../../src/local/backend";
import {
  MCP_PROTOCOL_VERSION,
  requireDelegateEntitlement,
  resolveDelegateContextRefs,
  runDelegateLoop,
  serveDelegateMcp,
  validateDelegateArguments,
} from "./delegate";

class DelegateBackend implements InferenceBackend {
  constructor(private readonly replies: string[]) {}
  async *chat(_request: ChatRequest): AsyncIterable<ChatDelta> {
    const content = this.replies.shift();
    if (content === undefined) throw new Error("no delegated reply");
    yield { content };
  }
  async chatOnce(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error("no checkpoint expected");
  }
  async listModels(): Promise<InferenceModel[]> {
    return [];
  }
  async capabilities(): Promise<BackendCapabilities> {
    return {
      supports: {
        tools: true,
        grammar: true,
        constrained: true,
        embeddings: false,
      },
    };
  }
}

describe("KödLocal delegate arguments", () => {
  it("refuses server startup without local.orchestrate", () => {
    expect(() =>
      requireDelegateEntitlement({ hasAgent: true, hasOrchestrate: false }),
    ).toThrow("local.orchestrate");
    expect(() =>
      requireDelegateEntitlement({ hasAgent: false, hasOrchestrate: true }),
    ).toThrow("local.agent");
    expect(() =>
      requireDelegateEntitlement({ hasAgent: true, hasOrchestrate: true }),
    ).not.toThrow();
  });

  it("defaults each delegation to the read-only M14e tool subset", () => {
    expect(
      validateDelegateArguments(
        { task: "Summarize the project." },
        { yolo: false },
      ),
    ).toMatchObject({
      task: "Summarize the project.",
      toolNames: ["read_file", "list_dir", "git", "gh"],
      writeExecutionEnabled: false,
      budget: { maxToolTurns: 6, maxTokens: 768 },
    });
  });

  it("rejects unknown tools instead of widening the fixed M14e boundary", () => {
    expect(() =>
      validateDelegateArguments(
        { task: "Inspect the repo.", tools_allowed: ["read_file", "shell"] },
        { yolo: true },
      ),
    ).toThrow('unknown delegate tool "shell"');
  });

  it.each(["WRITE_FILE", "Read_File"])(
    "rejects the case-sensitive tool alias %s",
    (tool) => {
      expect(() =>
        validateDelegateArguments(
          { task: "Inspect the repo.", tools_allowed: [tool] },
          { yolo: true },
        ),
      ).toThrow(`unknown delegate tool "${tool}"`);
    },
  );

  it("requires both an explicit write tool and server yolo before writes can execute", () => {
    const headlessSafe = validateDelegateArguments(
      { task: "Draft a note.", tools_allowed: ["write_file"] },
      { yolo: false },
    );
    const explicitlyWritable = validateDelegateArguments(
      { task: "Draft a note.", tools_allowed: ["write_file"] },
      { yolo: true },
    );

    expect(headlessSafe).toMatchObject({
      toolNames: ["write_file"],
      writeExecutionEnabled: false,
    });
    expect(explicitlyWritable.writeExecutionEnabled).toBe(true);
  });

  it("accepts only budgets that narrow the existing loop bounds", () => {
    expect(
      validateDelegateArguments(
        {
          task: "Read one file.",
          budget: { max_tool_turns: 2, max_tokens: 256 },
        },
        { yolo: false },
      ).budget,
    ).toEqual({ maxToolTurns: 2, maxTokens: 256 });

    for (const budget of [
      { max_tool_turns: 7, max_tokens: 256 },
      { max_tool_turns: 2, max_tokens: 769 },
      { max_tool_turns: -1, max_tokens: 256 },
    ]) {
      expect(() =>
        validateDelegateArguments(
          { task: "No widening.", budget },
          { yolo: false },
        ),
      ).toThrow(/budget/);
    }
  });

  it("resolves file and memory context references through read-only confined seams", async () => {
    const host = {
      call: vi
        .fn()
        .mockResolvedValue({ kind: "text", content: "project instructions" }),
    };
    const getMemory = vi.fn().mockResolvedValue({
      id: "mem_0123456789abcdef0123456789abcdef",
      title: "Architecture",
      body: "Use the existing loop.",
    });

    const context = await resolveDelegateContextRefs(
      ["file:AGENTS.md", "memory:mem_0123456789abcdef0123456789abcdef"],
      { projectRoot: "/repo", host, memory: { getMemory } },
    );

    expect(host.call).toHaveBeenCalledWith("fs_read_file", {
      path: "/repo/AGENTS.md",
    });
    expect(getMemory).toHaveBeenCalledWith(
      "/repo",
      "mem_0123456789abcdef0123456789abcdef",
    );
    expect(context).toContain("project instructions");
    expect(context).toContain("Use the existing loop.");

    host.call.mockRejectedValueOnce(
      new Error("path is outside the project root"),
    );
    await expect(
      resolveDelegateContextRefs(["file:../outside.txt"], {
        projectRoot: "/repo",
        host,
        memory: { getMemory },
      }),
    ).rejects.toThrow("outside the project root");
  });

  it("returns a requested write as a frontier artifact when server yolo is off", async () => {
    const host = { call: vi.fn() };
    const input = validateDelegateArguments(
      { task: "Write notes.txt.", tools_allowed: ["write_file"] },
      { yolo: false },
    );

    const result = await runDelegateLoop(input, {
      backend: new DelegateBackend([
        JSON.stringify({
          tool: "write_file",
          args: { path: "notes.txt", content: "frontier applies this" },
        }),
        JSON.stringify({
          tool: "answer",
          args: {
            text: "I prepared the requested write for the frontier agent.",
          },
        }),
      ]),
      model: "qwen3-4b",
      modelContextTokens: 4096,
      harnessPrompt: "PROJECT HARNESS",
      projectRoot: "/repo",
      constrained: true,
      host,
      hasTools: true,
      delegatingAgent: "codex",
    });

    expect(host.call).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result: "I prepared the requested write for the frontier agent.",
      complete: true,
      artifacts: [
        {
          type: "suggested_tool",
          tool: "write_file",
          args: { path: "notes.txt", content: "frontier applies this" },
        },
      ],
    });
  });

  it("runs no tools when the delegation tool-turn budget is zero", async () => {
    const host = { call: vi.fn() };
    const input = validateDelegateArguments(
      {
        task: "Inspect AGENTS.md.",
        budget: { max_tool_turns: 0, max_tokens: 256 },
      },
      { yolo: false },
    );

    const result = await runDelegateLoop(input, {
      backend: new DelegateBackend([
        JSON.stringify({ tool: "read_file", args: { path: "AGENTS.md" } }),
        "I could not inspect AGENTS.md because this delegation allows no tool calls.",
      ]),
      model: "qwen3-4b",
      modelContextTokens: 4096,
      harnessPrompt: "PROJECT HARNESS",
      projectRoot: "/repo",
      constrained: true,
      host,
      hasTools: true,
    });

    expect(host.call).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result:
        "I could not inspect AGENTS.md because this delegation allows no tool calls.",
      complete: false,
      incompleteReason: "delegation stopped at the 0-tool-turn budget",
    });
  });

  it("negotiates MCP and exposes exactly one delegate tool over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const runDelegate = async () => ({
      result: "grounded result",
      complete: true,
      artifacts: [],
    });
    const serving = serveDelegateMcp({
      input,
      output,
      runDelegate,
      yolo: false,
    });

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "codex", version: "1" },
        },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "delegate", arguments: { task: "Inspect AGENTS.md" } },
      })}\n`,
    );
    input.end();
    await serving;

    const messages = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: MCP_PROTOCOL_VERSION },
    });
    expect(messages[1]).toMatchObject({
      id: 2,
      result: { tools: [{ name: "delegate" }] },
    });
    expect(messages[2]).toMatchObject({
      id: 3,
      result: {
        isError: false,
        structuredContent: { result: "grounded result", complete: true },
      },
    });
  });
});
