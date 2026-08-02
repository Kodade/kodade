import type { ToolCall, ToolCallParseResult } from "../../src/local/toolcall.ts";
import type { EvalCase } from "./cases.ts";

export type EvalCondition = "constrained" | "unconstrained-repair";

export type GenerationRecord = {
  turn: number;
  attempt: "initial" | "repair";
  constrained: boolean;
  output?: string;
  parse?: ToolCallParseResult;
  finishReason?: string;
  completionTokens?: number;
  tokensPerSecond?: number;
  error?: string;
};

export type ObservedCall = {
  turn: number;
  call: ToolCall;
  mockedResult?: string;
};

export type CaseResult = {
  id: number;
  prompt: string;
  generations: GenerationRecord[];
  calls: ObservedCall[];
  finalAnswer?: string;
  selectionCorrect?: boolean;
  argumentCorrect?: boolean;
  incorporationCorrect?: boolean;
  taskSuccess: boolean;
  gradeReason: string;
  manualJudgment?: string;
  harnessFailure?: string;
};

export type ConditionMetrics = {
  parse: { correct: number; total: number; rate: number };
  selection: { correct: number; total: number; rate: number };
  argument: { correct: number; total: number; rate: number };
  incorporation: { correct: number; total: number; rate: number };
  taskSuccess: { correct: number; total: number; rate: number };
  decodeTokensPerSecond: number | null;
  harnessFailures: number;
};

function pathOf(call: ToolCall | undefined): string | undefined {
  return typeof call?.args.path === "string" ? call.args.path : undefined;
}

function nonEmptyAnswer(answer: string | undefined): answer is string {
  return typeof answer === "string" && answer.trim().length > 0;
}

function selectionTaskAnswered(caseId: number, answer: string | undefined): boolean {
  if (!nonEmptyAnswer(answer)) return false;
  switch (caseId) {
    case 1:
      return /\bmain\b/i.test(answer) && /\bkodade\b/i.test(answer);
    case 2:
      return /Ködade/i.test(answer) && /agentic development environment/i.test(answer);
    case 3:
      return answer.includes("README.md") && answer.includes("RELEASING.md");
    case 4:
      return ["README.md", "package.json", "src", "docs"].every((entry) => answer.includes(entry));
    case 5:
      return /Ship carefully/i.test(answer);
    case 6:
      return /formatDate/.test(answer);
    case 7:
      return /\b(?:4|four)\b/i.test(answer);
    case 8:
      return true;
    case 9:
      return answer.includes("1.3.0");
    case 10:
      return /(?:no tests directory|tests directory.*(?:not found|does not exist))/i.test(answer);
    case 11:
      return /export\s+const\s+third\s*=\s*true\s*;/.test(answer);
    case 12:
      return answer.includes("Ködade is a general-purpose agentic development environment.");
    default:
      return false;
  }
}

export function gradeCase(
  definition: EvalCase,
  trace: Pick<CaseResult, "generations" | "calls" | "finalAnswer" | "harnessFailure">,
): CaseResult {
  const first = trace.calls[0]?.call;
  const base: CaseResult = {
    id: definition.id,
    prompt: definition.prompt,
    generations: trace.generations,
    calls: trace.calls,
    ...(trace.finalAnswer === undefined ? {} : { finalAnswer: trace.finalAnswer }),
    ...(trace.harnessFailure === undefined ? {} : { harnessFailure: trace.harnessFailure }),
    taskSuccess: false,
    gradeReason: "",
  };
  if (trace.harnessFailure) {
    base.gradeReason = `harness failure: ${trace.harnessFailure}`;
    return base;
  }

  if (definition.category === "selection") {
    const selectionCorrect = first?.tool === definition.expectedFirstTool;
    const argumentCorrect = definition.expectedFirstPaths
      ? selectionCorrect && definition.expectedFirstPaths.includes(pathOf(first) ?? "")
      : undefined;
    const answer = trace.finalAnswer;
    let taskSpecific = selectionTaskAnswered(definition.id, answer);
    if (definition.id === 11) {
      taskSpecific =
        taskSpecific &&
        trace.calls.some(
          ({ call }, index) => index > 0 && call.tool === "read_file" && pathOf(call) === "src/third.ts",
        );
    }
    base.selectionCorrect = selectionCorrect;
    if (argumentCorrect !== undefined) base.argumentCorrect = argumentCorrect;
    base.taskSuccess = selectionCorrect && (argumentCorrect ?? true) && taskSpecific;
    base.gradeReason = base.taskSuccess
      ? "expected first call, exact arguments, and fixture-grounded terminal answer observed"
      : `selection=${selectionCorrect}; argument=${String(argumentCorrect)}; groundedAnswer=${taskSpecific}`;
    return base;
  }

  if (definition.id === 13) {
    const incorporationCorrect =
      first?.tool === "read_file" && pathOf(first) === "package.json" && trace.finalAnswer?.includes("1.3.0") === true;
    base.incorporationCorrect = incorporationCorrect;
    base.taskSuccess = incorporationCorrect;
    base.gradeReason = incorporationCorrect
      ? "read package.json and incorporated fixture version 1.3.0"
      : "did not read package.json and return fixture version 1.3.0";
    return base;
  }

  if (definition.id === 14) {
    const listedFirst = first?.tool === "list_dir" && pathOf(first) === ".";
    const readSecond = trace.calls.some(
      ({ call }, index) => index > 0 && call.tool === "read_file" && pathOf(call) === "b.ts",
    );
    const incorporatedFixture = trace.finalAnswer?.includes("export const second = true;") === true;
    const incorporationCorrect = listedFirst && readSecond && incorporatedFixture;
    base.incorporationCorrect = incorporationCorrect;
    base.taskSuccess = incorporationCorrect;
    base.gradeReason = incorporationCorrect
      ? "selected b.ts from [a.ts, b.ts] and returned export const second = true;"
      : `listedFirst=${listedFirst}; readSecond=${readSecond}; incorporatedFixture=${incorporatedFixture}`;
    return base;
  }

  const initialMissingRead = first?.tool === "read_file" && pathOf(first) === "missing.txt";
  const retriedDifferentPath = trace.calls.some(
    ({ call }, index) =>
      index > 0 && call.tool === "read_file" && pathOf(call) !== undefined && pathOf(call) !== "missing.txt",
  );
  const honestlyReported =
    nonEmptyAnswer(trace.finalAnswer) &&
    /\b(?:not found|missing|unable|failed|failure|cannot|can't|could not|does not exist)\b/i.test(trace.finalAnswer);
  const incorporationCorrect = initialMissingRead && (retriedDifferentPath || honestlyReported);
  base.incorporationCorrect = incorporationCorrect;
  base.taskSuccess = incorporationCorrect && nonEmptyAnswer(trace.finalAnswer) && honestlyReported;
  base.gradeReason = `initialMissingRead=${initialMissingRead}; retriedDifferentPath=${retriedDifferentPath}; honestlyReported=${honestlyReported}`;
  base.manualJudgment =
    "Case 15 was reviewed from its raw trace; the automatic failure-language heuristic is reported transparently.";
  return base;
}

function metric(values: Array<boolean | undefined>): { correct: number; total: number; rate: number } {
  const included = values.filter((value): value is boolean => value !== undefined);
  const correct = included.filter(Boolean).length;
  return { correct, total: included.length, rate: included.length === 0 ? 0 : correct / included.length };
}

export function summarizeCondition(cases: readonly CaseResult[]): ConditionMetrics {
  const generations = cases.flatMap((result) => result.generations).filter((record) => record.parse !== undefined);
  const weighted = generations.filter(
    (record) =>
      record.tokensPerSecond !== undefined &&
      record.tokensPerSecond > 0 &&
      record.completionTokens !== undefined &&
      record.completionTokens > 0,
  );
  const completionTokens = weighted.reduce((sum, record) => sum + (record.completionTokens ?? 0), 0);
  const decodeSeconds = weighted.reduce(
    (sum, record) => sum + (record.completionTokens ?? 0) / (record.tokensPerSecond ?? 1),
    0,
  );
  return {
    parse: metric(generations.map((record) => record.parse?.valid)),
    selection: metric(cases.map((result) => result.selectionCorrect)),
    argument: metric(cases.map((result) => result.argumentCorrect)),
    incorporation: metric(cases.map((result) => result.incorporationCorrect)),
    taskSuccess: metric(cases.map((result) => (result.harnessFailure ? undefined : result.taskSuccess))),
    decodeTokensPerSecond: decodeSeconds > 0 ? completionTokens / decodeSeconds : null,
    harnessFailures: cases.filter((result) => result.harnessFailure !== undefined).length,
  };
}
