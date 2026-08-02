/// <reference types="node" />

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectMemoryMcp, resolveMcpBinary } from "./memoryMcp";

const roots: string[] = [];
const SERVER_PROTOCOL_VERSION = "2026-07-28";

type FakeServerMode =
  | "success"
  | "tool-error"
  | "stalled-handshake"
  | "crash"
  | "malformed-json"
  | "malformed-result";

async function fakeMcpServer(mode: FakeServerMode): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodade-memory-mcp-"));
  roots.push(root);
  const binary = join(root, "fake-kodade-mcp");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const readline = require("node:readline").createInterface({ input: process.stdin });
const protocolVersion = ${JSON.stringify(SERVER_PROTOCOL_VERSION)};
readline.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    if (${JSON.stringify(mode)} === "stalled-handshake") return;
    if (${JSON.stringify(mode)} === "crash") {
      process.stderr.write("fixture crashed during initialize\\n");
      process.exit(17);
    }
    if (${JSON.stringify(mode)} === "malformed-json") {
      process.stdout.write("{not-json}\\n");
      return;
    }
    if (${JSON.stringify(mode)} === "malformed-result") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [] }) + "\\n");
      return;
    }
    if (request.params.protocolVersion !== protocolVersion) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "wrong protocol" } }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion } }) + "\\n");
    return;
  }
  if (request.method === "tools/call" && request.params.name === "get_context") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        isError: false,
        structuredContent: {
          workspace: { canonicalRoot: request.params.arguments.workspaceRoot },
          latestCheckpoint: { summary: "Resume the memory client work.", nextActions: ["Write the checkpoint."] },
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: []
        }
      }
    }) + "\\n");
    return;
  }
  if (request.method === "tools/call" && request.params.name === "checkpoint") {
    const result = ${JSON.stringify(mode)} === "tool-error"
      ? { isError: true, structuredContent: { type: "size_limit", message: "memory write rejected" } }
      : { isError: false, structuredContent: { id: "checkpoint-1" } };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    return;
  }
  if (request.method === "tools/call" && request.params.name === "search_memories") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { isError: false, structuredContent: { items: [] } }
    }) + "\\n");
    return;
  }
  if (request.method === "tools/call" && request.params.name === "get_memory") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        isError: false,
        structuredContent: {
          id: request.params.arguments.id,
          title: "Delegated context",
          body: "Read through KödMCP."
        }
      }
    }) + "\\n");
    return;
  }
  if (request.method === "tools/call" && request.params.name === "remember") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { isError: false, structuredContent: { id: "memory-1" } }
    }) + "\\n");
  }
});
`,
    "utf8",
  );
  await chmod(binary, 0o700);
  return binary;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("KödLocal KödMCP client", () => {
  it.skipIf(process.platform === "win32")(
    "negotiates rmcp stdio, loads project context, and writes a checkpoint",
    async () => {
      const binary = await fakeMcpServer("success");
      const connected = await connectMemoryMcp({
        binary,
        workspaceRoot: "/fixture/project",
      });

      expect(
        connected.available,
        connected.available ? undefined : connected.reason,
      ).toBe(true);
      if (!connected.available) throw new Error(connected.reason);
      expect(connected.protocolVersion).toBe(SERVER_PROTOCOL_VERSION);
      expect(connected.context.latestCheckpoint?.summary).toBe(
        "Resume the memory client work.",
      );
      await expect(
        connected.client.checkpoint({
          workspaceRoot: "/fixture/project",
          summary: "The agent completed its first task.",
          nextActions: ["Start the second task."],
          sessionId: "session-1",
          idempotencyKey: "session-1:end",
        }),
      ).resolves.toMatchObject({ id: "checkpoint-1" });
      await expect(
        connected.client.searchMemories({
          workspaceRoot: "/fixture/project",
          query: "checkpoint",
        }),
      ).resolves.toMatchObject({ items: [] });
      await expect(
        connected.client.getMemory(
          "/fixture/project",
          "mem_0123456789abcdef0123456789abcdef",
        ),
      ).resolves.toMatchObject({
        id: "mem_0123456789abcdef0123456789abcdef",
        body: "Read through KödMCP.",
      });
      await expect(
        connected.client.remember({
          workspaceRoot: "/fixture/project",
          kind: "summary",
          title: "A durable note",
          body: "A small project fact.",
        }),
      ).resolves.toMatchObject({ id: "memory-1" });
      await connected.client.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "surfaces a structured MCP tool error without crashing",
    async () => {
      const binary = await fakeMcpServer("tool-error");
      const connected = await connectMemoryMcp({
        binary,
        workspaceRoot: "/fixture/project",
      });

      expect(
        connected.available,
        connected.available ? undefined : connected.reason,
      ).toBe(true);
      if (!connected.available) throw new Error(connected.reason);
      await expect(
        connected.client.checkpoint({
          workspaceRoot: "/fixture/project",
          summary: "This write is rejected by the server.",
          nextActions: [],
          sessionId: "session-2",
          idempotencyKey: "session-2:end",
        }),
      ).rejects.toThrow("memory write rejected");
      await connected.client.close();
    },
  );

  it("reports a missing server as unavailable instead of rejecting agent startup", async () => {
    await expect(
      connectMemoryMcp({
        binary: join(tmpdir(), "missing-kodade-mcp"),
        workspaceRoot: "/fixture/project",
      }),
    ).resolves.toMatchObject({ available: false });
  });

  it.skipIf(process.platform === "win32")(
    "bounds a stalled MCP handshake with the client deadline",
    async () => {
      const binary = await fakeMcpServer("stalled-handshake");

      await expect(
        connectMemoryMcp({
          binary,
          workspaceRoot: "/fixture/project",
          requestTimeoutMs: 25,
        }),
      ).resolves.toMatchObject({
        available: false,
        reason: expect.stringContaining("timed out calling initialize"),
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports a nonzero server exit during the handshake",
    async () => {
      const binary = await fakeMcpServer("crash");

      await expect(
        connectMemoryMcp({
          binary,
          workspaceRoot: "/fixture/project",
          requestTimeoutMs: 500,
        }),
      ).resolves.toMatchObject({
        available: false,
        reason: expect.stringMatching(
          /code 17.*fixture crashed during initialize/s,
        ),
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects malformed JSON and malformed initialize result frames",
    async () => {
      for (const mode of ["malformed-json", "malformed-result"] as const) {
        const binary = await fakeMcpServer(mode);
        const connected = await connectMemoryMcp({
          binary,
          workspaceRoot: "/fixture/project",
          requestTimeoutMs: 500,
        });

        expect(connected.available).toBe(false);
        if (connected.available) await connected.client.close();
        else expect(connected.reason).toMatch(/malformed|invalid/i);
      }
    },
  );

  it("resolves kodade-mcp from the staged packaged resource layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodade-memory-package-"));
    roots.push(root);
    const binary = join(
      root,
      "Resources",
      "kodade-local",
      "bin",
      process.platform === "win32" ? "kodade-mcp.exe" : "kodade-mcp",
    );
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, "packaged fixture", { mode: 0o700 });

    expect(
      resolveMcpBinary({
        scriptPath: join(root, "Resources", "kodade-local", "kodade-local.mjs"),
        env: {},
        cwd: root,
        execPath: join(root, "MacOS", "kodade"),
      }),
    ).toBe(binary);
  });
});
