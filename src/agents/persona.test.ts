// Agent persona model (#64): defensive parse, bounds, dedupe, version handling,
// prototype-key safety, and the create/update clamps + providerId validation.

import { describe, expect, it } from "vitest";
import {
  KODAGENT_DOC_VERSION,
  MAX_CONNECTION_REFS,
  MAX_NAME_CHARS,
  MAX_PERSONAS,
  MAX_PROMPT_CHARS,
  MAX_SKILL_REFS,
  createPersona,
  isValidProviderId,
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

// A full, valid document at the current version around one scope's personas.
function doc(fields: Record<string, unknown>) {
  return { version: KODAGENT_DOC_VERSION, app: [], projects: {}, ...fields };
}

describe("createPersona", () => {
  it("stamps id and timestamps and applies defaults", () => {
    const made = createPersona("id-1", 5000, { providerId: "codex" });
    expect(made).toStrictEqual({
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

  it("trims the providerId and rejects a blank one", () => {
    expect(createPersona("id-a", 1, { providerId: "  claude  " }).providerId).toBe("claude");
    expect(() => createPersona("id-b", 1, { providerId: "   " })).toThrow();
    expect(() => createPersona("id-c", 1, { providerId: "" })).toThrow();
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
    expect(made.skills).toStrictEqual(["a", "b"]);
  });
});

describe("isValidProviderId", () => {
  it("accepts non-empty strings and rejects everything else", () => {
    expect(isValidProviderId("claude")).toBe(true);
    expect(isValidProviderId("  ")).toBe(false);
    expect(isValidProviderId("")).toBe(false);
    expect(isValidProviderId(undefined)).toBe(false);
    expect(isValidProviderId(7)).toBe(false);
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

  it("rejects a change that blanks the providerId", () => {
    expect(() => updatePersona(persona(), { providerId: "  " }, 3)).toThrow();
    // An omitted providerId is left untouched.
    expect(updatePersona(persona(), { name: "x" }, 3).providerId).toBe("claude");
  });
});

describe("parsePersistedPersonaDoc", () => {
  it("returns null for a non-object", () => {
    expect(parsePersistedPersonaDoc(null)).toBeNull();
    expect(parsePersistedPersonaDoc("nope")).toBeNull();
    expect(parsePersistedPersonaDoc(42)).toBeNull();
  });

  it("returns null for a missing, unknown, or forward version", () => {
    expect(parsePersistedPersonaDoc({ app: [], projects: {} })).toBeNull();
    expect(parsePersistedPersonaDoc(doc({ version: 0 }))).toBeNull();
    expect(parsePersistedPersonaDoc(doc({ version: 99 }))).toBeNull();
  });

  it("round-trips a valid document", () => {
    const parsed = parsePersistedPersonaDoc(
      doc({
        app: [persona()],
        projects: { "proj-1": [persona({ id: "p2", name: "Tester" })] },
      }),
    );
    expect(parsed?.version).toBe(KODAGENT_DOC_VERSION);
    expect(parsed?.app).toStrictEqual([persona()]);
    expect(parsed?.projects["proj-1"]).toStrictEqual([persona({ id: "p2", name: "Tester" })]);
  });

  it("drops entries missing an id or providerId and unknown fields", () => {
    const parsed = parsePersistedPersonaDoc(
      doc({
        app: [
          { name: "no id", providerId: "claude" },
          { id: "p3", name: "no provider" },
          { id: "p4", providerId: "claude", name: "ok", ghostField: true },
        ],
      }),
    );
    expect(parsed?.app.map((p) => p.id)).toStrictEqual(["p4"]);
    expect(parsed?.app[0]).not.toHaveProperty("ghostField");
  });

  it("dedupes by id (first wins) within a scope", () => {
    const parsed = parsePersistedPersonaDoc(
      doc({
        app: [
          persona({ id: "dup", name: "First" }),
          persona({ id: "dup", name: "Second" }),
        ],
      }),
    );
    expect(parsed?.app.length).toBe(1);
    expect(parsed?.app[0].name).toBe("First");
  });

  it("enforces the per-scope persona cap", () => {
    const many = Array.from({ length: MAX_PERSONAS + 25 }, (_, i) =>
      persona({ id: `p${i}` }),
    );
    const parsed = parsePersistedPersonaDoc(doc({ app: many }));
    expect(parsed?.app.length).toBe(MAX_PERSONAS);
  });

  it("skips a project key that salvaged nothing and non-array buckets", () => {
    const parsed = parsePersistedPersonaDoc(
      doc({
        projects: {
          empty: [{ id: "bad" }],
          broken: "not an array",
          good: [persona({ id: "pg" })],
        },
      }),
    );
    expect(parsed?.projects).toStrictEqual({ good: [persona({ id: "pg" })] });
  });

  it("never lets a __proto__ project key pollute the prototype", () => {
    const raw = JSON.parse(
      `{"version":1,"app":[],"projects":{"__proto__":[{"id":"x","providerId":"claude"}],"real":[{"id":"y","providerId":"claude"}]}}`,
    );
    const parsed = parsePersistedPersonaDoc(raw);
    expect(parsed).not.toBeNull();
    // The dangerous key was dropped, the real bucket kept, and no prototype
    // was rewritten on the result.
    expect(Object.keys(parsed!.projects)).toStrictEqual(["real"]);
    expect(Object.getPrototypeOf(parsed!.projects)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("coerces malformed field types to safe defaults", () => {
    const parsed = parsePersistedPersonaDoc(
      doc({
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
      }),
    );
    expect(parsed?.app[0]).toStrictEqual({
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
