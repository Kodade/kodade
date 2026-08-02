import type { McpServerSpec } from "../harness/merge";
import { createHarnessAdapter } from "../harness/adapters/shared";
import type { HarnessAdapter, ArtifactLocation } from "../harness/contract";
import type { ScanContext } from "../harness/model";
import type { ConfigIpc } from "../ipc/contract";

const RULE_START = "<!-- kodade:browser:start -->";
const RULE_END = "<!-- kodade:browser:end -->";

export const KODADE_BROWSER_RULE = `${RULE_START}
When the \`kodade-browser\` tools are available, use them for every unqualified browser navigation, inspection, click, typing, and local web-app QA task. These tools control Kodade's visible internal browser. Use Chrome or another external browser only when the user explicitly requests that browser. If the internal browser is unavailable, report that instead of silently falling back.
${RULE_END}`;

export function browserMcpSpec(cli: string, binaryPath: string): McpServerSpec {
  if (cli === "opencode") {
    return {
      name: "kodade-browser",
      config: {
        type: "local",
        command: [binaryPath, "browser"],
        enabled: true,
      },
    };
  }
  return {
    name: "kodade-browser",
    config: {
      command: binaryPath,
      args: ["browser"],
    },
  };
}

export function ensureManagedBrowserRule(current: string): string {
  const start = current.indexOf(RULE_START);
  const end = current.indexOf(RULE_END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) {
    throw new Error("managed browser rule markers are incomplete");
  }
  if (start >= 0) {
    const after = end + RULE_END.length;
    return `${current.slice(0, start)}${KODADE_BROWSER_RULE}${current.slice(after)}`;
  }
  const separator = current.length === 0 || current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${KODADE_BROWSER_RULE}\n`;
}

type BrowserAgentSetupResult = {
  configured: string[];
  errors: string[];
};

const SUPPORTED_CLIS = new Set(["claude", "codex", "grok", "opencode"]);

async function applyVerified(
  adapter: HarnessAdapter,
  change: Awaited<ReturnType<HarnessAdapter["plan"]>>,
): Promise<void> {
  const receipt = await adapter.apply(change);
  const verified = await adapter.verify(receipt);
  if (verified.ok) return;
  try {
    await adapter.restore(receipt);
  } catch (restoreError) {
    throw new Error(
      `${verified.reason}; restore also failed: ${
        restoreError instanceof Error ? restoreError.message : String(restoreError)
      }`,
    );
  }
  throw new Error(verified.reason);
}

async function currentText(
  config: ConfigIpc,
  location: ArtifactLocation,
  projectRoot: string,
): Promise<string> {
  try {
    const read = await config.read(location.path, projectRoot);
    return read.kind === "text" ? read.content : "";
  } catch {
    return "";
  }
}

export async function ensureBrowserAgentSetup(input: {
  config: ConfigIpc;
  binaryPath: string;
  installedClis: string[];
  projectRoot?: string;
}): Promise<BrowserAgentSetupResult> {
  const env = await input.config.env();
  const projectRoot = input.projectRoot ?? "";
  const context: ScanContext = {
    home: env.home,
    platform: env.platform,
    projectRoot,
    appDataRoaming: env.appDataRoaming,
    appDataLocal: env.appDataLocal,
  };
  const configured = new Set<string>();
  const errors: string[] = [];

  for (const cli of input.installedClis.filter((id) => SUPPORTED_CLIS.has(id))) {
    const adapter = createHarnessAdapter(cli, input.config);
    const locations = await adapter.detect("global", context);
    const instruction = locations.find((location) => location.kind === "instruction");
    const mcp = locations.find((location) => location.kind === "mcp-server");

    if (mcp?.format && mcp.mcpKeyPath) {
      try {
        const change = await adapter.plan({
          artifactId: `${cli}:add-mcp:kodade-browser`,
          action: "add-mcp-server",
          projectRoot,
          payload: {
            path: mcp.path,
            format: mcp.format,
            keyPath: mcp.mcpKeyPath,
            server: browserMcpSpec(cli, input.binaryPath),
          },
        });
        if (change.before !== change.after) {
          await applyVerified(adapter, change);
          configured.add(cli);
        }
      } catch (error) {
        errors.push(`${cli} MCP: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      errors.push(`${cli} MCP: no global MCP configuration location is known`);
    }

    if (instruction) {
      try {
        const before = await currentText(input.config, instruction, projectRoot);
        const after = ensureManagedBrowserRule(before);
        if (before !== after) {
          const change = await adapter.plan({
            artifactId: `${cli}:edit-browser-rule`,
            action: "edit",
            projectRoot,
            payload: { path: instruction.path, newText: after },
          });
          await applyVerified(adapter, change);
          configured.add(cli);
        }
      } catch (error) {
        errors.push(
          `${cli} instructions: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return { configured: [...configured], errors };
}
