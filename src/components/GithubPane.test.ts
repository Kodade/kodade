import { describe, expect, it } from "vitest";
import { relativeTime } from "./GithubPane";

describe("relativeTime", () => {
  const now = Date.parse("2026-07-12T20:00:00Z");

  it.each([
    ["2026-07-12T19:59:50Z", "just now"],
    ["2026-07-12T19:55:00Z", "5m ago"],
    ["2026-07-12T17:00:00Z", "3h ago"],
    ["2026-07-10T20:00:00Z", "2d ago"],
  ])("formats %s", (value, expected) => {
    expect(relativeTime(value, now)).toBe(expected);
  });
});
