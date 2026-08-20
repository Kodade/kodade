// Persona → draft mapping (#64, slice 2). A persona fills in a draft's prompt
// (outcome) and provider only; it deliberately carries no access level, so a
// launched run keeps the task model's own default.

import { describe, expect, it } from "vitest";
import { createPersona } from "./persona";
import { personaDraftInput } from "./persona-run";

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
