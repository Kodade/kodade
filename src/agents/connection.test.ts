// Connection model (#64, slice 4): mint/update validation, transport
// normalization, bounds clamping, and document parse/version discipline. Mirrors
// persona.test.ts — a malformed entry is skipped, a malformed document returns
// null so the store refuses to overwrite it.

import { describe, expect, it } from "vitest";
import {
  createConnection,
  isValidTransport,
  KODCONNECTION_DOC_VERSION,
  MAX_ARGS,
  MAX_CONNECTIONS,
  parsePersistedConnectionDoc,
  updateConnection,
  type ConnectionInput,
} from "./connection";

const HTTP: ConnectionInput = {
  source: "catalog",
  catalogId: "github",
  name: "GitHub",
  transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
  authNote: "OAuth or PAT",
};

const STDIO: ConnectionInput = {
  source: "custom",
  name: "Fetch",
  transport: { kind: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
};

describe("createConnection", () => {
  it("mints an http connection and stamps id/clock", () => {
    const c = createConnection("c1", 42, HTTP);
    expect(c).toMatchObject({
      id: "c1",
      name: "GitHub",
      source: "catalog",
      catalogId: "github",
      transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" },
      createdAt: 42,
      updatedAt: 42,
    });
  });

  it("mints a stdio connection and drops a catalogId on a custom source", () => {
    const c = createConnection("c2", 1, { ...STDIO, catalogId: "sneaky" });
    expect(c.source).toBe("custom");
    expect(c.catalogId).toBeUndefined();
    expect(c.transport).toStrictEqual({ kind: "stdio", command: "uvx", args: ["mcp-server-fetch"] });
  });

  it("trims the command and clamps the arg count", () => {
    const c = createConnection("c3", 1, {
      source: "custom",
      transport: {
        kind: "stdio",
        command: "  npx  ",
        args: Array.from({ length: MAX_ARGS + 10 }, (_, i) => `a${i}`),
      },
    });
    expect(c.transport).toStrictEqual({
      kind: "stdio",
      command: "npx",
      args: expect.any(Array),
    });
    if (c.transport.kind === "stdio") expect(c.transport.args).toHaveLength(MAX_ARGS);
  });

  it("throws on a blank stdio command and a blank http url", () => {
    expect(() =>
      createConnection("x", 1, { source: "custom", transport: { kind: "stdio", command: "   ", args: [] } }),
    ).toThrow();
    expect(() =>
      createConnection("x", 1, { source: "custom", transport: { kind: "http", url: "" } }),
    ).toThrow();
  });
});

describe("isValidTransport", () => {
  it("accepts a real stdio/http transport and rejects junk", () => {
    expect(isValidTransport({ kind: "stdio", command: "npx", args: [] })).toBe(true);
    expect(isValidTransport({ kind: "http", url: "https://x" })).toBe(true);
    expect(isValidTransport({ kind: "stdio", command: "" })).toBe(false);
    expect(isValidTransport({ kind: "http" })).toBe(false);
    expect(isValidTransport(null)).toBe(false);
    expect(isValidTransport({ kind: "smtp" })).toBe(false);
  });
});

describe("updateConnection", () => {
  it("patches only the changed fields and stamps updatedAt", () => {
    const base = createConnection("c1", 1, HTTP);
    const next = updateConnection(base, { name: "GH" }, 99);
    expect(next.name).toBe("GH");
    expect(next.transport).toStrictEqual(base.transport);
    expect(next.updatedAt).toBe(99);
    expect(next.createdAt).toBe(1);
    expect(next.source).toBe("catalog");
  });

  it("rejects an update to an invalid transport", () => {
    const base = createConnection("c1", 1, STDIO);
    expect(() => updateConnection(base, { transport: { kind: "http", url: " " } }, 2)).toThrow();
  });
});

describe("parsePersistedConnectionDoc", () => {
  it("returns null for a non-object or an unknown/forward version", () => {
    expect(parsePersistedConnectionDoc(null)).toBeNull();
    expect(parsePersistedConnectionDoc(42)).toBeNull();
    expect(parsePersistedConnectionDoc({ version: KODCONNECTION_DOC_VERSION + 1, app: [] })).toBeNull();
  });

  it("skips a malformed entry but keeps the good ones", () => {
    const doc = parsePersistedConnectionDoc({
      version: KODCONNECTION_DOC_VERSION,
      app: [
        { id: "ok", source: "custom", transport: { kind: "stdio", command: "npx", args: [] } },
        { id: "", source: "custom", transport: { kind: "stdio", command: "npx" } }, // no id
        { id: "bad", source: "custom", transport: { kind: "smtp" } }, // bad transport
        { id: "ok" }, // no transport
      ],
      projects: {},
    });
    expect(doc?.app.map((c) => c.id)).toStrictEqual(["ok"]);
  });

  it("drops unsafe project keys and empties, and dedupes by id", () => {
    const doc = parsePersistedConnectionDoc({
      version: KODCONNECTION_DOC_VERSION,
      app: [
        { id: "dup", source: "custom", transport: { kind: "http", url: "https://a" } },
        { id: "dup", source: "custom", transport: { kind: "http", url: "https://b" } },
      ],
      projects: {
        __proto__: [{ id: "evil", source: "custom", transport: { kind: "http", url: "https://x" } }],
        p1: [{ id: "p", source: "catalog", catalogId: "notion", transport: { kind: "http", url: "https://n" } }],
        empty: [{ id: "" }],
      },
    });
    expect(doc?.app).toHaveLength(1);
    expect(Object.keys(doc?.projects ?? {})).toStrictEqual(["p1"]);
  });

  it("bounds a scope at MAX_CONNECTIONS", () => {
    const many = Array.from({ length: MAX_CONNECTIONS + 5 }, (_, i) => ({
      id: `c${i}`,
      source: "custom",
      transport: { kind: "stdio", command: "npx", args: [] },
    }));
    const doc = parsePersistedConnectionDoc({
      version: KODCONNECTION_DOC_VERSION,
      app: many,
      projects: {},
    });
    expect(doc?.app).toHaveLength(MAX_CONNECTIONS);
  });
});
