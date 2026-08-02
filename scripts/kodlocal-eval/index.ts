import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { OpenAIHttpBackend, type ChatMessage, type ChatResponse } from "../../src/local/backend.ts";
import {
  compileToolGrammar,
  initialDegradationState,
  nextDegradationStep,
  parseToolCall,
  type DegradationState,
  type ToolCallParseResult,
} from "../../src/local/toolcall.ts";
import { EVAL_CASES, EVAL_TOOLS, mockedToolResult, type EvalCase } from "./cases.ts";
import {
  gradeCase,
  summarizeCondition,
  type CaseResult,
  type EvalCondition,
  type GenerationRecord,
  type ObservedCall,
} from "./grade.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE_URL = "http://127.0.0.1:4470";
const DEFAULT_MODEL_DIR = join(tmpdir(), "kodade-eval-models");
const MODEL_DIR = process.env.KODADE_EVAL_MODELS_DIR ?? DEFAULT_MODEL_DIR;
const OUTPUT_PATH = join(ROOT, "artifacts/kodlocal-eval.json");
const MAX_TURNS = 4;
const MAX_TOKENS = 512;
const CONTEXT_TOKENS = 4096;

type ModelSpec = { file: string; family: string; quant: string };

const MODELS = [
  { file: "qwen2.5-0.5b-instruct-q8_0.gguf", family: "Qwen2.5 0.5B Instruct", quant: "Q8_0" },
  { file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf", family: "Llama 3.2 3B Instruct", quant: "Q4_K_M" },
  { file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", family: "Qwen3 4B Instruct 2507", quant: "Q4_K_M" },
] as const satisfies readonly ModelSpec[];
const CONDITIONS: EvalCondition[] = ["constrained", "unconstrained-repair"];
const GRAMMAR = compileToolGrammar(EVAL_TOOLS);

const SYSTEM_PROMPT = `You are a project tool-routing agent. Respond with exactly one JSON object and no other text.
The object must have this shape: {"tool":"<name>","args":{...}}.

Available tools:
- read_file({"path": string}): read one project file at the exact project-relative path.
- list_dir({"path": string}): list one project-relative directory. Use "." for the project root.
- answer({"text": string}): give the final answer. This is the only way to answer directly.

Rules:
1. Preserve user-provided paths exactly, including spaces and trailing slashes.
2. Never invent file contents or directory entries. Call read_file or list_dir first when project data is needed.
3. After a mocked tool result is supplied, use it to choose the next tool or call answer.
4. For ordinary questions that need no project data, call answer immediately.
5. Never emit Markdown fences, prose outside the JSON object, multiple objects, or undeclared arguments.`;

const REPAIR_PROMPT = (reason: string) => `Your previous response was invalid: ${reason}
This is your one repair attempt. Return exactly one JSON object with only "tool" and "args". No Markdown or prose.`;

type Daemon = {
  process: ChildProcess;
  log: () => string;
};

type ConditionRun = {
  condition: EvalCondition;
  metrics: ReturnType<typeof summarizeCondition>;
  cases: CaseResult[];
};

type ModelRun = {
  model: ModelSpec;
  loadedModelId?: string;
  conditions: ConditionRun[];
  harnessFailure?: string;
  daemonLogTail?: string;
};

type RawReport = {
  schemaVersion: number;
  generatedAt: string;
  methodology: Record<string, unknown>;
  models: ModelRun[];
};

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function appendLog(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > 64_000 ? next.slice(-64_000) : next;
}

async function assertPortFree(backend: OpenAIHttpBackend): Promise<void> {
  try {
    await backend.listModels();
  } catch {
    return;
  }
  throw new Error(`${BASE_URL} is already serving a daemon; refusing to kill an unknown process`);
}

async function startDaemon(modelPath: string, backend: OpenAIHttpBackend): Promise<Daemon> {
  await assertPortFree(backend);
  const child = spawn(
    "cargo",
    [
      "run",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--features",
      "modeld",
      "--bin",
      "kodade-modeld",
      "--",
      "--model",
      modelPath,
      "--ctx",
      String(CONTEXT_TOKENS),
      "--port",
      "4470",
    ],
    { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log = appendLog(log, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log = appendLog(log, chunk);
  });
  child.on("error", (error) => {
    log = appendLog(log, `\nspawn error: ${errorText(error)}`);
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}: ${log.slice(-8_000)}`);
    try {
      const models = await backend.listModels();
      if (models.length > 0 && models[0].loaded) return { process: child, log: () => log };
    } catch {
      // Loading happens before bind; connection failures are expected here.
    }
    await delay(500);
  }
  await stopDaemon({ process: child, log: () => log });
  throw new Error(`daemon did not become ready within 180s: ${log.slice(-8_000)}`);
}

async function stopDaemon(daemon: Daemon): Promise<void> {
  const pid = daemon.process.pid;
  if (pid === undefined || daemon.process.exitCode !== null) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    daemon.process.kill("SIGTERM");
  }
  const closed = once(daemon.process, "close").then(() => true);
  if (await Promise.race([closed, delay(5_000).then(() => false)])) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    daemon.process.kill("SIGKILL");
  }
  await Promise.race([closed, delay(2_000)]);
}

function recordGeneration(
  response: ChatResponse,
  turn: number,
  attempt: GenerationRecord["attempt"],
  constrained: boolean,
  parse: ToolCallParseResult,
): GenerationRecord {
  return {
    turn,
    attempt,
    constrained,
    output: response.content,
    parse,
    ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
    ...(response.usage?.completionTokens === undefined
      ? {}
      : { completionTokens: response.usage.completionTokens }),
    ...(response.tokensPerSecond === undefined ? {} : { tokensPerSecond: response.tokensPerSecond }),
  };
}

async function generate(
  backend: OpenAIHttpBackend,
  messages: ChatMessage[],
  condition: EvalCondition,
  turn: number,
  attempt: GenerationRecord["attempt"],
): Promise<{ response: ChatResponse; parse: ToolCallParseResult; record: GenerationRecord }> {
  const constrained = condition === "constrained";
  const response = await backend.chatOnce({
    messages,
    temperature: 0,
    topP: 1,
    seed: 0,
    maxTokens: MAX_TOKENS,
    ...(constrained ? { kodGrammar: GRAMMAR } : {}),
  });
  const parse = parseToolCall(response.content, EVAL_TOOLS);
  return { response, parse, record: recordGeneration(response, turn, attempt, constrained, parse) };
}

async function runCase(
  backend: OpenAIHttpBackend,
  definition: EvalCase,
  condition: EvalCondition,
): Promise<CaseResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: definition.prompt },
  ];
  const generations: GenerationRecord[] = [];
  const calls: ObservedCall[] = [];
  let finalAnswer: string | undefined;
  let harnessFailure: string | undefined;
  let degradation: DegradationState = initialDegradationState(
    condition === "constrained" ? "constrained" : "unconstrained-repair",
  );

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
      let generated = await generate(backend, messages, condition, turn, "initial");
      generations.push(generated.record);

      if (!generated.parse.valid) {
        if (condition === "constrained") break;
        const decision = nextDegradationStep(degradation, generated.parse);
        degradation = decision.state;
        if (decision.action !== "reprompt-repair") break;
        messages.push(
          { role: "assistant", content: generated.response.content },
          { role: "user", content: REPAIR_PROMPT(generated.parse.reason) },
        );
        generated = await generate(backend, messages, condition, turn, "repair");
        generations.push(generated.record);
        if (!generated.parse.valid) {
          degradation = nextDegradationStep(degradation, generated.parse).state;
          break;
        }
      }

      const decision = nextDegradationStep(degradation, generated.parse);
      degradation = decision.state;
      if (decision.action !== "execute") break;
      const call = decision.call;
      messages.push({ role: "assistant", content: generated.response.content });
      if (call.tool === "answer") {
        finalAnswer = String(call.args.text);
        calls.push({ turn, call });
        break;
      }

      const mockedResult = mockedToolResult(definition.id, call);
      calls.push({ turn, call, mockedResult });
      messages.push({
        role: "user",
        content: `MOCK TOOL RESULT for ${call.tool}:\n${mockedResult}\nUse only this result. Choose the next tool or call answer.`,
      });
    }
  } catch (error) {
    harnessFailure = errorText(error);
    generations.push({
      turn: Math.min(generations.length + 1, MAX_TURNS),
      attempt: "initial",
      constrained: condition === "constrained",
      error: harnessFailure,
    });
  }

  return gradeCase(definition, { generations, calls, finalAnswer, harnessFailure });
}

async function runCondition(
  backend: OpenAIHttpBackend,
  modelLabel: string,
  condition: EvalCondition,
): Promise<ConditionRun> {
  const cases: CaseResult[] = [];
  for (const definition of EVAL_CASES) {
    console.log(`[${modelLabel}] ${condition} case ${definition.id}/15`);
    cases.push(await runCase(backend, definition, condition));
  }
  return { condition, cases, metrics: summarizeCondition(cases) };
}

function buildReport(modelRuns: ModelRun[]): RawReport {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      hardware: "M-series 24GB",
      observedHost: {
        hostname: hostname(),
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      daemon: {
        baseURL: BASE_URL,
        command: "cargo run --manifest-path src-tauri/Cargo.toml --no-default-features --features modeld --bin kodade-modeld -- --model <path> --ctx 4096 --port 4470",
        contextTokens: CONTEXT_TOKENS,
      },
      generation: { temperature: 0, topP: 1, seed: 0, maxTokens: MAX_TOKENS, maxTurns: MAX_TURNS },
      conditions: {
        constrained: "kod_grammar GBNF on every generation; no repair",
        "unconstrained-repair": "no grammar; strict parse; one reprompt-repair per case; then chat-only surrender",
      },
      metrics: {
        parse: "strictly valid raw generations / all raw generations, including repair generations",
        selection: "correct first valid call in cases 1-12 / 12",
        argument: "exact accepted path on path-bearing cases 1-6 and 9-12 / 10",
        incorporation: "fixture-specific behavior in cases 13-15 / 3",
        taskSuccess: "fully graded successful cases / 15",
        decodeTokensPerSecond: "completion-token-weighted harmonic aggregation of daemon-reported decode rates",
      },
      tools: EVAL_TOOLS,
      grammar: GRAMMAR,
    },
    models: modelRuns,
  };
}

async function checkpoint(modelRuns: ModelRun[]): Promise<void> {
  await writeFile(OUTPUT_PATH, `${JSON.stringify(buildReport(modelRuns), null, 2)}\n`, "utf8");
}

async function loadCheckpoint(): Promise<ModelRun[]> {
  try {
    const parsed = JSON.parse(await readFile(OUTPUT_PATH, "utf8")) as Partial<RawReport>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.models)) {
      throw new Error("existing raw result has an unsupported schema");
    }
    return parsed.models.map((model) => ({
      ...model,
      conditions: model.conditions.map((condition) => {
        const cases = condition.cases.map((result) => {
          const definition = EVAL_CASES.find((candidate) => candidate.id === result.id);
          if (!definition) throw new Error(`raw result has unknown case ${result.id}`);
          return gradeCase(definition, result);
        });
        return { ...condition, cases, metrics: summarizeCondition(cases) };
      }),
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function main(): Promise<void> {
  const backend = new OpenAIHttpBackend({ baseURL: BASE_URL });
  const modelRuns = await loadCheckpoint();

  for (const model of MODELS) {
    let modelRun = modelRuns.find((candidate) => candidate.model.file === model.file);
    if (!modelRun) {
      modelRun = { model, conditions: [] };
      modelRuns.push(modelRun);
    }
    const missingConditions = CONDITIONS.filter(
      (condition) =>
        !modelRun.conditions.some(
          (completed) => completed.condition === condition && completed.metrics.harnessFailures === 0,
        ),
    );
    if (missingConditions.length === 0) {
      console.log(`Skipping completed ${model.family}`);
      continue;
    }

    console.log(`\nStarting ${model.family} (${model.quant})`);
    let daemon: Daemon | undefined;
    try {
      delete modelRun.harnessFailure;
      delete modelRun.daemonLogTail;
      daemon = await startDaemon(join(MODEL_DIR, model.file), backend);
      const [loaded] = await backend.listModels();
      modelRun.loadedModelId = loaded?.id;
      for (const condition of missingConditions) {
        const conditionRun = await runCondition(backend, model.family, condition);
        modelRun.conditions = modelRun.conditions.filter(
          (completed) => completed.condition !== condition,
        );
        modelRun.conditions.push(conditionRun);
        await checkpoint(modelRuns);
      }
    } catch (error) {
      modelRun.harnessFailure = errorText(error);
      modelRun.daemonLogTail = daemon?.log().slice(-8_000);
      console.error(`${model.family} harness failure: ${modelRun.harnessFailure}`);
      await checkpoint(modelRuns);
    } finally {
      if (daemon) await stopDaemon(daemon);
    }
  }

  await checkpoint(modelRuns);
  console.log(`\nRaw results written to ${OUTPUT_PATH}`);
  for (const run of modelRuns) {
    for (const condition of run.conditions) {
      const metrics = condition.metrics;
      console.log(
        `${run.model.family} ${condition.condition}: parse ${metrics.parse.correct}/${metrics.parse.total}; selection ${metrics.selection.correct}/${metrics.selection.total}; arguments ${metrics.argument.correct}/${metrics.argument.total}; incorporation ${metrics.incorporation.correct}/${metrics.incorporation.total}; success ${metrics.taskSuccess.correct}/${metrics.taskSuccess.total}; ${metrics.decodeTokensPerSecond?.toFixed(1) ?? "n/a"} tok/s`,
      );
    }
  }
}

await main();
