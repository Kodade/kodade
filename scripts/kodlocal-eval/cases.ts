import type { ToolCall, ToolDefinition } from "../../src/local/toolcall.ts";

export type EvalCategory = "selection" | "incorporation";

export type EvalCase = {
  id: number;
  category: EvalCategory;
  prompt: string;
  expectedFirstTool?: ToolCall["tool"];
  expectedFirstPaths?: readonly string[];
};

export const EVAL_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 project file at an exact project-relative path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List entries at an exact project-relative directory path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "answer",
    description: "Return the final answer to the user. Use this instead of reading or listing when no project data is needed.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

export const EVAL_CASES: EvalCase[] = [
  {
    id: 1,
    category: "selection",
    prompt: "What's in src/main.ts?",
    expectedFirstTool: "read_file",
    expectedFirstPaths: ["src/main.ts"],
  },
  {
    id: 2,
    category: "selection",
    prompt: "Show me the README",
    expectedFirstTool: "read_file",
    expectedFirstPaths: ["README.md"],
  },
  {
    id: 3,
    category: "selection",
    prompt: "What files are in the docs folder?",
    expectedFirstTool: "list_dir",
    expectedFirstPaths: ["docs"],
  },
  {
    id: 4,
    category: "selection",
    prompt: "List the root of the project",
    expectedFirstTool: "list_dir",
    expectedFirstPaths: ["."],
  },
  {
    id: 5,
    category: "selection",
    prompt: "Read the file docs/my plan.md",
    expectedFirstTool: "read_file",
    expectedFirstPaths: ["docs/my plan.md"],
  },
  {
    id: 6,
    category: "selection",
    prompt: "Open src/utils/date-format.ts and tell me what it exports",
    expectedFirstTool: "read_file",
    expectedFirstPaths: ["src/utils/date-format.ts"],
  },
  { id: 7, category: "selection", prompt: "What's 2+2?", expectedFirstTool: "answer" },
  { id: 8, category: "selection", prompt: "Thanks, that's all", expectedFirstTool: "answer" },
  {
    id: 9,
    category: "selection",
    prompt: "Read package.json then tell me the version",
    expectedFirstTool: "read_file",
    expectedFirstPaths: ["package.json"],
  },
  {
    id: 10,
    category: "selection",
    prompt: "Is there a tests directory?",
    expectedFirstTool: "list_dir",
    expectedFirstPaths: [".", "tests"],
  },
  {
    id: 11,
    category: "selection",
    prompt: "Read the third file in src/",
    expectedFirstTool: "list_dir",
    expectedFirstPaths: ["src/"],
  },
  {
    id: 12,
    category: "selection",
    prompt: "Summarize CONTEXT.md",
    expectedFirstTool: "read_file",
    expectedFirstPaths: ["CONTEXT.md"],
  },
  {
    id: 13,
    category: "incorporation",
    prompt: "Read package.json and tell me the version.",
  },
  {
    id: 14,
    category: "incorporation",
    prompt: "List the current directory, then read the second file.",
  },
  {
    id: 15,
    category: "incorporation",
    prompt: "Read missing.txt and tell me what it contains.",
  },
];

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Fixed fixtures only: this evaluation never touches the real filesystem. */
export function mockedToolResult(caseId: number, call: ToolCall): string {
  const path = typeof call.args.path === "string" ? call.args.path : "";
  if (call.tool === "list_dir") {
    if (caseId === 3 && path === "docs") return json(["README.md", "RELEASING.md"]);
    if (caseId === 4 && path === ".") return json(["README.md", "package.json", "src", "docs"]);
    if (caseId === 10 && path === ".") return json(["README.md", "docs", "package.json", "src"]);
    if (caseId === 10 && path === "tests") return json({ error: "not found" });
    if (caseId === 11 && path === "src/") return json(["first.ts", "second.ts", "third.ts"]);
    if (caseId === 14 && path === ".") return json(["a.ts", "b.ts"]);
    return json({ error: `no fixture for list_dir ${path}` });
  }

  if (call.tool === "read_file") {
    if (caseId === 1 && path === "src/main.ts") return 'export function main() { return "kodade"; }';
    if (caseId === 2 && path === "README.md") return "# Ködade\nAn agentic development environment.";
    if (caseId === 5 && path === "docs/my plan.md") return "# My plan\nShip carefully.";
    if (caseId === 6 && path === "src/utils/date-format.ts") return "export { formatDate };";
    if ((caseId === 9 || caseId === 13) && path === "package.json") return '{"version":"1.3.0"}';
    if (caseId === 11 && path === "src/third.ts") return "export const third = true;";
    if (caseId === 12 && path === "CONTEXT.md") return "Ködade is a general-purpose agentic development environment.";
    if (caseId === 14 && path === "b.ts") return "export const second = true;";
    if (caseId === 15) return json({ error: "not found" });
    return json({ error: `no fixture for read_file ${path}` });
  }

  return json({ error: `answer is not an executable tool` });
}
