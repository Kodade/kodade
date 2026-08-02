import { describe, expect, it } from "vitest";
import {
  ContextBudgetError,
  assembleContext,
  estimateTokens,
  selectOldestCompleteTurns,
} from "./context";

describe("KödLocal context manager", () => {
  it("budgets from the model's real window and keeps system, pinned goal, and newest turns", () => {
    const result = assembleContext({
      systemPrompt: "system",
      pinnedGoal: { role: "user", content: "build it" },
      turns: [
        { role: "assistant", content: "x".repeat(80) },
        { role: "user", content: "y".repeat(80) },
        { role: "assistant", content: "recent answer" },
        { role: "user", content: "current request" },
      ],
      modelContextTokens: 72,
      maxTokens: 24,
      marginTokens: 8,
    });

    expect(result.budgetTokens).toBe(40);
    expect(result.messages.map((message) => message.content)).toEqual([
      "system",
      "build it",
      "[earlier turns elided]",
      "recent answer",
      "current request",
    ]);
    expect(result.elided).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
  });

  it("keeps chronological history unchanged when every turn fits", () => {
    const turns = [
      { role: "user" as const, content: "goal" },
      { role: "assistant" as const, content: "done" },
      { role: "user" as const, content: "next" },
    ];
    const result = assembleContext({
      systemPrompt: "rules",
      pinnedGoal: turns[0],
      turns: turns.slice(1),
      modelContextTokens: 200,
      maxTokens: 20,
      marginTokens: 10,
    });
    expect(result.messages).toEqual([
      { role: "system", content: "rules" },
      ...turns,
    ]);
    expect(result.elided).toBe(false);
  });

  it("fails honestly when the system prompt and pinned goal cannot fit", () => {
    expect(() =>
      assembleContext({
        systemPrompt: "system",
        pinnedGoal: { role: "user", content: "goal" },
        turns: [],
        modelContextTokens: 16,
        maxTokens: 6,
        marginTokens: 4,
      }),
    ).toThrow(ContextBudgetError);
  });

  it("documents the conservative four-characters-per-token estimate", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("123456789")).toBe(3);
  });

  it("truncates KödMem context before the harness or pinned goal under pressure", () => {
    const result = assembleContext({
      systemPrompt: "HARNESS",
      memoryContext: "memory ".repeat(200),
      pinnedGoal: { role: "user", content: "PINNED GOAL" },
      turns: [{ role: "assistant", content: "older context".repeat(20) }],
      modelContextTokens: 90,
      maxTokens: 20,
      marginTokens: 10,
    });

    expect(result.messages[0].content).toBe("HARNESS");
    expect(
      result.messages.some((message) => message.content === "PINNED GOAL"),
    ).toBe(true);
    expect(
      result.messages.some((message) => message.content.endsWith("…")),
    ).toBe(true);
    expect(result.elided).toBe(true);
  });

  it("expands an elided message prefix to whole oldest completed turns", () => {
    const toolTurn = [
      { role: "assistant" as const, content: "selected read_file" },
      { role: "user" as const, content: "tool result" },
      { role: "assistant" as const, content: "answered from the result" },
    ];
    const nextTurn = [
      { role: "user" as const, content: "next request" },
      { role: "assistant" as const, content: "next answer" },
    ];

    expect(
      selectOldestCompleteTurns([toolTurn, nextTurn], 2),
    ).toEqual([toolTurn]);
    expect(
      selectOldestCompleteTurns([toolTurn, nextTurn], 4),
    ).toEqual([toolTurn, nextTurn]);
  });
});
