// Durable tool-call boundary for KödLocal. The compiler intentionally supports
// only the JSON Schema subset the loop can validate without coercion.

export type ToolScalar = string | number | boolean;

export type ToolStringSchema = {
  type: "string";
  enum?: readonly string[];
};

export type ToolNumberSchema = {
  type: "number";
  enum?: readonly number[];
};

export type ToolBooleanSchema = {
  type: "boolean";
  enum?: readonly boolean[];
};

export type ToolArraySchema = {
  type: "array";
  items: ToolSchema;
  minItems?: number;
  maxItems?: number;
};

export type ToolEnumSchema = {
  type?: "string" | "number" | "boolean";
  enum: readonly ToolScalar[];
};

export type ToolObjectSchema = {
  type: "object";
  properties: Readonly<Record<string, ToolSchema>>;
  required?: readonly string[];
};

export type ToolSchema =
  | ToolStringSchema
  | ToolNumberSchema
  | ToolBooleanSchema
  | ToolArraySchema
  | ToolEnumSchema
  | ToolObjectSchema;

export type ToolDefinition = {
  name: string;
  description?: string;
  parameters: ToolObjectSchema;
};

export type ToolCall = {
  tool: string;
  args: Record<string, unknown>;
};

declare const validatedToolCallBrand: unique symbol;

/** A call whose tool name and arguments have crossed the strict validator. */
export type ValidatedToolCall = ToolCall & {
  readonly [validatedToolCallBrand]: true;
};

export type ToolCallParseResult =
  | { valid: true; call: ValidatedToolCall }
  | { valid: false; reason: string };

export type DegradationRung = "constrained" | "unconstrained-repair" | "chat-only";

export type DegradationState =
  | { rung: "constrained" }
  | { rung: "unconstrained-repair"; repairUsed: boolean }
  | { rung: "chat-only" };

export type DegradationEvent =
  | ToolCallParseResult
  | { type: "constraint-unavailable" };

export type DegradationAction =
  | "execute"
  | "retry-unconstrained"
  | "reprompt-repair"
  | "report-chat-only";

export type DegradationDecision =
  | { action: "execute"; call: ValidatedToolCall; state: DegradationState }
  | { action: Exclude<DegradationAction, "execute">; state: DegradationState };

const MAX_OPTIONAL_PROPERTIES = 12;
const MAX_ARRAY_ITEMS = 32;
export const MAX_TOOL_GRAMMAR_BYTES = 96 * 1024;
const FORBIDDEN_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export class ToolGrammarSizeError extends Error {
  readonly code = "TOOL_GRAMMAR_TOO_LARGE";

  constructor(bytes: number) {
    super(`tool grammar is ${bytes} bytes; maximum is ${MAX_TOOL_GRAMMAR_BYTES}`);
    this.name = "ToolGrammarSizeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaType(
  schema: ToolSchema,
): "string" | "number" | "boolean" | "array" | "object" | "enum" {
  if ("type" in schema && schema.type === "object") return "object";
  if ("type" in schema && schema.type !== undefined) return schema.type;
  return "enum";
}

function validateSchema(schema: ToolSchema, path: string): void {
  if (!isRecord(schema)) throw new Error(`${path} must be a schema object`);
  const type = (schema as { type?: unknown }).type;
  if (
    type !== undefined &&
    !["string", "number", "boolean", "array", "object"].includes(String(type))
  ) {
    throw new Error(`${path}: unsupported schema type ${String(type)}`);
  }

  const values = (schema as { enum?: unknown }).enum;
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`${path}.enum must contain at least one value`);
    }
    for (const value of values) {
      if (!(["string", "number", "boolean"] as const).includes(typeof value as never)) {
        throw new Error(`${path}.enum supports only string, number, and boolean values`);
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`${path}.enum numbers must be finite`);
      }
      if (type !== undefined && type !== typeof value) {
        throw new Error(`${path}.enum value ${JSON.stringify(value)} does not match type ${String(type)}`);
      }
    }
  }

  if (type === "array") {
    const arraySchema = schema as ToolArraySchema;
    if (!isRecord(arraySchema.items)) throw new Error(`${path}.items must be a schema object`);
    const min = arraySchema.minItems ?? 0;
    const max = arraySchema.maxItems ?? MAX_ARRAY_ITEMS;
    if (!Number.isInteger(min) || min < 0) throw new Error(`${path}.minItems must be a non-negative integer`);
    if (!Number.isInteger(max) || max < min || max > MAX_ARRAY_ITEMS) {
      throw new Error(`${path}.maxItems must be between minItems and ${MAX_ARRAY_ITEMS}`);
    }
    validateSchema(arraySchema.items, `${path}.items`);
    return;
  }
  if (type !== "object") return;
  const objectSchema = schema as ToolObjectSchema;
  if (!isRecord(objectSchema.properties)) throw new Error(`${path}.properties must be an object`);
  const propertyNames = Object.keys(objectSchema.properties);
  for (const name of propertyNames) {
    if (FORBIDDEN_PROPERTY_NAMES.has(name)) {
      throw new Error(`${path}.properties has forbidden property name ${name}`);
    }
  }
  const required = objectSchema.required ?? [];
  if (new Set(required).size !== required.length) throw new Error(`${path}.required contains duplicates`);
  for (const name of required) {
    if (!Object.hasOwn(objectSchema.properties, name)) {
      throw new Error(`${path}.required names unknown property ${name}`);
    }
  }
  const optionalCount = propertyNames.length - required.length;
  if (optionalCount > MAX_OPTIONAL_PROPERTIES) {
    throw new Error(`${path} has ${optionalCount} optional properties; maximum is ${MAX_OPTIONAL_PROPERTIES}`);
  }
  for (const [name, propertySchema] of Object.entries(objectSchema.properties)) {
    validateSchema(propertySchema, `${path}.properties.${name}`);
  }
}

function validateTools(tools: readonly ToolDefinition[]): void {
  if (tools.length === 0) throw new Error("at least one tool definition is required");
  const names = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (!tool.name) throw new Error(`tool ${index} must have a non-empty name`);
    if (names.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`);
    names.add(tool.name);
    validateSchema(tool.parameters, `tool ${tool.name}.parameters`);
  }
}

// GBNF terminals use JSON-compatible quoted strings. Double-stringifying a
// JSON fragment preserves the quote/backslash bytes the model must emit.
function gbnfLiteral(text: string): string {
  return JSON.stringify(text);
}

function enumExpression(values: readonly ToolScalar[]): string {
  return values.map((value) => gbnfLiteral(JSON.stringify(value))).join(" | ");
}

function optionalSubsets(optionalIndexes: readonly number[]): number[][] {
  const subsets: number[][] = [];
  const count = 2 ** optionalIndexes.length;
  for (let mask = 0; mask < count; mask += 1) {
    subsets.push(optionalIndexes.filter((_, bit) => (mask & (1 << bit)) !== 0));
  }
  return subsets;
}

/**
 * Compile the supported schema subset to llama.cpp GBNF.
 *
 * Supported: nested objects with declared properties, required keys, string,
 * finite number, boolean, and scalar enum values. Objects reject additional
 * properties. To keep the grammar compact and deterministic, object keys are
 * emitted in declaration order and objects may have at most 12 optional keys.
 */
export function compileToolGrammar(tools: readonly ToolDefinition[]): string {
  validateTools(tools);
  const callRules: string[] = [];
  const schemaRules: string[] = [];

  const compileSchema = (schema: ToolSchema, ruleName: string): string => {
    if ("enum" in schema && schema.enum !== undefined) {
      schemaRules.push(`${ruleName} ::= ${enumExpression(schema.enum)}`);
      return ruleName;
    }
    const type = schemaType(schema);
    if (type === "string") return "json-string";
    if (type === "number") return "json-number";
    if (type === "boolean") return "json-boolean";
    if (type === "array") {
      const arraySchema = schema as ToolArraySchema;
      const itemRule = compileSchema(arraySchema.items, `${ruleName}-item`);
      const min = arraySchema.minItems ?? 0;
      const max = arraySchema.maxItems ?? MAX_ARRAY_ITEMS;
      const alternatives: string[] = [];
      for (let length = min; length <= max; length += 1) {
        alternatives.push(
          length === 0
            ? '"[" ws "]"'
            : `"[" ws ${Array.from({ length }, () => `${itemRule} ws`).join('"," ws ')} "]"`,
        );
      }
      schemaRules.push(`${ruleName} ::= ${alternatives.join(" | ")}`);
      return ruleName;
    }
    if (type !== "object") throw new Error(`${ruleName}: enum schema has no values`);

    const objectSchema = schema as ToolObjectSchema;
    const properties = Object.entries(objectSchema.properties);
    const required = new Set(objectSchema.required ?? []);
    const valueRules = properties.map(([_, propertySchema], index) =>
      compileSchema(propertySchema, `${ruleName}-prop-${index}`),
    );
    const optionalIndexes = properties
      .map(([name], index) => (required.has(name) ? -1 : index))
      .filter((index) => index >= 0);
    const alternatives = optionalSubsets(optionalIndexes).map((includedOptional) => {
      const included = new Set(includedOptional);
      const pairs = properties.flatMap(([name], index) => {
        if (!required.has(name) && !included.has(index)) return [];
        return [`${gbnfLiteral(JSON.stringify(name))} ws ":" ws ${valueRules[index]} ws`];
      });
      return pairs.length === 0
        ? '"{" ws "}"'
        : `"{" ws ${pairs.join('"," ws ')} "}"`;
    });
    schemaRules.push(`${ruleName} ::= ${alternatives.join(" | ")}`);
    return ruleName;
  };

  for (const [index, tool] of tools.entries()) {
    const argsRule = compileSchema(tool.parameters, `tool-${index}-args`);
    callRules.push(
      `tool-${index}-call ::= "{" ws ${gbnfLiteral('"tool"')} ws ":" ws ${gbnfLiteral(
        JSON.stringify(tool.name),
      )} ws "," ws ${gbnfLiteral('"args"')} ws ":" ws ${argsRule} ws "}"`,
    );
  }

  const grammar = [
    `root ::= ws (${tools.map((_, index) => `tool-${index}-call`).join(" | ")}) ws`,
    ...callRules,
    ...schemaRules,
    String.raw`json-string ::= "\"" json-char* "\""`,
    String.raw`json-char ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\/bfnrt] | "u" json-hex json-hex json-hex json-hex)`,
    "json-hex ::= [0-9a-fA-F]",
    'json-number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?',
    'json-boolean ::= "true" | "false"',
    String.raw`ws ::= [ \t\n\r]*`,
  ].join("\n");
  const bytes = new TextEncoder().encode(grammar).byteLength;
  if (bytes > MAX_TOOL_GRAMMAR_BYTES) throw new ToolGrammarSizeError(bytes);
  return grammar;
}

function enumIncludes(values: readonly ToolScalar[], value: unknown): boolean {
  return values.some((candidate) => Object.is(candidate, value));
}

function validateValue(schema: ToolSchema, value: unknown, path: string): string | null {
  const type = schemaType(schema);
  if (type === "string" && typeof value !== "string") return `${path} must be a string`;
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    return `${path} must be a finite number`;
  }
  if (type === "boolean" && typeof value !== "boolean") return `${path} must be a boolean`;

  if ("enum" in schema && schema.enum !== undefined && !enumIncludes(schema.enum, value)) {
    return `${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    const arraySchema = schema as ToolArraySchema;
    const min = arraySchema.minItems ?? 0;
    const max = arraySchema.maxItems ?? MAX_ARRAY_ITEMS;
    if (value.length < min) return `${path} must contain at least ${min} item(s)`;
    if (value.length > max) return `${path} must contain at most ${max} item(s)`;
    for (const [index, item] of value.entries()) {
      const reason = validateValue(arraySchema.items, item, `${path}[${index}]`);
      if (reason) return reason;
    }
    return null;
  }
  if (type !== "object") return null;
  if (!isRecord(value)) return `${path} must be an object`;

  const objectSchema = schema as ToolObjectSchema;
  const required = objectSchema.required ?? [];
  for (const name of required) {
    if (!Object.hasOwn(value, name)) return `${path} is missing required property ${name}`;
  }
  for (const name of Object.keys(value)) {
    if (FORBIDDEN_PROPERTY_NAMES.has(name)) return `${path} has forbidden property name ${name}`;
    if (!Object.hasOwn(objectSchema.properties, name)) return `${path} has unknown property ${name}`;
  }
  for (const [name, propertyValue] of Object.entries(value)) {
    const reason = validateValue(objectSchema.properties[name], propertyValue, `${path}.${name}`);
    if (reason) return reason;
  }
  return null;
}

/** Strictly parse and validate a single call. No fences, coercion, or repair. */
export function parseToolCall(output: string, tools: readonly ToolDefinition[]): ToolCallParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown JSON error";
    return { valid: false, reason: `output is not valid JSON: ${message}` };
  }
  if (!isRecord(parsed)) return { valid: false, reason: "output must be one JSON object" };
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("tool") || !keys.includes("args")) {
    return { valid: false, reason: "output object must contain exactly tool and args" };
  }
  if (typeof parsed.tool !== "string") return { valid: false, reason: "tool must be a string" };
  const tool = tools.find((candidate) => candidate.name === parsed.tool);
  if (!tool) return { valid: false, reason: `unknown tool ${parsed.tool}` };
  const reason = validateValue(tool.parameters, parsed.args, "args");
  if (reason) return { valid: false, reason };
  const call = {
    tool: parsed.tool,
    args: parsed.args as Record<string, unknown>,
  } as ValidatedToolCall;
  return { valid: true, call };
}

export function initialDegradationState(rung: "constrained" | "unconstrained-repair"): DegradationState {
  return rung === "constrained"
    ? { rung: "constrained" }
    : { rung: "unconstrained-repair", repairUsed: false };
}

/** Decide the next safe action without ever turning invalid text into a call. */
export function nextDegradationStep(
  state: DegradationState,
  event: DegradationEvent,
): DegradationDecision {
  if (state.rung === "chat-only") return { action: "report-chat-only", state };
  if ("valid" in event && event.valid) return { action: "execute", call: event.call, state };
  if (state.rung === "constrained") {
    return {
      action: "retry-unconstrained",
      state: { rung: "unconstrained-repair", repairUsed: false },
    };
  }
  if (!state.repairUsed) {
    return {
      action: "reprompt-repair",
      state: { rung: "unconstrained-repair", repairUsed: true },
    };
  }
  return { action: "report-chat-only", state: { rung: "chat-only" } };
}
