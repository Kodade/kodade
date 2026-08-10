import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ChatMessage, ChatRequest, InferenceBackend } from "./backend";
import { CheckpointContentGuard } from "./checkpointGuard";
import { assembleContext, selectOldestCompleteTurns } from "./context";
import type { MemoryCheckpointClient } from "./memory";
import {
  compileToolGrammar,
  initialDegradationState,
  nextDegradationStep,
  parseToolCall,
  type DegradationDecision,
  type DegradationState,
} from "./toolcall";
import {
  escapeTerminalControls,
  executeToolDecision,
  LOCAL_AGENT_TOOLS,
  toolSystemPrompt,
  type ToolExecutionPolicy,
  type ToolHost,
  type ToolOutcome,
} from "./tools";
import type { ToolDefinition } from "./toolcall";

export const MAX_TOOL_TURNS = 6;
export const MAX_RETAINED_TURNS = 8;
export const DEFAULT_MAX_TOKENS = 768;
const DEFAULT_MARGIN_TOKENS = 128;
const CHECKPOINT_SUMMARY_MAX_WORDS = 120;
const CHECKPOINT_TRANSCRIPT_MAX_CHARS = 12_000;
const DEFAULT_SUMMARY_TIMEOUT_MS = 20_000;
type ExecuteDecision = Extract<DegradationDecision, { action: "execute" }>;

export type LocalAgentOptions = {
  backend: InferenceBackend;
  model: string;
  modelContextTokens: number;
  harnessPrompt: string;
  projectRoot: string;
  constrained: boolean;
  host: ToolHost;
  policy: ToolExecutionPolicy;
  confirm: (preview: string) => Promise<boolean>;
  maxTokens?: number;
  /** May narrow, but never raise, the fixed six-turn tool ceiling. */
  maxToolTurns?: number;
  /** A narrowed subset of the fixed M14e definitions; answer must remain present. */
  tools?: readonly ToolDefinition[];
  marginTokens?: number;
  /** Bounded separately because checkpoint summaries must never stall the loop. */
  summaryTimeoutMs?: number;
  /** Pre-rendered KödMem context, budgeted separately by the context manager. */
  memoryContext?: string;
  /** Available only in the Pro agent session that successfully opened KödMCP. */
  memory?: {
    client: MemoryCheckpointClient;
    workspaceRoot: string;
    sessionId: string;
    checkpointSummaryPrefix?: string;
  };
  onActivity?: (line: string) => void;
  onAnswerDelta?: (text: string) => void;
  onToolOutcome?: (
    tool: string,
    args: Record<string, unknown>,
    outcome: ToolOutcome,
  ) => void;
};

export type AgentTurnResult = {
  answer: string;
  toolTurns: number;
  surrendered: boolean;
  stopReason?: "tool-budget" | "validation-failed";
  tokensPerSecond?: number;
};

export type SessionCheckpointResult =
  | {
      status: "written";
      idempotencyKey: string;
      checkpointId?: string;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

type Generation = {
  content: string;
  tokensPerSecond?: number;
};

type ValidatedGeneration = {
  decision: ExecuteDecision;
  content: string;
};

type CheckpointDraft = {
  summary: string;
  nextActions: string[];
};

function repairPrompt(reason: string, finalRepair: boolean): string {
  return `${finalRepair ? "This is your one repair attempt." : "Retry without grammar."}
Your previous response was invalid: ${reason}
Return exactly one JSON object with only "tool" and "args". No Markdown or prose.`;
}

function toolActivity(tool: string, args: Record<string, unknown>): string {
  if (tool === "write_file") {
    const content = typeof args.content === "string" ? args.content : "";
    return `write_file ${escapeTerminalControls(String(args.path))} (${new TextEncoder().encode(content).byteLength} bytes)`;
  }
  const encoded = JSON.stringify(args);
  return `${tool} ${encoded.length > 500 ? `${encoded.slice(0, 500)}…` : encoded}`;
}

function truncateText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function limitWords(value: string, maxWords: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.length <= maxWords
    ? words.join(" ")
    : `${words.slice(0, maxWords).join(" ")}…`;
}

function safeCheckpointTranscript(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  let remaining = CHECKPOINT_TRANSCRIPT_MAX_CHARS;
  for (const message of messages) {
    if (remaining <= 0) break;
    let safe: string;
    if (/^TOOL RESULT for /m.test(message.content) || message.role === "tool") {
      const header = message.content
        .split("\n", 1)[0]
        .replace(/\s+/g, " ")
        .trim();
      safe = `${message.role}: ${truncateText(header, 160)} (raw tool result withheld)`;
    } else {
      try {
        const parsed = JSON.parse(message.content) as { tool?: unknown };
        safe =
          typeof parsed.tool === "string"
            ? `${message.role}: selected tool ${parsed.tool} (arguments withheld)`
            : `${message.role}: ${message.content.replace(/\s+/g, " ").trim()}`;
      } catch {
        safe = `${message.role}: ${message.content.replace(/\s+/g, " ").trim()}`;
      }
    }
    const bounded = truncateText(safe, Math.min(1_500, remaining));
    lines.push(bounded);
    remaining -= bounded.length + 1;
  }
  return lines.join("\n");
}

function checkpointDraft(content: string): CheckpointDraft | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  let summary = trimmed;
  let nextActions: string[] = [];
  const json = /\{[\s\S]*\}/.exec(trimmed)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as {
        summary?: unknown;
        nextActions?: unknown;
      };
      if (typeof parsed.summary === "string") summary = parsed.summary;
      if (Array.isArray(parsed.nextActions)) {
        nextActions = parsed.nextActions.filter(
          (action): action is string => typeof action === "string",
        );
      }
    } catch {
      // Plain-text summaries are an acceptable best-effort response from weak local models.
    }
  }
  summary = truncateText(
    limitWords(summary.replace(/\s+/g, " "), CHECKPOINT_SUMMARY_MAX_WORDS),
    60_000,
  );
  if (!summary) return null;
  const concreteActions = nextActions
    .map((action) => truncateText(action.replace(/\s+/g, " ").trim(), 2_000))
    .filter(Boolean)
    .slice(0, 5);
  return {
    summary,
    nextActions:
      concreteActions.length > 0
        ? concreteActions
        : ["Continue the user's latest task from this durable checkpoint."],
  };
}

function genericCheckpoint(turnCount: number): CheckpointDraft {
  return {
    summary: `session summary unavailable — ${turnCount} ${turnCount === 1 ? "turn" : "turns"} elided`,
    nextActions: ["Continue the user's latest task."],
  };
}

function offloadContentHash(
  turns: readonly (readonly ChatMessage[])[],
): string {
  const content = JSON.stringify(
    turns.map((turn) =>
      turn.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name === undefined ? {} : { name: message.name }),
        ...(message.toolCallId === undefined
          ? {}
          : { toolCallId: message.toolCallId }),
      })),
    ),
  );
  return bytesToHex(sha256(utf8ToBytes(content))).slice(0, 16);
}

export class LocalAgentLoop {
  private readonly backend: InferenceBackend;
  private readonly model: string;
  private readonly modelContextTokens: number;
  private readonly harnessPrompt: string;
  private readonly projectRoot: string;
  private readonly constrained: boolean;
  private readonly host: ToolHost;
  private readonly confirm: (preview: string) => Promise<boolean>;
  private readonly maxTokens: number;
  private readonly maxToolTurns: number;
  private readonly marginTokens: number;
  private readonly summaryTimeoutMs: number;
  private readonly tools: readonly ToolDefinition[];
  private readonly toolGrammar: string;
  private readonly memoryContext: string | undefined;
  private readonly memory:
    | {
        client: MemoryCheckpointClient;
        workspaceRoot: string;
        sessionId: string;
        checkpointSummaryPrefix?: string;
      }
    | undefined;
  private readonly onActivity: (line: string) => void;
  private readonly onAnswerDelta: (text: string) => void;
  private readonly onToolOutcome: (
    tool: string,
    args: Record<string, unknown>,
    outcome: ToolOutcome,
  ) => void;
  private pinnedGoal: ChatMessage | null = null;
  private readonly retainedTurns: ChatMessage[][] = [];
  private activeTurn: ChatMessage[] | null = null;
  private readonly checkpointGuard = new CheckpointContentGuard();
  private hasDurableElision = false;
  private memoryOffloadFailed = false;
  private sessionCheckpointWritten = false;
  private policy: ToolExecutionPolicy;

  constructor(options: LocalAgentOptions) {
    this.backend = options.backend;
    this.model = options.model;
    this.modelContextTokens = options.modelContextTokens;
    this.harnessPrompt = options.harnessPrompt;
    this.projectRoot = options.projectRoot;
    this.constrained = options.constrained;
    this.host = options.host;
    this.policy = { ...options.policy };
    this.confirm = options.confirm;
    const requestedMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens < 1) {
      throw new Error("maxTokens must be a positive integer");
    }
    this.maxTokens = Math.min(requestedMaxTokens, DEFAULT_MAX_TOKENS);
    const requestedToolTurns = options.maxToolTurns ?? MAX_TOOL_TURNS;
    if (!Number.isSafeInteger(requestedToolTurns) || requestedToolTurns < 0) {
      throw new Error("maxToolTurns must be a non-negative integer");
    }
    this.maxToolTurns = Math.min(requestedToolTurns, MAX_TOOL_TURNS);
    this.tools = options.tools ?? LOCAL_AGENT_TOOLS;
    const fixedNames = new Set<string>(
      LOCAL_AGENT_TOOLS.map((tool) => tool.name),
    );
    if (
      this.tools.length === 0 ||
      this.tools.some((tool) => !fixedNames.has(tool.name)) ||
      new Set(this.tools.map((tool) => tool.name)).size !== this.tools.length ||
      !this.tools.some((tool) => tool.name === "answer")
    ) {
      throw new Error(
        "tools must be a unique narrowed subset of the fixed M14e set and include answer",
      );
    }
    this.toolGrammar = compileToolGrammar(this.tools);
    this.marginTokens = options.marginTokens ?? DEFAULT_MARGIN_TOKENS;
    this.summaryTimeoutMs =
      options.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
    this.memoryContext = options.memoryContext;
    if (
      options.memory?.checkpointSummaryPrefix &&
      (options.memory.checkpointSummaryPrefix.length > 160 ||
        /[\0\r\n]/.test(options.memory.checkpointSummaryPrefix))
    ) {
      throw new Error("checkpointSummaryPrefix must be a single bounded line");
    }
    this.memory = options.memory;
    this.onActivity = options.onActivity ?? (() => undefined);
    this.onAnswerDelta = options.onAnswerDelta ?? (() => undefined);
    this.onToolOutcome = options.onToolOutcome ?? (() => undefined);
  }

  setToolsEnabled(enabled: boolean): void {
    this.policy.enabled =
      enabled &&
      (this.policy.entitled ||
        (this.policy.alwaysAllowedTools?.length ?? 0) > 0);
  }

  toolsEnabled(): boolean {
    return this.policy.enabled;
  }

  private beginTurn(prompt: string): void {
    if (this.activeTurn) throw new Error("an agent turn is already running");
    const user: ChatMessage = { role: "user", content: prompt };
    if (!this.pinnedGoal) {
      this.pinnedGoal = user;
      this.activeTurn = [];
    } else {
      this.activeTurn = [user];
    }
  }

  private retain(...messages: ChatMessage[]): void {
    if (!this.activeTurn) throw new Error("no active agent turn");
    this.activeTurn.push(...messages);
  }

  private finishTurn(): void {
    const completed = this.activeTurn;
    this.activeTurn = null;
    if (!completed || completed.length === 0) return;
    this.retainedTurns.push(completed);
    // Without KödMCP, or after its first failure, retain the M14e bounded
    // fallback for the rest of the session.
    if (!this.memory) this.applyLocalRetentionCap(false);
    else if (this.memoryOffloadFailed) this.applyLocalRetentionCap(true);
  }

  private applyLocalRetentionCap(markElision: boolean): void {
    const removeCount = this.retainedTurns.length - MAX_RETAINED_TURNS;
    if (removeCount <= 0) return;
    this.retainedTurns.splice(0, removeCount);
    if (markElision) this.hasDurableElision = true;
  }

  private enterLocalRetentionFallback(message: string): void {
    this.memoryOffloadFailed = true;
    this.applyLocalRetentionCap(true);
    this.onActivity(message);
  }

  private async summarizeForCheckpoint(
    messages: readonly ChatMessage[],
  ): Promise<CheckpointDraft | null> {
    const transcript = safeCheckpointTranscript([
      ...(this.pinnedGoal ? [this.pinnedGoal] : []),
      ...messages,
    ]);
    if (!transcript) return null;
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const request: ChatRequest = {
        model: this.model,
        temperature: 0,
        topP: 1,
        seed: 0,
        maxTokens: 192,
        messages: [
          {
            role: "system",
            content:
              "summarize these turns in <=120 words for a durable checkpoint. Return JSON with summary and nextActions (up to 5 concrete actions). Never include raw tool output, file contents, or credentials.",
          },
          { role: "user", content: transcript },
        ],
      };
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          controller.abort();
          reject(new Error("checkpoint summary timed out"));
        }, this.summaryTimeoutMs);
      });
      const response = await Promise.race([
        this.backend.chatOnce(request, { signal: controller.signal }),
        timeout,
      ]);
      return checkpointDraft(response.content);
    } catch {
      return null;
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  }

  private async offloadElidedTurns(
    elided: readonly ChatMessage[],
  ): Promise<void> {
    if (!this.memory || this.memoryOffloadFailed) return;
    const completeTurns = selectOldestCompleteTurns(
      this.retainedTurns,
      elided.length,
    );
    if (completeTurns.length === 0) return;
    const draft = await this.summarizeForCheckpoint(completeTurns.flat());
    if (!draft) {
      this.enterLocalRetentionFallback(
        "KödMem could not summarize elided history; continuing with bounded local context",
      );
      return;
    }
    const guardedDraft = this.checkpointGuard.accepts(draft)
      ? draft
      : genericCheckpoint(completeTurns.length);
    if (guardedDraft !== draft) {
      this.onActivity(
        "unsafe checkpoint summary replaced with a generic KödMem checkpoint",
      );
    }
    const idempotencyKey = `${this.memory.sessionId}:offload:${offloadContentHash(completeTurns)}`;
    try {
      await this.memory.client.checkpoint({
        workspaceRoot: this.memory.workspaceRoot,
        summary: guardedDraft.summary,
        nextActions: guardedDraft.nextActions,
        sessionId: this.memory.sessionId,
        idempotencyKey,
        updateState: false,
      });
      this.retainedTurns.splice(0, completeTurns.length);
      this.hasDurableElision = true;
      this.onActivity("older context checkpointed to KödMem");
    } catch (error) {
      this.enterLocalRetentionFallback(
        `KödMem could not checkpoint elided history; continuing with bounded local context: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async generate(
    systemPrompt: string,
    extra: readonly ChatMessage[],
    constrained: boolean,
    signal?: AbortSignal,
    streamAnswer = false,
  ): Promise<Generation> {
    let context = assembleContext({
      systemPrompt,
      memoryContext: this.memoryContext,
      durableElision: this.hasDurableElision,
      pinnedGoal: this.pinnedGoal,
      turns: [
        ...this.retainedTurns.flat(),
        ...(this.activeTurn ?? []),
        ...extra,
      ],
      modelContextTokens: this.modelContextTokens,
      maxTokens: this.maxTokens,
      marginTokens: this.marginTokens,
    });
    if (context.elided && this.memory) {
      await this.offloadElidedTurns(context.elidedTurns);
      context = assembleContext({
        systemPrompt,
        memoryContext: this.memoryContext,
        durableElision: this.hasDurableElision,
        pinnedGoal: this.pinnedGoal,
        turns: [
          ...this.retainedTurns.flat(),
          ...(this.activeTurn ?? []),
          ...extra,
        ],
        modelContextTokens: this.modelContextTokens,
        maxTokens: this.maxTokens,
        marginTokens: this.marginTokens,
      });
    }
    const request: ChatRequest = {
      model: this.model,
      messages: context.messages,
      temperature: 0,
      topP: 1,
      seed: 0,
      maxTokens: this.maxTokens,
      ...(constrained ? { kodGrammar: this.toolGrammar } : {}),
    };
    let content = "";
    let tokensPerSecond: number | undefined;
    for await (const delta of this.backend.chat(request, { signal })) {
      if (delta.content) {
        content += delta.content;
        if (streamAnswer) this.onAnswerDelta(delta.content);
      }
      if (delta.tokensPerSecond !== undefined)
        tokensPerSecond = delta.tokensPerSecond;
    }
    return {
      content,
      ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
    };
  }

  private async validatedGeneration(
    signal?: AbortSignal,
  ): Promise<ValidatedGeneration | null> {
    let state: DegradationState = initialDegradationState(
      this.constrained ? "constrained" : "unconstrained-repair",
    );
    const extra: ChatMessage[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generated = await this.generate(
        `${this.harnessPrompt}\n\n${toolSystemPrompt(this.tools)}`,
        extra,
        state.rung === "constrained",
        signal,
      );
      const parsed = parseToolCall(generated.content, this.tools);
      const decision = nextDegradationStep(state, parsed);
      state = decision.state;
      if (decision.action === "execute") {
        return { decision, content: generated.content };
      }
      if (decision.action === "report-chat-only") return null;
      const reason = parsed.valid
        ? "unexpected tool policy state"
        : parsed.reason;
      this.onActivity(
        decision.action === "retry-unconstrained"
          ? "constrained tool output was invalid; retrying strict JSON without grammar"
          : "tool output was invalid; using the one bounded repair attempt",
      );
      extra.push(
        { role: "assistant", content: generated.content },
        {
          role: "user",
          content: repairPrompt(reason, decision.action === "reprompt-repair"),
        },
      );
    }
    return null;
  }

  private async surrender(
    reason: string,
    activity: readonly string[],
    toolTurns: number,
    signal?: AbortSignal,
    stopReason: AgentTurnResult["stopReason"] = "validation-failed",
  ): Promise<AgentTurnResult> {
    const notice = `Tool loop surrendered to chat-only: ${reason}. No further tools will run for this turn.`;
    this.onActivity(notice);
    const summary =
      activity.length > 0 ? activity.join("; ") : "no validated tool calls";
    const systemPrompt = `${this.harnessPrompt}\n\nTool execution is unavailable for the remainder of this turn.
Answer in plain text. Be explicit about facts you could not verify, do not emit tool-call JSON, and do not claim a tool ran.
Tool activity summary: ${summary}`;
    const generation = await this.generate(
      systemPrompt,
      [],
      false,
      signal,
      true,
    );
    const answer = generation.content || notice;
    this.retain({ role: "assistant", content: answer });
    return {
      answer,
      toolTurns,
      surrendered: true,
      stopReason,
      ...(generation.tokensPerSecond === undefined
        ? {}
        : { tokensPerSecond: generation.tokensPerSecond }),
    };
  }

  async runUserTurn(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentTurnResult> {
    this.beginTurn(prompt);
    const activity: string[] = [];
    let toolTurns = 0;

    try {
      while (true) {
        const validated = await this.validatedGeneration(signal);
        if (!validated) {
          return await this.surrender(
            "strict validation failed after bounded repair",
            activity,
            toolTurns,
            signal,
          );
        }
        const { tool, args } = validated.decision.call;
        if (tool === "answer") {
          const outcome = await executeToolDecision(validated.decision, {
            projectRoot: this.projectRoot,
            policy: this.policy,
            confirm: this.confirm,
            host: this.host,
          });
          this.onToolOutcome(tool, args, outcome);
          const answer = outcome.result;
          this.retain({ role: "assistant", content: validated.content });
          this.onAnswerDelta(answer);
          return { answer, toolTurns, surrendered: false };
        }
        if (toolTurns >= this.maxToolTurns) {
          return await this.surrender(
            `maximum ${this.maxToolTurns} tool turns reached`,
            activity,
            toolTurns,
            signal,
            "tool-budget",
          );
        }

        toolTurns += 1;
        const summary = toolActivity(tool, args);
        activity.push(summary);
        this.onActivity(summary);
        const outcome = await executeToolDecision(validated.decision, {
          projectRoot: this.projectRoot,
          policy: this.policy,
          confirm: this.confirm,
          host: this.host,
        });
        this.onToolOutcome(tool, args, outcome);
        this.checkpointGuard.recordToolResult(outcome.result);
        const outcomeDetail =
          outcome.status === "executed"
            ? ""
            : `: ${outcome.result.length > 500 ? `${outcome.result.slice(0, 500)}…` : outcome.result}`;
        this.onActivity(`${tool} -> ${outcome.status}${outcomeDetail}`);
        activity[activity.length - 1] =
          `${summary} -> ${outcome.status}${outcomeDetail}`;
        this.retain(
          { role: "assistant", content: validated.content },
          {
            role: "user",
            content: `TOOL RESULT for ${tool} (${outcome.status}):\n${outcome.result}\nUse only this result. Choose the next tool or call answer.`,
          },
        );
        if (toolTurns >= this.maxToolTurns) {
          return await this.surrender(
            `maximum ${this.maxToolTurns} tool turns reached`,
            activity,
            toolTurns,
            signal,
            "tool-budget",
          );
        }
      }
    } finally {
      this.finishTurn();
    }
  }

  /** Write one idempotent handoff checkpoint when the user cleanly ends the session. */
  async checkpointSession(): Promise<SessionCheckpointResult> {
    if (!this.memory)
      return { status: "skipped", reason: "KödMem is unavailable" };
    if (this.sessionCheckpointWritten) {
      return {
        status: "skipped",
        reason: "session checkpoint already written",
      };
    }
    const messages = this.retainedTurns.flat();
    const proposed = await this.summarizeForCheckpoint(messages);
    const draft =
      proposed && this.checkpointGuard.accepts(proposed)
        ? proposed
        : genericCheckpoint(this.retainedTurns.length);
    if (proposed && draft !== proposed) {
      this.onActivity(
        "unsafe checkpoint summary replaced with a generic KödMem checkpoint",
      );
    }
    const idempotencyKey = `${this.memory.sessionId}:end`;
    try {
      const summary = this.memory.checkpointSummaryPrefix
        ? `${this.memory.checkpointSummaryPrefix} ${draft.summary}`
        : draft.summary;
      const written = await this.memory.client.checkpoint({
        workspaceRoot: this.memory.workspaceRoot,
        summary,
        nextActions: draft.nextActions,
        sessionId: this.memory.sessionId,
        idempotencyKey,
        updateState: false,
      });
      this.sessionCheckpointWritten = true;
      const checkpointId =
        written &&
        typeof written === "object" &&
        !Array.isArray(written) &&
        typeof (written as { id?: unknown }).id === "string"
          ? (written as { id: string }).id
          : undefined;
      return {
        status: "written",
        idempotencyKey,
        ...(checkpointId ? { checkpointId } : {}),
      };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
