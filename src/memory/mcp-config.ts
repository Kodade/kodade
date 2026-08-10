import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { McpFormat, McpKeyPath, McpServerSpec } from "../harness/merge";

export type MemoryMcpClient = "claude" | "codex";
export const KODADE_ONBOARDING_BASELINE_ENV = "KODADE_ONBOARDING_BASELINE";

export type MemoryMcpConfigState =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "drifted" }
  | { state: "matched"; spec: McpServerSpec; baseline: string | null };

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
        name: client === "codex" ? `kodade-mem-${workspaceId}` : "kodade-mem",
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
  keyPath: McpKeyPath,
  expected: McpServerSpec,
): boolean {
  return inspectMemoryMcpConfig(content, format, keyPath, [expected]).state === "matched";
}

export function withMemoryMcpBaseline(
  spec: McpServerSpec,
  baseline: "absent" | string,
): McpServerSpec {
  return {
    ...spec,
    config: {
      ...spec.config,
      env: { [KODADE_ONBOARDING_BASELINE_ENV]: baseline },
    },
  };
}

export function inspectMemoryMcpConfig(
  content: string,
  format: McpFormat,
  keyPath: McpKeyPath,
  expected: readonly McpServerSpec[],
): MemoryMcpConfigState {
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
      if (errors.length > 0) return { state: "unreadable" };
    }
    const serverMap = (typeof keyPath === "string" ? keyPath.split(".") : [...keyPath])
      .reduce<Record<string, unknown> | null>((current, segment) => {
        const next = current?.[segment];
        return next !== null &&
          typeof next === "object" &&
          !Array.isArray(next)
          ? (next as Record<string, unknown>)
          : null;
      }, asObject(parsed));
    const name = expected[0]?.name;
    if (!name || !Object.prototype.hasOwnProperty.call(serverMap ?? {}, name)) {
      return { state: "absent" };
    }
    const configured = asObject(serverMap?.[name]);
    if (!configured) return { state: "drifted" };
    for (const candidate of expected) {
      if (candidate.name !== name) continue;
      if (sameConfigValue(configured, candidate.config)) {
        return { state: "matched", spec: candidate, baseline: null };
      }
      const env = asObject(configured.env);
      const baseline = env?.[KODADE_ONBOARDING_BASELINE_ENV];
      if (
        env !== null &&
        typeof baseline === "string" &&
        (baseline === "absent" || /^[a-f0-9]{64}$/.test(baseline)) &&
        Object.keys(env).length === 1
      ) {
        const withoutBaseline = { ...configured };
        delete withoutBaseline.env;
        if (sameConfigValue(withoutBaseline, candidate.config)) {
          return {
            state: "matched",
            spec: withMemoryMcpBaseline(candidate, baseline),
            baseline,
          };
        }
      }
    }
    return { state: "drifted" };
  } catch {
    return { state: "unreadable" };
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
