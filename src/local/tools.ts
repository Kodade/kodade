import {
  isWindowsNativePath,
  nativeJoin,
  nativeRelativePath,
} from "../platform/native-path";
import type { DegradationDecision, ToolDefinition } from "./toolcall";

export const KODADE_BROWSER_TOOL_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_press",
] as const;
type KodadeBrowserToolName = (typeof KODADE_BROWSER_TOOL_NAMES)[number];
const KODADE_BROWSER_TOOL_NAME_SET = new Set<string>(
  KODADE_BROWSER_TOOL_NAMES,
);

function isKodadeBrowserToolName(value: string): value is KodadeBrowserToolName {
  return KODADE_BROWSER_TOOL_NAME_SET.has(value);
}

export const LOCAL_AGENT_TOOLS = [
  {
    name: "read_file",
    description: "Read one text file inside the project.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List one directory inside the project; use . for the root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Atomically write one text file inside the project after policy approval.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "git",
    description: "Run a Rust-allowlisted read-only git argv shape in the project.",
    parameters: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 12 },
      },
      required: ["args"],
    },
  },
  {
    name: "gh",
    description: "Run a Rust-allowlisted read-only GitHub CLI argv shape in the project.",
    parameters: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 12 },
      },
      required: ["args"],
    },
  },
  {
    name: "browser_navigate",
    description:
      "Navigate Kodade's visible internal browser. Use this for every unqualified browser request.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Inspect the current page in Kodade's visible internal browser and return element refs.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_click",
    description: "Click an element ref from browser_snapshot in Kodade's internal browser.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
  {
    name: "browser_fill",
    description: "Fill an element ref from browser_snapshot in Kodade's internal browser.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_press",
    description: "Press a key in Kodade's visible internal browser.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "answer",
    description: "Return the final answer to the user. This ends the tool loop.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
] as const satisfies readonly ToolDefinition[];

export function toolSystemPrompt(
  tools: readonly ToolDefinition[] = LOCAL_AGENT_TOOLS,
): string {
  const names = new Set(tools.map((tool) => tool.name));
  const available = [
    names.has("read_file") ? "- read_file({path}): read a project-relative text file." : null,
    names.has("list_dir") ? '- list_dir({path}): list a project-relative directory; use "." for the root.' : null,
    names.has("write_file") ? "- write_file({path, content}): write a project-relative text file. Writes require policy approval." : null,
    names.has("git") ? "- git({args}): read-only git. Rust permits only status, selected rev-parse/merge-base/branch/worktree shapes, capped diff, and capped log shapes." : null,
    names.has("gh") ? "- gh({args}): read-only GitHub CLI. Rust permits only selected auth/repo/issue/pr view-list-diff-check shapes." : null,
    names.has("browser_navigate") ? "- browser_navigate({url}): navigate Kodade's visible internal browser." : null,
    names.has("browser_snapshot") ? "- browser_snapshot({}): inspect the current internal-browser page and get element refs." : null,
    names.has("browser_click") ? "- browser_click({ref}): click a ref from the latest internal-browser snapshot." : null,
    names.has("browser_fill") ? "- browser_fill({ref, text, submit?}): fill a ref in the internal browser." : null,
    names.has("browser_press") ? "- browser_press({key}): press a key in the internal browser." : null,
    names.has("answer") ? "- answer({text}): final response; use it only after required project facts have been read." : null,
  ].filter((line): line is string => line !== null);
  return `Respond with exactly one JSON object and no Markdown or surrounding prose:
{"tool":"<name>","args":{...}}

Available tools:
${available.join("\n")}

Rules:
1. Never invent file contents, directory entries, git state, or GitHub state. Read them first.
2. Paths must be project-relative. Preserve the user's spelling and use "." for the project root.
3. After every tool result, either call another needed tool or call answer.
4. No arbitrary shell tool exists. Do not suggest that one was run; this is a deliberate v1 safe default.
5. For every unqualified browser task, use the browser_* tools that control Kodade's visible internal browser. Never silently switch to Chrome or another external browser.
6. Never emit undeclared arguments, multiple calls, fences, or prose outside the JSON object.`;
}

export type ToolHost = {
  call(cmd: string, args: Record<string, unknown>): Promise<unknown>;
};

export type ToolExecutionPolicy = {
  entitled: boolean;
  enabled: boolean;
  confirmEveryCall: boolean;
  autoApproveWrite: boolean;
  /** Tools bundled with the agent surface that do not require local.tools. */
  alwaysAllowedTools?: readonly string[];
  /** Headless delegation returns writes to its caller instead of prompting. */
  suggestWrites?: boolean;
};

export type ToolOutcome =
  | { status: "answer"; result: string }
  | { status: "executed"; result: string }
  | { status: "suggested"; result: string }
  | { status: "denied"; result: string }
  | { status: "error"; result: string };

type ExecuteDecision = Extract<DegradationDecision, { action: "execute" }>;

// Keep one recent tool result viable inside the 4K baseline after the harness,
// response reserve, pinned goal, and message overhead have taken their share.
const MAX_CONTEXT_RESULT_CHARS = 1_600;

export function projectToolPath(projectRoot: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("path must be a non-empty string");
  if (value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new Error("tool path is too long or contains a control character");
  }
  if (value.startsWith("/") || isWindowsNativePath(value)) {
    throw new Error("tool paths must be project-relative");
  }
  const parts = value.split(/[\\/]/);
  // Preserve `..` components for the fixed-root Rust pathguard to resolve and
  // reject. TypeScript shapes the relative candidate; Rust is the real boundary.
  return parts.filter((part) => part !== "" && part !== ".").reduce(nativeJoin, projectRoot);
}

/** Render untrusted text without allowing terminal control sequences to execute. */
export function escapeTerminalControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    const code = character.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function writePreview(path: string, content: string): string {
  const bytes = new TextEncoder().encode(content).byteLength;
  const lines = content
    .split(/\r\n|\r|\n/)
    .slice(0, 5)
    .map((line) => escapeTerminalControls(line.length > 240 ? `${line.slice(0, 240)}…` : line));
  const suffix = content.split(/\r\n|\r|\n/).length > 5 ? "\\n+ …" : "";
  return `write_file ${escapeTerminalControls(path)} · ${bytes} bytes\n+ ${lines.join("\\n+ ")}${suffix}`;
}

function displayCall(tool: string, args: Record<string, unknown>): string {
  if (tool === "write_file") return writePreview(String(args.path), String(args.content));
  return escapeTerminalControls(`${tool} ${JSON.stringify(args)}`);
}

function bounded(value: string): string {
  return value.length <= MAX_CONTEXT_RESULT_CHARS
    ? value
    : `${value.slice(0, MAX_CONTEXT_RESULT_CHARS)}\n[tool result truncated at ${MAX_CONTEXT_RESULT_CHARS} characters]`;
}

function normalizeResult(tool: string, result: unknown, projectRoot: string): string {
  if (tool === "read_file" && result && typeof result === "object") {
    const read = result as { kind?: unknown; content?: unknown; bytes?: unknown };
    if (read.kind === "text" && typeof read.content === "string") return bounded(read.content);
    return JSON.stringify(read);
  }
  if (tool === "list_dir" && Array.isArray(result)) {
    const entries = result.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const raw = entry as { name?: unknown; path?: unknown; isDir?: unknown };
      const path = typeof raw.path === "string" ? nativeRelativePath(raw.path, projectRoot) : null;
      return { name: raw.name, path: path ?? raw.path, isDir: raw.isDir };
    });
    return bounded(JSON.stringify(entries));
  }
  if (tool === "write_file") return "write completed";
  return bounded(typeof result === "string" ? result : JSON.stringify(result));
}

function browserHostArgs(
  tool: KodadeBrowserToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (tool) {
    case "browser_navigate":
      return { action: "navigate", url: args.url };
    case "browser_snapshot":
      return { action: "snapshot" };
    case "browser_click":
      return { action: "click", element_ref: args.ref };
    case "browser_fill":
      return {
        action: "fill",
        element_ref: args.ref,
        text: args.text,
        submit: args.submit ?? false,
      };
    case "browser_press":
      return { action: "press", key: args.key };
  }
}

/** The only tool dispatcher: it accepts validator-owned execute decisions, never raw model text. */
export async function executeToolDecision(
  decision: ExecuteDecision,
  deps: {
    projectRoot: string;
    policy: ToolExecutionPolicy;
    confirm: (preview: string) => Promise<boolean>;
    host: ToolHost;
  },
): Promise<ToolOutcome> {
  const { tool, args } = decision.call;
  if (tool === "answer") return { status: "answer", result: String(args.text) };
  const alwaysAllowed = deps.policy.alwaysAllowedTools?.includes(tool) === true;
  if (!deps.policy.enabled || (!deps.policy.entitled && !alwaysAllowed)) {
    return {
      status: "suggested",
      result: `TOOL NOT EXECUTED (suggest-only): ${displayCall(tool, args)}`,
    };
  }
  if (tool === "write_file" && deps.policy.suggestWrites) {
    return {
      status: "suggested",
      result: `TOOL NOT EXECUTED (frontier action required): ${displayCall(tool, args)}`,
    };
  }

  const mustConfirm =
    deps.policy.confirmEveryCall || (tool === "write_file" && !deps.policy.autoApproveWrite);
  if (mustConfirm && !(await deps.confirm(displayCall(tool, args)))) {
    return { status: "denied", result: `TOOL NOT EXECUTED (user declined): ${tool}` };
  }

  try {
    let cmd: string;
    let hostArgs: Record<string, unknown>;
    if (tool === "read_file" || tool === "list_dir") {
      const path = projectToolPath(deps.projectRoot, args.path);
      cmd = tool === "read_file" ? "fs_read_file" : "fs_list_dir";
      hostArgs = { path };
    } else if (tool === "write_file") {
      const path = projectToolPath(deps.projectRoot, args.path);
      cmd = "fs_write_file";
      hostArgs = { path, contents: String(args.content) };
    } else if (tool === "git" || tool === "gh") {
      cmd = tool === "git" ? "run_git" : "run_gh";
      hostArgs = { args: args.args };
    } else if (isKodadeBrowserToolName(tool)) {
      cmd = "browser_agent_command";
      hostArgs = browserHostArgs(tool, args);
    } else {
      return { status: "error", result: `unknown validated tool: ${tool}` };
    }
    const result = await deps.host.call(cmd, hostArgs);
    return { status: "executed", result: normalizeResult(tool, result, deps.projectRoot) };
  } catch (error) {
    return { status: "error", result: error instanceof Error ? error.message : String(error) };
  }
}
