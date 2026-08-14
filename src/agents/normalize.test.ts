import { describe, expect, it } from "vitest";
import {
  asRecord,
  asNumber,
  asString,
  planEvent,
  tokenUsage,
  tokenUsageFromRecord,
} from "./normalize";

describe("agent stream normalization", () => {
  it("accepts only JSON object and string shapes", () => {
    expect(asRecord({ value: 1 })).toEqual({ value: 1 });
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asString("value")).toBe("value");
    expect(asString(1)).toBeNull();
    expect(asNumber(1)).toBe(1);
    expect(asNumber(Number.NaN)).toBeNull();
  });

  it("normalizes provider plan items through one status vocabulary", () => {
    expect(
      planEvent(
        [
          { content: "Inspect", status: "completed" },
          { text: "Change", status: "in_progress" },
          { content: "Verify", status: "in-progress" },
          { text: "Ship", completed: true },
          { status: "pending" },
        ],
        ["content", "text"],
      ),
    ).toEqual({
      type: "plan",
      items: [
        { text: "Inspect", status: "completed" },
        { text: "Change", status: "in-progress" },
        { text: "Verify", status: "in-progress" },
        { text: "Ship", status: "completed" },
      ],
    });
  });

  it("omits empty plans and builds finite numeric usage", () => {
    expect(planEvent("not-an-array", ["content"])).toBeNull();
    expect(tokenUsage(12, 5)).toEqual({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
    });
    expect(tokenUsage(12, 5, 24)).toEqual({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 24,
    });
    expect(
      tokenUsageFromRecord({ input_tokens: 12, output_tokens: 5 }),
    ).toEqual({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
    });
    expect(tokenUsageFromRecord(null)).toBeNull();
    expect(tokenUsage(Number.NaN, "5")).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});
