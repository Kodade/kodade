import { describe, expect, it } from "vitest";
import { harvestVocabulary } from "./harvest";
import { buildInitialPrompt, DEFAULT_PROMPT_MAX_CHARS } from "./initialPrompt";

describe("harvestVocabulary", () => {
  it("keeps hard identifiers and drops plain dictionary stems", () => {
    const { terms } = harvestVocabulary({
      files: [
        "src/voice/appStore.ts",
        "src/voice/reducer.ts",
        "src/voice/vox_start.rs",
        "src/index.ts",
      ],
    });
    // camelCase stem + full code file names survive.
    expect(terms).toContain("appStore");
    expect(terms).toContain("appStore.ts");
    expect(terms).toContain("vox_start");
    // Plain lowercase stems whisper gets right are dropped, but the file name
    // (dictated as "reducer dot ts") is still biased.
    expect(terms).not.toContain("reducer");
    expect(terms).toContain("reducer.ts");
    // "index" is a stop stem; only the file name is kept.
    expect(terms).not.toContain("index");
  });

  it("harvests interesting directory segments", () => {
    const { terms } = harvestVocabulary({
      files: ["models/large-v3-turbo/config.json"],
    });
    expect(terms).toContain("large-v3-turbo");
  });

  it("ignores noise directories", () => {
    const { terms } = harvestVocabulary({
      files: ["node_modules/leftPad/index.js", "dist/bundle.js"],
    });
    expect(terms).not.toContain("leftPad");
  });

  it("includes package names and strips npm scopes", () => {
    const { terms } = harvestVocabulary({
      packageNames: ["zustand", "@xterm/xterm"],
    });
    expect(terms).toContain("zustand");
    expect(terms).toContain("@xterm/xterm");
    expect(terms).toContain("xterm");
  });

  it("puts user terms first and never filters them", () => {
    const { terms } = harvestVocabulary({
      files: ["src/appStore.ts"],
      userTerms: ["kodade", "KödWhisper"],
    });
    expect(terms[0]).toBe("kodade");
    expect(terms[1]).toBe("KödWhisper");
  });

  it("dedupes case-insensitively, keeping first-seen casing and order", () => {
    const { terms } = harvestVocabulary({
      userTerms: ["Kodade"],
      packageNames: ["kodade"],
    });
    expect(terms).toEqual(["Kodade"]);
  });

  it("caps the harvested list", () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/thing${i}Widget.ts`);
    const { terms } = harvestVocabulary({ files, limit: 10 });
    expect(terms.length).toBeLessThanOrEqual(10);
  });

  it("returns an empty vocabulary for empty input", () => {
    expect(harvestVocabulary({}).terms).toEqual([]);
  });
});

describe("buildInitialPrompt", () => {
  it("returns null for an empty vocabulary", () => {
    expect(buildInitialPrompt({ terms: [] })).toBeNull();
  });

  it("formats terms as a bounded, lead-in prompt", () => {
    const prompt = buildInitialPrompt({ terms: ["appStore", "voxStart"] });
    expect(prompt).toBe("Technical terms: appStore, voxStart.");
  });

  it("caps the prompt to the character budget at a term boundary", () => {
    const terms = Array.from({ length: 500 }, (_, i) => `identifier${i}`);
    const prompt = buildInitialPrompt({ terms });
    expect(prompt).not.toBeNull();
    expect(prompt!.length).toBeLessThanOrEqual(DEFAULT_PROMPT_MAX_CHARS);
    expect(prompt!.endsWith(".")).toBe(true);
    // Never truncates mid-term: the last listed term is a whole input term.
    const lastTerm = prompt!.replace(/\.$/, "").split(", ").at(-1);
    expect(terms).toContain(lastTerm);
  });
});
