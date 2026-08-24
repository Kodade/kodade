// Persona → draft mapping (#64, slice 2). A persona fills in a draft's prompt
// (outcome) and provider only; it deliberately carries no access level, so a
// launched run keeps the task model's own default.

import { describe, expect, it } from "vitest";
import { createPersona } from "./persona";
import { personaDraftInput, personaTaskTitle } from "./persona-run";

describe("personaDraftInput", () => {
  it("maps prompt to outcome and passes the provider through", () => {
    const persona = createPersona("id-1", 1000, {
      providerId: "codex",
      name: "Reviewer",
      prompt: "Keep the diff small and explain the risk.",
      skills: ["code-review"],
      connections: ["c1"],
    });
    expect(personaDraftInput(persona)).toStrictEqual({
      outcome: "Keep the diff small and explain the risk.",
      providerId: "codex",
    });
  });

  it("does not surface skills, connections, or an access level", () => {
    const persona = createPersona("id-2", 1000, {
      providerId: "claude",
      prompt: "",
    });
    const draft = personaDraftInput(persona);
    expect(Object.keys(draft).sort()).toStrictEqual(["outcome", "providerId"]);
  });
});

// #103: a persona launch must title from the persona's NAME, never from the
// prompt text — the outcome-derived titler otherwise lifts words straight out
// of the system prompt ("You are the Code Reviewer, a recurring review
// agent…" → "Code Reviewer recurring"), inventing schedule semantics the task
// was never actually configured with.
describe("personaTaskTitle", () => {
  it("titles from the persona name and a stable date, not the prompt", () => {
    const title = personaTaskTitle("Code Reviewer", Date.parse("2026-08-23T14:00:00Z"));
    expect(title).toBe("Code Reviewer — 2026-08-23");
    expect(title).not.toContain("recurring");
  });

  it("falls back to a generic name when the persona name is blank", () => {
    expect(personaTaskTitle("   ", Date.parse("2026-08-23T00:00:00Z"))).toBe(
      "Agent — 2026-08-23",
    );
  });
});
