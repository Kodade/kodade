import type { ChatMessage } from "./backend";

const MESSAGE_OVERHEAD_TOKENS = 4;
const ELISION = "[earlier turns elided]";

export class ContextBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

/**
 * Cheap v1 estimate: approximately four UTF-16 characters per token. This is
 * intentionally conservative and deterministic; tokenizer-specific counting
 * and model-based summarization are deferred to M14f.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(message: ChatMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content);
}

function totalTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

export type ContextAssembly = {
  messages: ChatMessage[];
  budgetTokens: number;
  estimatedTokens: number;
  elided: boolean;
  /** The oldest messages omitted from this request, in chronological order. */
  elidedTurns: ChatMessage[];
};

export type ContextOptions = {
  systemPrompt: string;
  /** Optional durable KödMem context. It yields budget before harness and goal. */
  memoryContext?: string;
  /** Earlier complete turns were checkpointed and removed from local history. */
  durableElision?: boolean;
  pinnedGoal: ChatMessage | null;
  turns: readonly ChatMessage[];
  modelContextTokens: number;
  maxTokens: number;
  marginTokens?: number;
};

/**
 * Expand an elided message prefix to complete retained turns. Active-turn and
 * repair messages are intentionally absent from this input, so callers can
 * never checkpoint a fragment that is still being generated.
 */
export function selectOldestCompleteTurns(
  retainedTurns: readonly (readonly ChatMessage[])[],
  elidedMessageCount: number,
): (readonly ChatMessage[])[] {
  const selected: (readonly ChatMessage[])[] = [];
  let coveredMessages = 0;
  for (const turn of retainedTurns) {
    if (coveredMessages >= elidedMessageCount) break;
    selected.push(turn);
    coveredMessages += turn.length;
  }
  return selected;
}

function truncateToTokens(
  value: string,
  availableTokens: number,
): string | null {
  const availableCharacters = Math.max(
    0,
    (availableTokens - MESSAGE_OVERHEAD_TOKENS) * 4,
  );
  if (availableCharacters <= 0) return null;
  if (value.length <= availableCharacters) return value;
  if (availableCharacters === 1) return "…";
  return `${value.slice(0, availableCharacters - 1).trimEnd()}…`;
}

/** Assemble system + separately pinned goal + the newest contiguous turns that fit. */
export function assembleContext(options: ContextOptions): ContextAssembly {
  const margin = options.marginTokens ?? 128;
  const budgetTokens = Math.floor(
    options.modelContextTokens - options.maxTokens - margin,
  );
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    throw new ContextBudgetError(
      "model context is smaller than the response reserve",
    );
  }

  const system: ChatMessage = { role: "system", content: options.systemPrompt };
  const pinned = options.pinnedGoal;
  const durableElision = options.durableElision
    ? ({ role: "system", content: ELISION } satisfies ChatMessage)
    : null;
  // Harness + the first user goal are non-negotiable. KödMem is useful but
  // intentionally yields its budget before either one when a model is tight.
  const required = [
    system,
    ...(durableElision ? [durableElision] : []),
    ...(pinned ? [pinned] : []),
  ];
  const requiredTokens = totalTokens(required);
  if (requiredTokens > budgetTokens) {
    throw new ContextBudgetError(
      `system prompt and pinned user goal need about ${requiredTokens} tokens; budget is ${budgetTokens}`,
    );
  }

  const complete = [...required, ...options.turns];
  const completeTokens = totalTokens(complete);
  const elision: ChatMessage = durableElision ?? {
    role: "system",
    content: ELISION,
  };
  let used = requiredTokens;
  let newest = [...options.turns];
  let elided = false;
  let elidedTurns: ChatMessage[] = [];

  if (completeTokens > budgetTokens) {
    used += durableElision ? 0 : messageTokens(elision);
    if (used > budgetTokens) {
      throw new ContextBudgetError(
        `system prompt, pinned user goal, and elision marker need about ${used} tokens; budget is ${budgetTokens}`,
      );
    }
    newest = [];
    let firstIncluded = options.turns.length;
    for (let index = options.turns.length - 1; index >= 0; index -= 1) {
      const candidate = options.turns[index];
      const cost = messageTokens(candidate);
      if (used + cost > budgetTokens) break;
      newest.unshift(candidate);
      firstIncluded = index;
      used += cost;
    }
    elided = true;
    elidedTurns = options.turns.slice(0, firstIncluded);
  } else {
    used = completeTokens;
  }

  // Memory gets only the space left after the harness, pinned goal, and
  // recent turns. It is therefore truncated before we evict local history.
  const memory = options.memoryContext
    ? truncateToTokens(options.memoryContext, budgetTokens - used)
    : null;
  const memoryMessage = memory
    ? ({ role: "system", content: memory } satisfies ChatMessage)
    : null;
  const memoryTokens = memoryMessage ? messageTokens(memoryMessage) : 0;
  const mandatory = [
    system,
    ...(memoryMessage ? [memoryMessage] : []),
    ...(durableElision ? [durableElision] : []),
    ...(pinned ? [pinned] : []),
  ];

  return {
    messages: [
      ...mandatory,
      ...(elided && !durableElision ? [elision] : []),
      ...newest,
    ],
    budgetTokens,
    estimatedTokens: used + memoryTokens,
    elided,
    elidedTurns,
  };
}
