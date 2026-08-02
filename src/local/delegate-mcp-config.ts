import { stringify as stringifyToml } from "smol-toml";
import type { McpServerSpec } from "../harness/merge";
import type { MemoryMcpClient } from "../memory/mcp-config";

type ReadyDelegateMcpSetup = {
  state: "ready";
  spec(client: MemoryMcpClient): McpServerSpec;
};

export type DelegateMcpSetup =
  | ReadyDelegateMcpSetup
  | { state: "entitlement-required" }
  | { state: "workspace-required" }
  | { state: "bundle-required" };

export function buildDelegateMcpSetup(input: {
  workspaceId: string | null;
  workspaceRoot: string | null;
  bundlePath: string | null;
  entitled: boolean;
}): DelegateMcpSetup {
  if (!input.entitled) return { state: "entitlement-required" };
  if (!input.workspaceId || !input.workspaceRoot) {
    return { state: "workspace-required" };
  }
  if (!input.bundlePath) return { state: "bundle-required" };
  const workspaceSuffix = input.workspaceId.replace(/[^A-Za-z0-9_-]/g, "-");
  return {
    state: "ready",
    spec(client) {
      return {
        name:
          client === "codex"
            ? `kodade-local-delegate-${workspaceSuffix}`
            : "kodade-local-delegate",
        config: {
          command: "node",
          args: [
            input.bundlePath,
            "delegate",
            "--project",
            input.workspaceRoot,
            "--delegating-agent",
            client,
          ],
        },
      };
    },
  };
}

export function claudeDelegateMcpSnippet(setup: ReadyDelegateMcpSetup): string {
  const spec = setup.spec("claude");
  return JSON.stringify({ mcpServers: { [spec.name]: spec.config } }, null, 2);
}

export function codexDelegateMcpSnippet(setup: ReadyDelegateMcpSetup): string {
  const spec = setup.spec("codex");
  return stringifyToml({
    mcp_servers: { [spec.name]: spec.config },
  }).trimEnd();
}
