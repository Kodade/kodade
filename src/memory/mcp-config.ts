import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { McpFormat, McpServerSpec } from "../harness/merge";

export type MemoryMcpClient = "claude" | "codex";

type ReadyMemoryMcpSetup = {
  state: "ready";
  spec(client: MemoryMcpClient): McpServerSpec;
};

export type MemoryMcpSetup =
  | ReadyMemoryMcpSetup
  | { state: "workspace-required" }
  | { state: "binary-required" };

type SetupInput = {
  workspaceId: string | null;
  workspaceRoot: string | null;
  binaryPath: string | null;
  readOnly: boolean;
};

// The MCP server discovers Kodade's app-data database itself. The generated
// client config only scopes the server to the registered workspace and records
// the CLI name for audit provenance.
export function buildMemoryMcpSetup({
  workspaceId,
  workspaceRoot,
  binaryPath,
  readOnly,
}: SetupInput): MemoryMcpSetup {
  if (!workspaceId || !workspaceRoot) return { state: "workspace-required" };
  if (!binaryPath) return { state: "binary-required" };

  return {
    state: "ready",
    spec(client) {
      return {
        // Claude's config is per-project, but Codex has one global config. Keep
        // distinct workspace entries there so its safe merge never confuses two
        // KödMem roots for the same user.
        name: client === "codex" ? `kodade-mem-${workspaceId.slice(0, 8)}` : "kodade-mem",
        config: {
          command: binaryPath,
          args: [
            "--workspace",
            workspaceRoot,
            "--client",
            client,
            ...(readOnly ? ["--read-only"] : []),
          ],
        },
      };
    },
  };
}

export function claudeMcpSnippet(setup: ReadyMemoryMcpSetup, client: "claude" = "claude"): string {
  const spec = setup.spec(client);
  return JSON.stringify({ mcpServers: { [spec.name]: spec.config } }, null, 2);
}

export function codexMcpSnippet(setup: ReadyMemoryMcpSetup): string {
  const spec = setup.spec("codex");
  return stringifyToml({ mcp_servers: { [spec.name]: spec.config } }).trimEnd();
}

export function memoryMcpConfigMatches(
  content: string,
  format: McpFormat,
  keyPath: string,
  expected: McpServerSpec,
): boolean {
  try {
    let parsed: unknown;
    if (format === "toml") {
      parsed = parseToml(content);
    } else {
      const errors: ParseError[] = [];
      parsed = parseJsonc(content, errors, {
        allowTrailingComma: true,
        disallowComments: false,
      });
      if (errors.length > 0) return false;
    }
    const serverMap = keyPath
      .split(".")
      .reduce<Record<string, unknown> | null>((current, segment) => {
        const next = current?.[segment];
        return next !== null &&
          typeof next === "object" &&
          !Array.isArray(next)
          ? (next as Record<string, unknown>)
          : null;
      }, asObject(parsed));
    const configured = asObject(serverMap?.[expected.name]);
    if (!configured) return false;
    return sameConfigValue(configured, expected.config);
  } catch {
    return false;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameConfigValue(value, right[index]))
    );
  }
  const leftObject = asObject(left);
  const rightObject = asObject(right);
  if (leftObject || rightObject) {
    if (!leftObject || !rightObject) return false;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          sameConfigValue(leftObject[key], rightObject[key]),
      )
    );
  }
  return left === right;
}
