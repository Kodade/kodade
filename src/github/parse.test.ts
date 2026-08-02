import { describe, expect, it } from "vitest";
import { parseAuthStatus, parseGithubList, parseGithubRepoUrl } from "./parse";

describe("gh output parsing", () => {
  it.each([
    [true, "", "ok"],
    [false, "gh is not installed: command not found", "missing"],
    [false, "You are not logged into any GitHub hosts", "unauthenticated"],
    [false, "authentication token is invalid", "unauthenticated"],
  ] as const)("parses auth status %#", (ok, error, expected) => {
    expect(parseAuthStatus({ ok, error })).toBe(expected);
  });

  it("parses empty and populated lists", () => {
    expect(parseGithubList("[]")).toEqual([]);
    expect(
      parseGithubList(
        JSON.stringify([
          {
            number: 43,
            title: "github tab",
            author: { login: "keith" },
            labels: [{ name: "feature" }],
            updatedAt: "2026-07-12T20:00:00Z",
          },
        ]),
      ),
    ).toEqual([
      {
        number: 43,
        title: "github tab",
        author: "keith",
        labels: ["feature"],
        updatedAt: "2026-07-12T20:00:00Z",
      },
    ]);
  });

  it.each(["not json", "{}", "[null]", '[{"number":1}]'])(
    "rejects malformed list JSON: %s",
    (raw) => expect(() => parseGithubList(raw)).toThrow("malformed JSON"),
  );

  it("parses the repository URL", () => {
    expect(parseGithubRepoUrl('{"url":"https://github.com/Kodade/kodade"}')).toBe(
      "https://github.com/Kodade/kodade",
    );
  });

  it.each(["not json", "{}", '{"url":42}', '{"url":"file:///tmp/repo"}'])(
    "rejects malformed repository JSON: %s",
    (raw) => expect(() => parseGithubRepoUrl(raw)).toThrow("malformed repository JSON"),
  );
});
