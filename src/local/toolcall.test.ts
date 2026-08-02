import { describe, expect, expectTypeOf, it } from "vitest";
import {
  compileToolGrammar,
  initialDegradationState,
  MAX_TOOL_GRAMMAR_BYTES,
  nextDegradationStep,
  parseToolCall,
  ToolGrammarSizeError,
  type ToolCall,
  type ToolDefinition,
  type ToolCallParseResult,
  type ValidatedToolCall,
} from "./toolcall";

const EVAL_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "configure",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["safe", "quoted\"mode"] },
        retries: { type: "number" },
        enabled: { type: "boolean" },
        target: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      required: ["mode", "enabled"],
    },
  },
  {
    name: "git",
    parameters: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
      },
      required: ["args"],
    },
  },
];

describe("compileToolGrammar", () => {
  it("emits one exact call envelope per tool and JSON-safe value productions", () => {
    const grammar = compileToolGrammar(EVAL_TOOLS);

    expect(grammar).toContain("root ::= ws (tool-0-call | tool-1-call | tool-2-call) ws");
    expect(grammar).toContain(
      'tool-0-call ::= "{" ws "\\\"tool\\\"" ws ":" ws "\\\"read_file\\\"" ws "," ws "\\\"args\\\"" ws ":" ws tool-0-args ws "}"',
    );
    expect(grammar).toContain(
      'tool-0-args ::= "{" ws "\\\"path\\\"" ws ":" ws json-string ws "}"',
    );
    expect(grammar).toContain('"\\\"quoted\\\\\\\"mode\\\""');
    expect(grammar).toContain(String.raw`json-string ::= "\"" json-char* "\""`);
    expect(grammar).toContain(
      String.raw`json-char ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\/bfnrt] | "u" json-hex json-hex json-hex json-hex)`,
    );
    expect(grammar).toContain(
      'json-number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?',
    );
    expect(grammar).toContain('tool-1-args-prop-3 ::= "{" ws "\\\"name\\\""');
    expect(grammar).toContain('tool-2-args-prop-0 ::= "[" ws json-string ws "]"');
  });

  it("round-trips escaped sample output through the strict parser", () => {
    const path = 'docs/my "plan"\\draft\n.md';
    const output = JSON.stringify({ tool: "read_file", args: { path } });

    expect(compileToolGrammar(EVAL_TOOLS)).toContain("tool-0-call");
    expect(parseToolCall(output, EVAL_TOOLS)).toEqual({
      valid: true,
      call: { tool: "read_file", args: { path } },
    });
  });

  it("rejects definitions outside the documented schema subset", () => {
    expect(() =>
      compileToolGrammar([
        {
          name: "bad",
          parameters: {
            type: "object",
            properties: { paths: { type: "null" } as never },
          },
        },
      ]),
    ).toThrow("unsupported schema type null");
    expect(() => compileToolGrammar([EVAL_TOOLS[0], EVAL_TOOLS[0]])).toThrow(
      "duplicate tool name read_file",
    );
  });

  it("rejects reserved prototype-pollution property names in schemas", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(() =>
        compileToolGrammar([
          {
            name: "unsafe",
            parameters: {
              type: "object",
              properties: { [name]: { type: "string" } },
              required: [name],
            },
          },
        ]),
      ).toThrow(`forbidden property name ${name}`);
    }
  });

  it("accepts a grammar exactly at the byte limit and rejects one byte over", () => {
    const grammarFor = (propertyName: string) =>
      compileToolGrammar([
        {
          name: "bounded",
          parameters: {
            type: "object",
            properties: { [propertyName]: { type: "string" } },
            required: [propertyName],
          },
        },
      ]);
    const encoder = new TextEncoder();
    const oneBytePropertyGrammar = grammarFor("x");
    const propertyNameAtLimit = "x".repeat(
      MAX_TOOL_GRAMMAR_BYTES - (encoder.encode(oneBytePropertyGrammar).byteLength - 1),
    );

    expect(encoder.encode(grammarFor(propertyNameAtLimit)).byteLength).toBe(MAX_TOOL_GRAMMAR_BYTES);
    expect(() => grammarFor(`${propertyNameAtLimit}x`)).toThrow(ToolGrammarSizeError);
  });
});

describe("parseToolCall", () => {
  it("brands validated calls so raw model-shaped objects cannot reach execution", () => {
    expectTypeOf<ToolCall>().not.toMatchTypeOf<ValidatedToolCall>();
    expectTypeOf<ValidatedToolCall>().toMatchTypeOf<ToolCall>();
  });

  it("strictly validates the envelope, declared properties, required keys, and types", () => {
    const cases = [
      ["```json\n{}\n```", "valid JSON"],
      ['{"tool":"read_file","args":{}}', "missing required property path"],
      ['{"tool":"read_file","args":{"path":3}}', "path must be a string"],
      ['{"tool":"read_file","args":{"path":"README.md","extra":true}}', "unknown property extra"],
      ['{"tool":"missing","args":{}}', "unknown tool missing"],
      ['{"tool":"read_file","args":{"path":"README.md"},"extra":true}', "exactly tool and args"],
      ['{"args":{"path":"README.md"}}', "exactly tool and args"],
      ['{"tool":"configure","args":{"mode":"fast","enabled":true}}', "mode must be one of"],
      ['{"tool":"configure","args":{"mode":"safe","enabled":1}}', "enabled must be a boolean"],
    ] as const;

    for (const [output, reason] of cases) {
      const result = parseToolCall(output, EVAL_TOOLS);
      expect(result.valid, output).toBe(false);
      if (!result.valid) expect(result.reason).toContain(reason);
    }
  });

  it("accepts optional and nested declared values without repairing the output", () => {
    const result = parseToolCall(
      JSON.stringify({
        tool: "configure",
        args: {
          mode: "safe",
          retries: 2.5,
          enabled: false,
          target: { name: "local" },
        },
      }),
      EVAL_TOOLS,
    );

    expect(result).toEqual({
      valid: true,
      call: {
        tool: "configure",
        args: {
          mode: "safe",
          retries: 2.5,
          enabled: false,
          target: { name: "local" },
        },
      },
    });
  });

  it("strictly validates bounded arrays used by git and gh argv", () => {
    expect(
      parseToolCall('{"tool":"git","args":{"args":["status","--porcelain=v2"]}}', EVAL_TOOLS),
    ).toEqual({
      valid: true,
      call: { tool: "git", args: { args: ["status", "--porcelain=v2"] } },
    });
    for (const output of [
      '{"tool":"git","args":{"args":[]}}',
      '{"tool":"git","args":{"args":["a","b","c","d","e"]}}',
      '{"tool":"git","args":{"args":["status",3]}}',
    ]) {
      const result = parseToolCall(output, EVAL_TOOLS);
      expect(result.valid).toBe(false);
    }
  });

  it("rejects reserved keys parsed from JSON before validating declared arguments", () => {
    const parsed = JSON.parse(
      '{"tool":"read_file","args":{"path":"README.md","__proto__":"polluted"}}',
    ) as { tool: string; args: Record<string, unknown> };
    const result = parseToolCall(JSON.stringify(parsed), EVAL_TOOLS);

    expect(result).toEqual({ valid: false, reason: "args has forbidden property name __proto__" });
  });
});

describe("degradation ladder", () => {
  it("falls from constrained decode to one unconstrained repair, then chat-only", () => {
    const invalid: ToolCallParseResult = { valid: false, reason: "malformed output" };
    const constrained = initialDegradationState("constrained");
    const fallback = nextDegradationStep(constrained, invalid);
    expect(fallback).toEqual({
      action: "retry-unconstrained",
      state: { rung: "unconstrained-repair", repairUsed: false },
    });

    const repair = nextDegradationStep(fallback.state, invalid);
    expect(repair).toEqual({
      action: "reprompt-repair",
      state: { rung: "unconstrained-repair", repairUsed: true },
    });

    expect(nextDegradationStep(repair.state, invalid)).toEqual({
      action: "report-chat-only",
      state: { rung: "chat-only" },
    });
  });

  it("executes only the call carried by a valid parser result", () => {
    const parsed = parseToolCall('{"tool":"read_file","args":{"path":"README.md"}}', EVAL_TOOLS);
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;

    const decision = nextDegradationStep(initialDegradationState("constrained"), parsed);
    expect(decision.action).toBe("execute");
    if (decision.action === "execute") {
      expect(decision.call).toBe(parsed.call);
      expect(decision.state).toEqual({ rung: "constrained" });
    }
  });

  it("never executes an invalid parser result on any degradation rung", () => {
    const invalid: ToolCallParseResult = { valid: false, reason: "malformed output" };
    const states = [
      initialDegradationState("constrained"),
      initialDegradationState("unconstrained-repair"),
      { rung: "unconstrained-repair", repairUsed: true } as const,
      { rung: "chat-only" } as const,
    ];

    for (const state of states) {
      expect(nextDegradationStep(state, invalid).action).not.toBe("execute");
    }
  });
});
