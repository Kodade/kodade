import type { TokenUsage } from "../inference/backend";
import type { AgentPlanItem, AgentStreamEvent } from "./contract";

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function tokenUsage(
  inputTokens: unknown,
  outputTokens: unknown,
  totalTokens?: unknown,
): TokenUsage {
  const promptTokens = asNumber(inputTokens) ?? 0;
  const completionTokens = asNumber(outputTokens) ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      asNumber(totalTokens) ?? promptTokens + completionTokens,
  };
}

export function tokenUsageFromRecord(value: unknown): TokenUsage | null {
  const usage = asRecord(value);
  return usage
    ? tokenUsage(usage.input_tokens, usage.output_tokens)
    : null;
}

function planStatus(item: Json): AgentPlanItem["status"] {
  const status = asString(item.status);
  if (item.completed === true || status === "completed") return "completed";
  if (status === "in_progress" || status === "in-progress") {
    return "in-progress";
  }
  return "pending";
}

export function planEvent(
  entries: unknown,
  textFields: readonly string[],
): Extract<AgentStreamEvent, { type: "plan" }> | null {
  if (!Array.isArray(entries)) return null;
  const items: AgentPlanItem[] = [];
  for (const entry of entries) {
    const item = asRecord(entry);
    if (!item) continue;
    let text: string | null = null;
    for (const field of textFields) {
      text = asString(item[field]);
      if (text) break;
    }
    if (!text) continue;
    items.push({ text, status: planStatus(item) });
  }
  return items.length > 0 ? { type: "plan", items } : null;
}
