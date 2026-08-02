// M10g release hardening: a deterministic, seeded fuzz/property corpus proving
// the format-fidelity claim in merge.ts holds across randomly generated JSONC
// and TOML configs — not just the hand-written fixtures in merge.test.ts.
//
// Every generated document varies: comment placement, indentation style,
// blank lines, unicode/emoji keys and values, nested tables/objects, arrays,
// CRLF vs LF line endings, and a leading UTF-8 BOM. For each one we add a
// single new server and assert the SAME invariant merge.ts itself enforces at
// runtime (assertSingleServerAdded) PLUS two things that invariant can't see:
//   1. every original line of `before` survives byte-for-byte in `after`
//      (comments, weird whitespace, and hand-tuned formatting are untouched);
//   2. the file's line-ending style is never mixed by the edit.
//
// No fuzzing library is added as a dependency — this is a small, self-
// contained seeded PRNG (mulberry32) so a failure is exactly reproducible from
// its printed seed, and the corpus runs in milliseconds under vitest.
import { describe, expect, it } from "vitest";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { deepEqual, mergeMcpServer, parseByFormat } from "./merge";

// --- Seeded PRNG (deterministic across CI runs) ---

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

const UNICODE_TOKENS = [
  "café",
  "日本語サーバー",
  "服务号",
  "🚀rocket",
  "naïve-скрипт",
  "emoji🔥name",
  "plain-ascii",
  "with spaces",
  'quote"inside',
  "back\\slash",
  "tab\ttab",
];

function randomToken(rng: () => number): string {
  return `${pick(rng, UNICODE_TOKENS)}-${randInt(rng, 1000)}`;
}

// A scalar value. `allowNull` is false for TOML (the format has no null type
// at all — smol-toml throws on null/undefined anywhere in the document).
function randomScalar(rng: () => number, allowNull: boolean): unknown {
  const kinds = allowNull
    ? (["string", "number", "bool", "null", "unicode"] as const)
    : (["string", "number", "bool", "unicode"] as const);
  switch (pick(rng, kinds)) {
    case "string":
      return pick(rng, ["gh-mcp", "serve", "--flag", "https://example.com/mcp", ""]);
    case "number":
      return pick(rng, [0, 1, -5, 3.14, 1_000_000]);
    case "bool":
      return pick(rng, [true, false]);
    case "null":
      return null;
    case "unicode":
      return randomToken(rng);
  }
}

// A server config object with random shape: always a command, sometimes args
// (array), sometimes env (nested object with a unicode key), sometimes one
// level of further nesting. Depth-capped so generation always terminates.
function randomConfig(
  rng: () => number,
  allowNull: boolean,
  depth = 0,
): Record<string, unknown> {
  const cfg: Record<string, unknown> = { command: randomScalar(rng, allowNull) };
  if (rng() > 0.4) {
    cfg.args = Array.from({ length: 1 + randInt(rng, 3) }, () => randomScalar(rng, allowNull));
  }
  if (rng() > 0.4) {
    cfg.env = { TOKEN: randomScalar(rng, allowNull), [randomToken(rng)]: randomScalar(rng, allowNull) };
  }
  if (depth < 1 && rng() > 0.6) {
    cfg.nested = randomConfig(rng, allowNull, depth + 1);
  }
  return cfg;
}

// A random map of 0-4 neighbor servers with unique unicode-flavored names.
function randomNeighbors(
  rng: () => number,
  allowNull: boolean,
): Record<string, Record<string, unknown>> {
  const neighbors: Record<string, Record<string, unknown>> = {};
  const count = randInt(rng, 5);
  for (let i = 0; i < count; i++) {
    let name = randomToken(rng);
    while (Object.prototype.hasOwnProperty.call(neighbors, name)) name = `${name}-${i}`;
    neighbors[name] = randomConfig(rng, allowNull);
  }
  return neighbors;
}

// Apply a random EOL style and an optional leading BOM to freshly-built LF
// text. Returns the transformed text plus the EOL actually used, so callers
// can split on the SAME separator when checking line-for-line preservation.
function applyEolAndBom(
  rng: () => number,
  text: string,
): { text: string; eol: "\n" | "\r\n"; bom: boolean } {
  const eol = pick(rng, ["\n", "\r\n"] as const);
  let out = eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  const bom = rng() > 0.6;
  if (bom) out = `﻿${out}`;
  return { text: out, eol, bom };
}

// --- JSONC document generation ---

// Hand-assembled (not JSON.stringify'd) so we control comment placement,
// indentation, and blank lines while staying guaranteed-parseable JSONC.
function buildJsoncDoc(
  rng: () => number,
  neighbors: Record<string, unknown>,
  topExtra: [string, unknown] | undefined,
): string {
  const indent = pick(rng, ["  ", "    ", "\t"]);
  const lines: string[] = [];
  if (rng() > 0.5) lines.push(`// ${randomToken(rng)} header comment`);
  lines.push("{");
  if (topExtra) {
    lines.push(`${indent}${JSON.stringify(topExtra[0])}: ${JSON.stringify(topExtra[1])},`);
  }
  if (rng() > 0.5) lines.push(`${indent}// mcp servers configured below`);
  lines.push(`${indent}"mcpServers": {`);
  const keys = Object.keys(neighbors);
  keys.forEach((key, i) => {
    if (rng() > 0.6) lines.push(`${indent}${indent}// entry ${i}: ${key}`);
    const comma = i < keys.length - 1 ? "," : "";
    lines.push(`${indent}${indent}${JSON.stringify(key)}: ${JSON.stringify(neighbors[key])}${comma}`);
  });
  lines.push(`${indent}}`);
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// --- TOML document generation ---

// Build the structural body with smol-toml itself (guaranteed valid, correct
// quoting for unicode/special keys) then inject comment-only lines before
// some `[table]` headers for whitespace/comment variety. Comments are only
// ever inserted before a line starting with "[" (a top-level table header),
// which smol-toml always uses for nested objects — inline tables never
// appear in its output, so this can never land a comment mid-table.
function buildTomlDoc(
  rng: () => number,
  neighbors: Record<string, unknown>,
  topExtra: [string, unknown] | undefined,
): string {
  const bodyObj: Record<string, unknown> = { mcp_servers: neighbors };
  if (topExtra) bodyObj[topExtra[0]] = topExtra[1];
  const body = stringifyToml(bodyObj);
  const out: string[] = [];
  if (rng() > 0.5) out.push(`# ${randomToken(rng)} header comment`);
  for (const line of body.split("\n")) {
    if (line.startsWith("[") && rng() > 0.5) out.push(`# comment before ${line}`);
    out.push(line);
  }
  return out.join("\n");
}

const ITERATIONS = 200;

describe("merge.ts fuzz corpus — JSONC format fidelity (M10g)", () => {
  for (let seed = 0; seed < ITERATIONS; seed++) {
    it(`seed ${seed}: round-trips byte-identical neighbors and comments`, () => {
      const rng = mulberry32(seed);
      const neighbors = randomNeighbors(rng, /* allowNull */ true);
      const topExtra: [string, unknown] | undefined =
        rng() > 0.5 ? ["model", randomToken(rng)] : undefined;
      const rawBefore = buildJsoncDoc(rng, neighbors, topExtra);
      const { text: before, eol } = applyEolAndBom(rng, rawBefore);

      let name = `fuzz-${seed}-${randomToken(rng)}`;
      while (Object.prototype.hasOwnProperty.call(neighbors, name)) name = `${name}-x`;
      const config = randomConfig(rng, true);

      let merge;
      try {
        merge = mergeMcpServer(before, "jsonc", "mcpServers", { name, config });
      } catch (error) {
        throw new Error(
          `seed ${seed} threw unexpectedly: ${(error as Error).message}\n---before---\n${before}`,
        );
      }

      expect(merge.touchedKey).toBe(`mcpServers.${name}`);

      // Structural invariant: reparsing proves EXACTLY the expected shape —
      // every neighbor untouched, the new entry present, top-level extras
      // untouched. One deepEqual against the fully-expected root catches any
      // dropped/altered/misplaced key anywhere in the document.
      const parsed = parseByFormat(merge.after, "jsonc") as Record<string, unknown>;
      const expected: Record<string, unknown> = {
        mcpServers: { ...neighbors, [name]: config },
      };
      if (topExtra) expected[topExtra[0]] = topExtra[1];
      expect(deepEqual(parsed, expected)).toBe(true);

      // Byte-preservation invariant: every original line — comments, blank
      // lines, whatever indentation was chosen — survives verbatim.
      for (const line of before.split(eol)) {
        if (line.length === 0) continue;
        expect(merge.after).toContain(line);
      }

      // EOL consistency: a CRLF source must never gain a bare, un-preceded LF.
      if (eol === "\r\n") {
        expect(merge.after).not.toMatch(/[^\r]\n/);
      }
    });
  }
});

describe("merge.ts fuzz corpus — TOML format fidelity (M10g)", () => {
  for (let seed = 0; seed < ITERATIONS; seed++) {
    it(`seed ${seed}: append-only preserves every prior byte`, () => {
      const rng = mulberry32(seed);
      const neighbors = randomNeighbors(rng, /* allowNull */ false);
      const topExtra: [string, unknown] | undefined =
        rng() > 0.5 ? ["model", randomToken(rng)] : undefined;
      const rawBefore = buildTomlDoc(rng, neighbors, topExtra);
      const { text: before, eol } = applyEolAndBom(rng, rawBefore);

      let name = `fuzz-${seed}-${randomToken(rng)}`;
      while (Object.prototype.hasOwnProperty.call(neighbors, name)) name = `${name}-x`;
      const config = randomConfig(rng, false);

      let merge;
      try {
        merge = mergeMcpServer(before, "toml", "mcp_servers", { name, config });
      } catch (error) {
        throw new Error(
          `seed ${seed} threw unexpectedly: ${(error as Error).message}\n---before---\n${before}`,
        );
      }

      expect(merge.touchedKey).toBe(`mcp_servers.${name}`);

      // The append-only strategy's strongest claim: `after` literally starts
      // with `before` (modulo trailing whitespace) — every prior byte,
      // comment, and blank line untouched, not just structurally equal.
      expect(merge.after.startsWith(before.replace(/\s*$/, ""))).toBe(true);

      const parsed = parseByFormat(merge.after, "toml") as Record<string, unknown>;
      const expected: Record<string, unknown> = {
        mcp_servers: { ...neighbors, [name]: config },
      };
      if (topExtra) expected[topExtra[0]] = topExtra[1];
      expect(deepEqual(parsed, expected)).toBe(true);

      if (eol === "\r\n") {
        expect(merge.after).not.toMatch(/[^\r]\n/);
      }
    });
  }
});

describe("merge.ts fuzz corpus — malformed container shapes never crash or corrupt (M10g)", () => {
  // The two real defects M10g found: a `keyPath` that already holds a
  // non-object value crashed jsonc-parser with a raw internal error, and a
  // TOML inline table produced invalid TOML that only failed on re-parse.
  // Fuzz a spread of non-object shapes for both formats and assert every one
  // aborts with OUR clear "refusing to write" message — never a raw library
  // error, and never a successful merge (which would mean it silently wrote
  // over/beside a value it shouldn't have touched).
  const NON_OBJECT_JSON_VALUES = ['"a string"', "42", "true", "null", "[1,2,3]", '["a","b"]'];

  for (const value of NON_OBJECT_JSON_VALUES) {
    it(`jsonc: mcpServers = ${value} refuses cleanly instead of crashing`, () => {
      const before = `{ "mcpServers": ${value} }`;
      expect(() =>
        mergeMcpServer(before, "jsonc", "mcpServers", { name: "x", config: { command: "y" } }),
      ).toThrow(/is not an object in this JSONC config/);
    });
  }

  const NON_OBJECT_TOML_VALUES = ['"a string"', "42", "true", "[1, 2, 3]", '["a", "b"]'];

  for (const value of NON_OBJECT_TOML_VALUES) {
    it(`toml: mcp_servers = ${value} refuses cleanly instead of writing invalid TOML`, () => {
      const before = `mcp_servers = ${value}\n`;
      expect(() =>
        mergeMcpServer(before, "toml", "mcp_servers", { name: "x", config: { command: "y" } }),
      ).toThrow(/is not an object in this TOML config/);
    });
  }

  // Inline TOML tables of varying shapes: always a friendly, actionable
  // refusal naming the inline-table cause, never the raw smol-toml parser
  // error ("trying to redefine an already defined table or value").
  const INLINE_TABLE_BODIES = [
    'mcp_servers = { github = { command = "gh-mcp" } }',
    'mcp_servers = { a = { command = "x" }, b = { command = "y" } }',
    'mcp_servers = { }',
  ];

  for (const body of INLINE_TABLE_BODIES) {
    it(`toml: inline table "${body}" gives an actionable error, not a raw parser message`, () => {
      const before = `${body}\n`;
      expect(() =>
        mergeMcpServer(before, "toml", "mcp_servers", { name: "svc", config: { command: "z" } }),
      ).toThrow(/inline TOML table/);
    });
  }
});

// Sanity: the generators themselves produce valid documents independent of
// the merge under test (catches a broken generator masquerading as a passing
// merge test).
describe("merge.ts fuzz corpus — generator self-check", () => {
  it("every generated JSONC/TOML document parses on its own", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const rngJ = mulberry32(seed);
      const neighborsJ = randomNeighbors(rngJ, true);
      const before = buildJsoncDoc(rngJ, neighborsJ, undefined);
      expect(() => parseByFormat(before, "jsonc"), `jsonc seed ${seed}`).not.toThrow();

      const rngT = mulberry32(seed + 100_000);
      const neighborsT = randomNeighbors(rngT, false);
      const beforeT = buildTomlDoc(rngT, neighborsT, undefined);
      expect(() => parseToml(beforeT), `toml seed ${seed}`).not.toThrow();
    }
  });
});
