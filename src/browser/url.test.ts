import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl } from "./url";

describe("normalizeBrowserUrl", () => {
  it.each([
    ["example.com", "https://example.com/"],
    [" example.com/docs ", "https://example.com/docs"],
    ["http://localhost:3000", "http://localhost:3000/"],
    ["https://example.com?q=1#two", "https://example.com/?q=1#two"],
    ["https://good.example@evil.example", "https://good.example@evil.example/"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeBrowserUrl(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "file:///tmp/a",
    "javascript:alert(1)",
    "ftp://example.com",
    "kodade-doc://localhost/repo/secret.pdf",
    "tauri://localhost",
    "data:text/html,<script>alert(1)</script>",
    "http://",
  ])("rejects %s", (input) => expect(normalizeBrowserUrl(input)).toBeNull());
});
