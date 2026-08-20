// Agent persona model (#64): defensive parse, bounds, dedupe, and the
// create/update clamps. Mirrors the KödWork model's parse-never-throws contract.

import { describe, expect, it } from "vitest";
import {
  KODAGENT_DOC_VERSION,
  MAX_CONNECTION_REFS,
  MAX_NAME_CHARS,
  MAX_PERSONAS,
  MAX_PROMPT_CHARS,
  MAX_SKILL_REFS,
  createPersona,
  emptyPersonaDoc,
  parsePersistedPersonaDoc,
  updatePersona,
  type AgentPersona,
} from "./persona";

function persona(overrides: Partial<AgentPersona> = {}): AgentPersona {
  return {
    id: "p1",
    name: "Reviewer",
    prompt: "You review code.",
    providerId: "claude",
    skills: ["kodskills:eng:review"],
    connections: ["conn-1"],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("createPersona", () => {
  it("stamps id and timestamps and applies defaults", () => {
    const made = createPersona("id-1", 5000, { providerId: "codex" });
    expect(made).toEqual({
      id: "id-1",
      name: "New persona",
      prompt: "",
      providerId: "codex",
      skills: [],
      connections: [],
      createdAt: 5000,
      updatedAt: 5000,
    });
  });

  it("clamps name, prompt, and ref lists on creation", () => {
    const made = createPersona("id-2", 1, {
      providerId: "claude",
      name: "n".repeat(MAX_NAME_CHARS + 40),
      prompt: "p".repeat(MAX_PROMPT_CHARS + 100),
      skills: Array.from({ length: MAX_SKILL_REFS + 10 }, (_, i) => `s${i}`),
      connections: Array.from({ length: MAX_CONNECTION_REFS + 10 }, (_, i) => `c${i}`),
    });
    expect(made.name.length).toBe(MAX_NAME_CHARS);
    expect(made.prompt.length).toBe(MAX_PROMPT_CHARS);
    expect(made.skills.length).toBe(MAX_SKILL_REFS);
    expect(made.connections.length).toBe(MAX_CONNECTION_REFS);
  });

  it("dedupes and drops blank refs", () => {
    const made = createPersona("id-3", 1, {
      providerId: "claude",
      skills: ["a", "a", "  ", "b", " b "],
    });
    expect(made.skills).toEqual(["a", "b"]);
  });
});

describe("updatePersona", () => {
  it("patches only supplied fields and bumps updatedAt", () => {
    const next = updatePersona(persona(), { prompt: "New prompt" }, 9000);
    expect(next.prompt).toBe("New prompt");
    expect(next.name).toBe("Reviewer");
    expect(next.createdAt).toBe(1000);
    expect(next.updatedAt).toBe(9000);
  });

  it("clamps a changed ref list", () => {
    const next = updatePersona(
      persona(),
      { skills: Array.from({ length: MAX_SKILL_REFS + 5 }, (_, i) => `s${i}`) },
      2,
    );
    expect(next.skills.length).toBe(MAX_SKILL_REFS);
  });
});

describe("parsePersistedPersonaDoc", () => {
  it("returns an empty doc for a non-object", () => {
    expect(parsePersistedPersonaDoc(null)).toEqual(emptyPersonaDoc());
    expect(parsePersistedPersonaDoc("nope")).toEqual(emptyPersonaDoc());
    expect(parsePersistedPersonaDoc(42)).toEqual(emptyPersonaDoc());
  });

  it("round-trips a valid document and normalizes the version", () => {
    const doc = {
      version: 99,
      app: [persona()],
      projects: { "proj-1": [persona({ id: "p2", name: "Tester" })] },
    };
    const parsed = parsePersistedPersonaDoc(doc);
    expect(parsed.version).toBe(KODAGENT_DOC_VERSION);
    expect(parsed.app).toEqual([persona()]);
    expect(parsed.projects["proj-1"]).toEqual([persona({ id: "p2", name: "Tester" })]);
  });

  it("drops entries missing an id or providerId and unknown fields", () => {
    const parsed = parsePersistedPersonaDoc({
      app: [
        { name: "no id", providerId: "claude" },
        { id: "p3", name: "no provider" },
        { id: "p4", providerId: "claude", name: "ok", ghostField: true },
      ],
    });
    expect(parsed.app.map((p) => p.id)).toEqual(["p4"]);
    expect(parsed.app[0]).not.toHaveProperty("ghostField");
  });

  it("dedupes by id (first wins) within a scope", () => {
    const parsed = parsePersistedPersonaDoc({
      app: [
        persona({ id: "dup", name: "First" }),
        persona({ id: "dup", name: "Second" }),
      ],
    });
    expect(parsed.app.length).toBe(1);
    expect(parsed.app[0].name).toBe("First");
  });

  it("enforces the per-scope persona cap", () => {
    const many = Array.from({ length: MAX_PERSONAS + 25 }, (_, i) =>
      persona({ id: `p${i}` }),
    );
    const parsed = parsePersistedPersonaDoc({ app: many });
    expect(parsed.app.length).toBe(MAX_PERSONAS);
  });

  it("skips a project key that salvaged nothing and non-array buckets", () => {
    const parsed = parsePersistedPersonaDoc({
      projects: {
        empty: [{ id: "bad" }],
        broken: "not an array",
        good: [persona({ id: "pg" })],
      },
    });
    expect(parsed.projects).toEqual({ good: [persona({ id: "pg" })] });
  });

  it("coerces malformed field types to safe defaults", () => {
    const parsed = parsePersistedPersonaDoc({
      app: [
        {
          id: "p5",
          providerId: "claude",
          name: 123,
          prompt: { nope: true },
          skills: ["ok", 7, null, "two"],
          connections: "not-array",
          createdAt: "later",
          updatedAt: 4444,
        },
      ],
    });
    expect(parsed.app[0]).toEqual({
      id: "p5",
      name: "New persona",
      prompt: "",
      providerId: "claude",
      skills: ["ok", "two"],
      connections: [],
      createdAt: 0,
      updatedAt: 4444,
    });
  });
});
