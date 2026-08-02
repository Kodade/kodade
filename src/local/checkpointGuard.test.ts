import { describe, expect, it } from "vitest";
import { containsLikelySecret } from "./checkpointGuard";

describe("KödLocal checkpoint secret guard", () => {
  it.each([
    "-----BEGIN OPENSSH PRIVATE KEY-----\nencoded",
    "AKIA0123456789ABCDEF",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "xoxb-not-a-real-token",
    "api_key = abcdefghijklmnop",
    "ＡＰＩ＿ＫＥＹ＝abcdefghijklmnop",
  ])("matches the KödMCP server secret shapes", (value) => {
    expect(containsLikelySecret(value)).toBe(true);
  });

  it("allows ordinary checkpoint text", () => {
    expect(
      containsLikelySecret("Use the MCP adapter for local project context."),
    ).toBe(false);
  });
});
