import { describe, expect, it } from "vitest";
import { cleanTranscript, type CleanupProvider } from "./pipeline";
import type { Vocabulary } from "../vocabulary/types";

const vocab = (...terms: string[]): Vocabulary => ({ terms });

// Golden corpus: rambling dictation → expected clean prompt. Each row names the
// behavior it pins so a regression points straight at the rule that broke.
type Row = {
  name: string;
  raw: string;
  expected: string;
  vocabulary?: Vocabulary;
  provider?: CleanupProvider;
};

const ROWS: Row[] = [
  // --- edge cases ---------------------------------------------------------
  { name: "empty string", raw: "", expected: "" },
  { name: "whitespace only", raw: "   \n\t  ", expected: "" },
  {
    name: "all filler collapses to empty",
    raw: "um uh basically you know",
    expected: "",
  },

  // --- filler strip -------------------------------------------------------
  {
    name: "strips leading and mid fillers",
    raw: "um can you basically add a test",
    expected: "Can you add a test",
  },
  {
    name: "strips filler phrases",
    raw: "add a sort of retry, you know",
    expected: "Add a retry,",
  },
  {
    name: "leading actually is a discourse marker",
    raw: "actually run the linter",
    expected: "Run the linter",
  },

  // --- self-correction ----------------------------------------------------
  {
    name: "no wait collapses the correction",
    raw: "run the tests no wait run the build",
    expected: "Run the build",
  },
  {
    name: "i mean replaces the target",
    raw: "open the file i mean the folder",
    expected: "The folder",
  },
  {
    name: "correction respects the sentence boundary",
    raw: "keep the config. delete the cache no wait the logs",
    expected: "Keep the config. The logs",
  },

  // --- slash commands (provider-aware) ------------------------------------
  {
    name: "expands slash command for claude",
    raw: "slash plan add integration tests",
    provider: "claude",
    expected: "/plan add integration tests",
  },
  {
    name: "generic provider leaves slash words alone",
    raw: "slash plan",
    provider: "generic",
    expected: "Slash plan",
  },

  // --- spoken symbols & punctuation ---------------------------------------
  {
    name: "maps spoken parentheses",
    raw: "wrap open paren value close paren",
    expected: "Wrap (value)",
  },
  {
    name: "maps sentence punctuation words",
    raw: "run the build comma then the tests period",
    expected: "Run the build, then the tests.",
  },
  {
    name: "maps new line command",
    raw: "first line new line second line",
    expected: "First line\nSecond line",
  },

  // --- identifier / path repair against vocabulary ------------------------
  {
    name: "repairs camelCase, snake_case, and file paths",
    raw: "update the app store and call vox start in projects dot ts",
    vocabulary: vocab("appStore", "voxStart", "projects.ts"),
    expected: "Update the appStore and call voxStart in projects.ts",
  },
  {
    name: "repairs a snake_case identifier spoken with underscore",
    raw: "invoke vox underscore start now",
    vocabulary: vocab("vox_start"),
    expected: "Invoke vox_start now",
  },
  {
    name: "repairs a kebab identifier spoken as words",
    raw: "download the large v3 turbo model",
    vocabulary: vocab("large-v3-turbo"),
    expected: "Download the large-v3-turbo model",
  },
  {
    name: "longest vocabulary term wins",
    raw: "read the vox start args type",
    vocabulary: vocab("voxStart", "voxStartArgs"),
    expected: "Read the voxStartArgs type",
  },
  {
    name: "leaves unknown identifiers untouched",
    raw: "call the app store helper",
    vocabulary: vocab(),
    expected: "Call the app store helper",
  },

  // --- correction cues must not fire across word boundaries ---------------
  // or against a literal noun phrase that happens to reuse the cue words.
  {
    name: "no wait cue must not span two unrelated words",
    raw: "the piano waits for no one to arrive",
    expected: "The piano waits for no one to arrive",
  },
  {
    name: "scratch that as a literal folder name is not a correction",
    raw: "open the scratch that folder and list files",
    expected: "Open the scratch that folder and list files",
  },
  {
    name: "scratch that still collapses as a real correction",
    raw: "keep the config. delete the cache scratch that the logs",
    expected: "Keep the config. The logs",
  },

  // --- unicode & code content --------------------------------------------
  {
    name: "preserves unicode content",
    raw: "add a note about café résumé and déjà vu",
    expected: "Add a note about café résumé and déjà vu",
  },
  {
    name: "does not recapitalize a dictated identifier at sentence start",
    raw: "appStore needs a reset",
    vocabulary: vocab("appStore"),
    expected: "appStore needs a reset",
  },
];

describe("cleanTranscript", () => {
  for (const row of ROWS) {
    it(row.name, () => {
      expect(
        cleanTranscript(row.raw, {
          vocabulary: row.vocabulary,
          provider: row.provider,
        }),
      ).toBe(row.expected);
    });
  }

  it("is idempotent — cleaning a clean transcript is a no-op", () => {
    const once = cleanTranscript(
      "update the app store and call vox start in projects dot ts",
      { vocabulary: vocab("appStore", "voxStart", "projects.ts") },
    );
    const twice = cleanTranscript(once, {
      vocabulary: vocab("appStore", "voxStart", "projects.ts"),
    });
    expect(twice).toBe(once);
  });

  it("measurably shortens a rambling utterance versus the raw transcript", () => {
    const raw = "um so basically i want to you know run the whole build";
    const clean = cleanTranscript(raw, { provider: "claude" });
    expect(clean.length).toBeLessThan(raw.length);
    expect(clean.toLowerCase()).not.toContain("um ");
    expect(clean.toLowerCase()).not.toContain("basically");
    expect(clean).toBe("So i want to run the whole build");
  });
});
