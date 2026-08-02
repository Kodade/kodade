import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./parse";
import { compileFixPrompt } from "./prompt";

const DIFF =
  "diff --git a/src/mod.ts b/src/mod.ts\n" +
  "index faf3c54..cd51808 100644\n" +
  "--- a/src/mod.ts\n" +
  "+++ b/src/mod.ts\n" +
  "@@ -1,5 +1,6 @@\n" +
  " keep this line\n" +
  "-old body 1\n" +
  "+NEW body 1\n" +
  " old body 2\n" +
  "-old body 3\n" +
  "+NEW body 3\n" +
  " tail\n" +
  "+extra tail\n" +
  "diff --git a/src/other.ts b/src/other.ts\n" +
  "index 111..222 100644\n" +
  "--- a/src/other.ts\n" +
  "+++ b/src/other.ts\n" +
  "@@ -10,2 +10,2 @@\n" +
  "-broken line\n" +
  "+fixed line\n" +
  " trailing context\n";

describe("compileFixPrompt", () => {
  it("orders comments by file then line and quotes the matching excerpt", () => {
    const { items: files } = parseUnifiedDiff(DIFF);
    const prompt = compileFixPrompt(
      [
        { path: "src/other.ts", startLine: 10, endLine: 11, body: "Use the fixed variant consistently." },
        { path: "src/mod.ts", startLine: 2, endLine: 3, body: "Explain why body 1 changed." },
      ],
      files,
    );

    // stable ordering: src/mod.ts (line 2) before src/other.ts (line 10)
    expect(prompt.indexOf("src/mod.ts")).toBeLessThan(prompt.indexOf("src/other.ts"));
    expect(prompt).toContain("## src/mod.ts:2-3");
    expect(prompt).toContain("## src/other.ts:10-11");
    expect(prompt).toContain("Explain why body 1 changed.");
    expect(prompt).toContain("Use the fixed variant consistently.");
    expect(prompt).toContain("keep changes scoped".replace("keep", "Keep"));
  });

  it("produces a stable snapshot for a single comment", () => {
    const { items: files } = parseUnifiedDiff(DIFF);
    const prompt = compileFixPrompt(
      [{ path: "src/mod.ts", startLine: 2, endLine: 3, body: "Explain why body 1 changed." }],
      files,
    );
    expect(prompt).toMatchInlineSnapshot(`
      "Address the following review comments. Each entry quotes the relevant diff excerpt for context.

      ## src/mod.ts:2-3
      \`\`\`diff
      -old body 1
      +NEW body 1
       old body 2
      \`\`\`
      Explain why body 1 changed.

      Keep changes scoped to the comments above — do not make unrelated edits."
    `);
  });

  it("falls back gracefully when a comment references a file not in the diff", () => {
    const { items: files } = parseUnifiedDiff(DIFF);
    const prompt = compileFixPrompt(
      [{ path: "src/missing.ts", startLine: 1, endLine: 1, body: "This file was not included." }],
      files,
    );
    expect(prompt).toContain("(no matching diff excerpt found)");
  });

  it("returns just the preamble and closing instruction for no comments", () => {
    const prompt = compileFixPrompt([], []);
    expect(prompt).toContain("Address the following review comments");
    expect(prompt).toContain("Keep changes scoped");
  });
});
