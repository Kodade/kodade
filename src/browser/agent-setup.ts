import type { McpServerSpec } from "../harness/merge";
import { createHarnessAdapter } from "../harness/adapters/shared";
import type { HarnessAdapter, ArtifactLocation } from "../harness/contract";
import type { ScanContext } from "../harness/model";
import type { ConfigIpc, MemoryMcpBinaryPath } from "../ipc/contract";
import { unavailableFeatureError } from "../release/guard";
import { developmentFeatureEnabled } from "../release/manifest";

const RULE_START = "<!-- kodade:browser:start -->";
const RULE_END = "<!-- kodade:browser:end -->";

export const KODADE_BROWSER_RULE = `${RULE_START}
When the \`kodade-browser\` tools are available, use them for every unqualified browser navigation, inspection, click, typing, and local web-app QA task. These tools control Kodade's visible internal browser. Use Chrome or another external browser only when the user explicitly requests that browser. If the internal browser is unavailable, report that instead of silently falling back.
${RULE_END}`;

// The one server name Ködade owns for the embedded browser.
export const BROWSER_MCP_NAME = "kodade-browser";

export function browserMcpSpec(cli: string, binaryPath: string): McpServerSpec {
  if (cli === "opencode") {
    return {
      name: BROWSER_MCP_NAME,
      config: {
        type: "local",
        command: [binaryPath, "browser"],
        enabled: true,
      },
    };
  }
  return {
    name: BROWSER_MCP_NAME,
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

// Archived embedded browser (#62): the reverse of ensureManagedBrowserRule.
// Older builds wrote a rule telling agents NOT to fall back to an external
// browser, so leaving it behind would strand every agent on a pane that no
// longer exists. Idempotent: text without the markers is returned unchanged.
export function stripManagedBrowserRule(current: string): string {
  const start = current.indexOf(RULE_START);
  const end = current.indexOf(RULE_END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) {
    throw new Error("managed browser rule markers are incomplete");
  }
  if (start < 0) return current;
  const head = current.slice(0, start).replace(/\s+$/, "");
  const tail = current.slice(end + RULE_END.length).replace(/^\s+/, "");
  if (!head) return tail;
  return tail ? `${head}\n\n${tail}` : `${head}\n`;
}

type BrowserAgentSetupResult = {
  configured: string[];
  errors: string[];
};

const SUPPORTED_CLIS = new Set(["claude", "codex", "grok", "opencode"]);

// Rust resolves this descriptor through `Path::is_file`; keep that existence
// proof attached to automatic browser setup instead of registering an unchecked
// path string that can recreate the ENOENT failure this setup repairs.
export function verifiedBrowserMcpBinaryPath(binary: MemoryMcpBinaryPath): string {
  if (!binary.exists || !binary.path) {
    throw new Error("the bundled KödBrowser adapter was not found");
  }
  return binary.path;
}

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
  // Archived embedded browser (#62): a build without the pane must never
  // register the kodade-browser MCP or its instruction rule in a user's CLIs.
  if (!developmentFeatureEnabled("browser")) {
    throw unavailableFeatureError("browser");
  }
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

// Archived embedded browser (#62): the upgrade path. Older builds wrote the
// kodade-browser MCP server and the managed rule into every installed CLI, so
// a build without the pane removes what Ködade owns instead of installing it.
// Ownership is enforced by merge.ts (removeMcpServer refuses anything that is
// not the exact Ködade entry), so a user-authored server of the same name is
// reported and left alone. Idempotent and a no-op on untouched configs.
export async function removeBrowserAgentSetup(input: {
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
        const before = await currentText(input.config, mcp, projectRoot);
        // Nothing named kodade-browser in the file: nothing was ever written
        // here, so there is nothing to clean up.
        if (before.includes(BROWSER_MCP_NAME)) {
          const change = await adapter.plan({
            artifactId: `${cli}:remove-mcp:${BROWSER_MCP_NAME}`,
            action: "remove-mcp-server",
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
        }
      } catch (error) {
        errors.push(`${cli} MCP: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (instruction) {
      try {
        const before = await currentText(input.config, instruction, projectRoot);
        const after = stripManagedBrowserRule(before);
        if (before !== after) {
          const change = await adapter.plan({
            artifactId: `${cli}:remove-browser-rule`,
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
