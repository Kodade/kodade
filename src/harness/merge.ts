// Format-preserving MCP config merge (M10e) — the heart of the safe-merge path.
// Pure and headless: given a config file's current text plus one server to add,
// it produces the merged text, the exact key touched, and a preview diff, WITHOUT
// re-serializing the whole file. Comments, key ordering, and whitespace of every
// entry KödHarness did not touch survive byte-for-byte. This module is imported
// by the adapter (shared.ts) and, later, by M8's KödMCP client setup — one merge
// engine, not two.
//
// Two format strategies, both non-destructive by construction:
//   • json / jsonc → jsonc-parser's `modify`/`applyEdits`, which returns a
//     minimal, localized text edit (VS Code's own editor engine — handles
//     comments and trailing commas without reformatting the document).
//   • toml → APPEND a freshly-serialized `[key.name]` table to the end of the
//     file. TOML tables may appear in any order, so appending leaves every prior
//     byte untouched (`after` literally starts with `before`).
//
// Whatever the strategy, `mergeMcpServer` re-parses the result and asserts the
// single-key-changed invariant: exactly one server key was added or one
// Ködade-owned entry was updated, every other server is deep-equal, and nothing
// outside the server map changed. A merge that can't prove that — or a source
// file that doesn't parse — throws before any bytes are written.

import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { DiffHunk } from "./contract";

export type McpFormat = "json" | "jsonc" | "toml";
export type McpKeyPath = string | readonly string[];

// The server a user wants to register: a key name plus an opaque config object
// (command/args/env, or type/url for a remote transport). We deliberately don't
// constrain the config shape — different CLIs accept different keys — beyond it
// being a JSON-ish object that each format can serialize.
export type McpServerSpec = {
  name: string;
  config: Record<string, unknown>;
};

// The result of a successful merge. `touchedKey` is the dotted path proved to be
// the ONLY addition or update (e.g. "mcp_servers.bridgememory"); `isNewFile` is
// true when the config file didn't exist yet (so the caller writes with an empty
// optimistic-concurrency hash and knows restore can't roll back to "absent").
export type McpMerge = {
  before: string;
  after: string;
  touchedKey: string;
  diff: DiffHunk[];
  isNewFile: boolean;
  operation: "add" | "update" | "remove";
};

// Build the merge for adding one server to a config file's current text. `before`
// is "" (or whitespace) when the file doesn't exist yet. An existing server is
// only updated when its command path matches the proposed one, or when an exact
// KödBrowser config uses a known obsolete helper location in the same app bundle.
// Other duplicates still refuse.
export function mergeMcpServer(
  before: string,
  format: McpFormat,
  keyPath: McpKeyPath,
  spec: McpServerSpec,
): McpMerge {
  const name = spec.name.trim();
  if (!name) {
    throw new Error("a server name is required");
  }
  const touchedKey = `${displayKeyPath(keyPath)}.${name}`;
  const isNewFile = before.trim().length === 0;
  let operation: McpMerge["operation"] = "add";

  if (!isNewFile) {
    const rootBefore = parseByFormat(before, format);
    // M10g fuzzing found: if `keyPath` already holds a non-object value (a
    // string/number/array — e.g. `mcp_servers = [1,2,3]`), jsonc-parser's
    // `modify` throws a raw, unwrapped internal error ("Can not add index to
    // parent of type array") instead of our friendly refusal, and the TOML
    // append path produces invalid TOML that only fails on re-parse. Catch it
    // here, before either format-specific merge runs, with one clear message.
    assertKeyPathIsObjectOrAbsent(rootBefore, keyPath, format);
    const existing = serverMapOf(rootBefore, keyPath);
    if (Object.prototype.hasOwnProperty.call(existing, name)) {
      if (!isKodadeOwnedServer(name, existing[name], spec.config)) {
        throw new Error(`an MCP server named "${name}" already exists in this config`);
      }
      operation = "update";
    }
  }

  const after = operation === "update"
    ? format === "toml"
      ? updateTomlServer(before, keyPath, name, spec.config)
      : mergeJsonc(before, keyPath, name, spec.config, false)
    : format === "toml"
      ? mergeTomlAppend(before, keyPath, name, spec.config, isNewFile)
      : mergeJsonc(before, keyPath, name, spec.config, isNewFile);

  if (operation === "update") {
    assertSingleServerUpdated(before, after, format, keyPath, name, spec.config);
  } else {
    assertSingleServerAdded(before, after, format, keyPath, name);
  }

  return { before, after, touchedKey, diff: lineDiff(before, after), isNewFile, operation };
}

export function removeMcpServer(
  before: string,
  format: McpFormat,
  keyPath: McpKeyPath,
  spec: McpServerSpec,
): McpMerge {
  const name = spec.name.trim();
  if (!name) throw new Error("a server name is required");
  if (!before.trim()) throw new Error(`the managed MCP server "${name}" is not configured`);
  const parsed = parseByFormat(before, format);
  const existing = serverMapOf(parsed, keyPath)[name];
  if (!deepEqual(existing, spec.config) || !isKodadeOwnedServer(name, existing, spec.config)) {
    throw new Error(`refusing to remove MCP server "${name}": it is not the expected Ködade entry`);
  }
  const after = format === "toml"
    ? removeTomlServer(before, keyPath, name)
    : applyEdits(before, modify(before, [...keySegments(keyPath), name], undefined, {}));
  assertSingleServerRemoved(before, after, format, keyPath, name);
  return {
    before,
    after,
    touchedKey: `${displayKeyPath(keyPath)}.${name}`,
    diff: lineDiff(before, after),
    isNewFile: false,
    operation: "remove",
  };
}

// --- JSON / JSONC ---

function mergeJsonc(
  before: string,
  keyPath: McpKeyPath,
  name: string,
  config: Record<string, unknown>,
  isNewFile: boolean,
): string {
  if (isNewFile) {
    // A brand-new file: build the minimal well-formed document. jsonc-parser's
    // `modify` needs a root object to insert into, so we author the first one.
    const doc = nestByPath(keyPath, name, config);
    return `${JSON.stringify(doc, null, 2)}\n`;
  }
  // No `formattingOptions`: with them, jsonc-parser reflows the WHOLE enclosing
  // object to a canonical shape, which would mangle a hand-tuned neighbor (an
  // inline `{ "command": … }` gets expanded). Omitting them keeps the edit
  // minimal and localized — every existing line stays byte-identical, the new
  // value is inserted compactly. Neighbor fidelity beats a pretty insert.
  const edits = modify(before, [...keySegments(keyPath), name], config, {});
  return applyEdits(before, edits);
}

// --- TOML (append-only) ---

function mergeTomlAppend(
  before: string,
  keyPath: McpKeyPath,
  name: string,
  config: Record<string, unknown>,
  isNewFile: boolean,
): string {
  // Serialize ONLY the new table, then append it. smol-toml renders a nested
  // object as `[key.name]` with its sub-keys — exactly the block we want — and
  // we never restringify the existing document, so prior bytes are untouched.
  let block = stringifyToml(nestByPath(keyPath, name, config)).trimEnd();
  if (isNewFile) {
    return `${block}\n`;
  }
  // Match the existing file's line ending (CRLF configs are common from
  // Windows editors) so the appended hunk doesn't mix EOL styles — smol-toml
  // always serializes with bare "\n".
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  if (eol === "\r\n") block = block.replace(/\n/g, eol);
  // Guarantee exactly one blank line between the prior content and the new table
  // so the append is a clean, self-contained hunk regardless of the file's
  // trailing whitespace.
  const base = before.replace(/\s*$/, "");
  return `${base}${eol}${eol}${block}${eol}`;
}

// TOML has no edit primitive and defining the same table twice is invalid, so a
// proven Ködade-owned entry is replaced as one self-contained table block. The
// generated name is a bare TOML key; anything else is refused rather than
// guessing at quoted-key or inline-table source syntax.
function updateTomlServer(
  before: string,
  keyPath: McpKeyPath,
  name: string,
  config: Record<string, unknown>,
): string {
  const dotted = tomlKeyPath(keyPath);
  const header = `[${dotted}.${name}]`;
  const descendantPrefix = `[${dotted}.${name}.`;
  const lines = before.match(/.*(?:\r\n|\n|$)/g) ?? [];
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length;
  }
  const headerIndex = lines.findIndex((line) => line.replace(/\r?\n$/, "").trim() === header);
  if (headerIndex < 0) {
    throw new Error(
      `refusing to update "${displayKeyPath(keyPath)}.${name}": the existing Ködade server is not a standalone TOML table`,
    );
  }
  const nextTable = lines.findIndex((line, index) => {
    if (index <= headerIndex) return false;
    const trimmed = line.replace(/\r?\n$/, "").trim();
    return trimmed.startsWith("[") && !trimmed.startsWith(descendantPrefix);
  });
  const end = starts[preservedTomlSuffixStart(lines, headerIndex, nextTable)] ?? before.length;
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const block = stringifyToml(nestByPath(keyPath, name, config)).trimEnd().replace(/\n/g, eol);
  return `${before.slice(0, starts[headerIndex])}${block}${eol}${before.slice(end)}`;
}

function removeTomlServer(before: string, keyPath: McpKeyPath, name: string): string {
  const dotted = tomlKeyPath(keyPath);
  const header = `[${dotted}.${name}]`;
  const descendantPrefix = `[${dotted}.${name}.`;
  const lines = before.match(/.*(?:\r\n|\n|$)/g) ?? [];
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length;
  }
  const headerIndex = lines.findIndex((line) => line.replace(/\r?\n$/, "").trim() === header);
  if (headerIndex < 0) throw new Error(`managed MCP server "${name}" is not a standalone TOML table`);
  const nextTable = lines.findIndex((line, index) => {
    if (index <= headerIndex) return false;
    const trimmed = line.replace(/\r?\n$/, "").trim();
    return trimmed.startsWith("[") && !trimmed.startsWith(descendantPrefix);
  });
  const start = starts[headerIndex];
  const end = starts[preservedTomlSuffixStart(lines, headerIndex, nextTable)] ?? before.length;
  const left = before.slice(0, start).replace(/[ \t]*(?:\r?\n)?$/, "");
  const right = before.slice(end).replace(/^(?:\r?\n)?/, "");
  if (!left) return right;
  if (!right) return `${left}${before.includes("\r\n") ? "\r\n" : "\n"}`;
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  return `${left}${eol}${eol}${right}`;
}

// Comments and blank lines immediately before the next table may document that
// neighbor. Keep them byte-for-byte instead of treating them as part of the
// managed server block merely because TOML has no explicit table terminator.
function preservedTomlSuffixStart(
  lines: readonly string[],
  headerIndex: number,
  nextTable: number,
): number {
  let index = nextTable < 0 ? lines.length : nextTable;
  while (index > headerIndex + 1) {
    const trimmed = lines[index - 1].replace(/\r?\n$/, "").trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) break;
    index--;
  }
  return index;
}

// --- The single-key-changed invariant ---

// Re-parse `before` and `after` and prove the merge added exactly `name` to the
// server map and changed nothing else — anywhere in the document. This is the
// gate the plan calls the "single-key-changed invariant": it rejects any
// over-broad diff (a reformatted neighbor, a dropped comment-bearing key, a
// change outside the server map) before the caller writes.
function assertSingleServerAdded(
  before: string,
  after: string,
  format: McpFormat,
  keyPath: McpKeyPath,
  name: string,
): void {
  const rootBefore = before.trim().length === 0 ? {} : parseByFormat(before, format);
  // `after` is our own output, so it "must" parse — except one TOML case: a
  // `keyPath` written as an INLINE table (`mcp_servers = { … }`) is frozen by
  // the TOML spec, so appending a `[mcp_servers.name]` header to extend it is
  // invalid TOML that only fails on this re-parse (found via the M10g fuzz
  // corpus). Re-wrap that failure with a message that names the real cause
  // instead of the confusing raw parser error.
  let rootAfter: unknown;
  try {
    rootAfter = parseByFormat(after, format);
  } catch (error) {
    if (format === "toml") {
      throw new Error(
        `refusing to write: "${displayKeyPath(keyPath)}" is likely defined as an inline TOML table in this file, which cannot be extended with a "[${displayKeyPath(keyPath)}.${name}]" header — edit the file directly to convert it to table headers first (${errText(error)})`,
      );
    }
    throw error;
  }

  const mapBefore = serverMapOf(rootBefore, keyPath);
  const mapAfter = serverMapOf(rootAfter, keyPath);
  const beforeKeys = Object.keys(mapBefore);
  const afterKeys = Object.keys(mapAfter);

  const added = afterKeys.filter((key) => !beforeKeys.includes(key));
  const removed = beforeKeys.filter((key) => !afterKeys.includes(key));
  if (removed.length > 0) {
    throw new Error(`refusing to write: merge would drop existing server(s): ${removed.join(", ")}`);
  }
  if (added.length !== 1 || added[0] !== name) {
    throw new Error(
      `refusing to write: merge touched more than the intended key (added: ${added.join(", ") || "none"})`,
    );
  }
  // Every OTHER server must be deep-equal — no neighbor mangled by the rewrite.
  for (const key of beforeKeys) {
    if (!deepEqual(mapBefore[key], mapAfter[key])) {
      throw new Error(`refusing to write: merge altered the existing server "${key}"`);
    }
  }
  // Nothing OUTSIDE the server map may change (other top-level tables/keys).
  if (!deepEqual(withoutKey(rootBefore, keyPath), withoutKey(rootAfter, keyPath))) {
    throw new Error(`refusing to write: merge changed config outside "${displayKeyPath(keyPath)}"`);
  }
}

function assertSingleServerUpdated(
  before: string,
  after: string,
  format: McpFormat,
  keyPath: McpKeyPath,
  name: string,
  config: Record<string, unknown>,
): void {
  const rootBefore = parseByFormat(before, format);
  const rootAfter = parseByFormat(after, format);
  const mapBefore = serverMapOf(rootBefore, keyPath);
  const mapAfter = serverMapOf(rootAfter, keyPath);
  const beforeKeys = Object.keys(mapBefore);
  const afterKeys = Object.keys(mapAfter);

  if (
    beforeKeys.length !== afterKeys.length ||
    beforeKeys.some((key) => !Object.prototype.hasOwnProperty.call(mapAfter, key))
  ) {
    throw new Error(`refusing to write: update changed the server key set under "${displayKeyPath(keyPath)}"`);
  }
  if (!deepEqual(mapAfter[name], config)) {
    throw new Error(`refusing to write: update did not produce the requested server config for "${name}"`);
  }
  for (const key of beforeKeys) {
    if (key !== name && !deepEqual(mapBefore[key], mapAfter[key])) {
      throw new Error(`refusing to write: update altered the existing server "${key}"`);
    }
  }
  if (!deepEqual(withoutKey(rootBefore, keyPath), withoutKey(rootAfter, keyPath))) {
    throw new Error(`refusing to write: update changed config outside "${displayKeyPath(keyPath)}"`);
  }
}

function assertSingleServerRemoved(
  before: string,
  after: string,
  format: McpFormat,
  keyPath: McpKeyPath,
  name: string,
): void {
  const rootBefore = parseByFormat(before, format);
  const rootAfter = after.trim() ? parseByFormat(after, format) : {};
  const mapBefore = serverMapOf(rootBefore, keyPath);
  const mapAfter = serverMapOf(rootAfter, keyPath);
  if (!Object.prototype.hasOwnProperty.call(mapBefore, name) || Object.prototype.hasOwnProperty.call(mapAfter, name)) {
    throw new Error(`refusing to write: removal did not remove only "${name}"`);
  }
  for (const key of Object.keys(mapBefore)) {
    if (key !== name && !deepEqual(mapBefore[key], mapAfter[key])) {
      throw new Error(`refusing to write: removal altered the existing server "${key}"`);
    }
  }
  if (!deepEqual(withoutKey(rootBefore, keyPath), withoutKey(rootAfter, keyPath))) {
    throw new Error(`refusing to write: removal changed config outside "${displayKeyPath(keyPath)}"`);
  }
}

// --- Parsing helpers (strict: any error throws) ---

// Parse text as the given format, throwing on ANY error. A tolerant parse is the
// wrong tool here — a config we can't fully trust must abort the merge, never be
// silently "repaired". jsonc-parser is fault-tolerant by default, so we collect
// its errors and reject if any were reported.
//
// A leading UTF-8 BOM (common in files Windows tools like PowerShell's
// `Out-File` or Notepad write) is harmless — every mainstream JSON/TOML
// consumer skips it — but both jsonc-parser's strict-error scan and smol-toml's
// parser treat it as an invalid character and would otherwise flag an
// unmodified, perfectly valid config as "corrupt". Stripped here for parsing
// only: `mergeJsonc`/`mergeTomlAppend` still edit/append against the ORIGINAL
// `before` text, so the BOM byte survives untouched in `after`.
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseByFormat(text: string, format: McpFormat): unknown {
  const stripped = stripBom(text);
  if (format === "toml") {
    try {
      return parseToml(stripped);
    } catch (error) {
      throw new Error(`config is not valid TOML: ${errText(error)}`);
    }
  }
  const errors: ParseError[] = [];
  const value = parseJsonc(stripped, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`config is not valid ${format.toUpperCase()} (${errors.length} parse error(s))`);
  }
  return value;
}

// Walk `keyPath` through the parsed document and throw a clear, friendly error
// if any segment along the way is already a non-object value (a string,
// number, boolean, or array). An ABSENT segment is fine — the merge will
// create it — only an EXISTING non-object value is a refusal. Without this
// up-front check, a config like `mcp_servers = [1,2,3]` (valid TOML/JSON on
// its own) would otherwise crash jsonc-parser with a raw internal error, or
// silently build an invalid TOML document that only fails when re-parsed.
function assertKeyPathIsObjectOrAbsent(root: unknown, keyPath: McpKeyPath, format: McpFormat): void {
  let node: unknown = root;
  for (const segment of keySegments(keyPath)) {
    if (node === undefined || node === null) return; // absent — will be created
    if (!isObject(node)) {
      throw new Error(
        `refusing to write: "${displayKeyPath(keyPath)}" is not an object in this ${format.toUpperCase()} config — cannot add a server under it`,
      );
    }
    node = node[segment];
  }
  if (node !== undefined && !isObject(node)) {
    throw new Error(
      `refusing to write: "${displayKeyPath(keyPath)}" is not an object in this ${format.toUpperCase()} config — cannot add a server under it`,
    );
  }
}

// The server map at `keyPath` (dot-separated), or {} when the path is absent or
// isn't an object. Never throws — an absent map just means "no servers yet".
function serverMapOf(root: unknown, keyPath: McpKeyPath): Record<string, unknown> {
  let node: unknown = root;
  for (const segment of keySegments(keyPath)) {
    if (!isObject(node)) return {};
    node = node[segment];
  }
  return isObject(node) ? node : {};
}

// A shallow clone of `root` with the top segment of `keyPath` removed, so the
// "everything outside the server map" comparison ignores the map itself. Only the
// first segment matters for the configs we handle (single-level keys).
function withoutKey(root: unknown, keyPath: McpKeyPath): unknown {
  if (!isObject(root)) return root;
  const segments = keySegments(keyPath);
  const remove = (node: Record<string, unknown>, index: number): Record<string, unknown> => {
    const copy = structuredClone(node);
    const segment = segments[index];
    if (index === segments.length - 1) {
      delete copy[segment];
      return copy;
    }
    const child = copy[segment];
    if (isObject(child)) {
      const cleaned = remove(child, index + 1);
      if (Object.keys(cleaned).length === 0) delete copy[segment];
      else copy[segment] = cleaned;
    }
    return copy;
  };
  return remove(root, 0);
}

// Build a nested object `{ a: { b: value } }` from a dotted `keyPath` plus a
// final `name` segment. Used to author a new file and to serialize a lone TOML
// table for the append.
function nestByPath(keyPath: McpKeyPath, name: string, value: unknown): Record<string, unknown> {
  const segments = [...keySegments(keyPath), name];
  const root: Record<string, unknown> = {};
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next: Record<string, unknown> = {};
    node[segments[i]] = next;
    node = next;
  }
  node[segments[segments.length - 1]] = value;
  return root;
}

function keySegments(keyPath: McpKeyPath): string[] {
  const segments = typeof keyPath === "string" ? keyPath.split(".") : [...keyPath];
  if (segments.length === 0 || segments.some((segment) => !segment)) {
    throw new Error("an MCP key path must contain non-empty segments");
  }
  return segments;
}

function displayKeyPath(keyPath: McpKeyPath): string {
  return keySegments(keyPath).map((segment) => /^[A-Za-z0-9_-]+$/.test(segment) ? segment : "<workspace>").join(".");
}

function tomlKeyPath(keyPath: McpKeyPath): string {
  const segments = keySegments(keyPath);
  if (segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new Error("nested machine-specific TOML MCP paths are not supported");
  }
  return segments.join(".");
}

// --- Small pure utilities ---

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKodadeOwnedServer(
  name: string,
  existing: unknown,
  proposed: Record<string, unknown>,
): boolean {
  const command = (value: unknown): string | null => {
    if (!isObject(value)) return null;
    if (typeof value.command === "string") return value.command;
    return Array.isArray(value.command) && typeof value.command[0] === "string"
      ? value.command[0]
      : null;
  };
  const existingCommand = command(existing);
  const proposedCommand = command(proposed);
  return (
    (name === "kodade-mem" ||
      name.startsWith("kodade-mem-") ||
      name === "kodade-browser" ||
      name === "kodade-local-delegate" ||
      name.startsWith("kodade-local-delegate-")) &&
    existingCommand !== null &&
    proposedCommand !== null &&
    (normalizeKodadeBundlePath(existingCommand) ===
      normalizeKodadeBundlePath(proposedCommand) ||
      (name === "kodade-browser" && isLegacyBrowserHelperMigration(existing, proposed)))
  );
}

const LEGACY_MACOS_BROWSER_HELPER_SUFFIXES = [
  "/Contents/Resources/helpers/kodade-mcp",
  "/Contents/Resources/kodade-local/bin/kodade-mcp",
] as const;
const STABLE_MACOS_BROWSER_HELPER_SUFFIX = "/Contents/MacOS/kodade-mcp";

// A path change is ownership evidence only for the exact shapes Ködade writes
// and only within the same Ködade .app bundle. This heals profile
// switches without turning a same-name user server into a replaceable entry.
function isLegacyBrowserHelperMigration(
  existing: unknown,
  proposed: Record<string, unknown>,
): boolean {
  const existingPath = browserHelperPath(existing);
  const proposedPath = browserHelperPath(proposed);
  if (!existingPath || !proposedPath) return false;
  const stableRoot = browserBundleRoot(proposedPath, STABLE_MACOS_BROWSER_HELPER_SUFFIX);
  if (!stableRoot) return false;
  return LEGACY_MACOS_BROWSER_HELPER_SUFFIXES.some(
    (suffix) => browserBundleRoot(existingPath, suffix) === stableRoot,
  );
}

function browserHelperPath(value: unknown): string | null {
  if (!isObject(value)) return null;
  if (
    typeof value.command === "string" &&
    deepEqual(Object.keys(value).sort(), ["args", "command"]) &&
    deepEqual(value.args, ["browser"])
  ) {
    return value.command;
  }
  if (
    Array.isArray(value.command) &&
    deepEqual(Object.keys(value).sort(), ["command", "enabled", "type"]) &&
    value.type === "local" &&
    value.enabled === true &&
    value.command.length === 2 &&
    typeof value.command[0] === "string" &&
    value.command[1] === "browser"
  ) {
    return value.command[0];
  }
  return null;
}

// Ködade shipped this bundle as "kodade.app" before the macOS app identity
// rename and as "Kodade.app" after it, so an upgraded install proposes the same
// helper under a differently cased bundle name. Only that one known segment is
// case-normalized; every other part of a user-supplied path stays byte-exact,
// so a genuinely different directory or bundle name is still a different path.
const KODADE_BUNDLE_SEGMENT = /\/kodade\.app(?=\/|$)/i;
const KODADE_BUNDLE_NAME = "/Kodade.app";

function normalizeKodadeBundlePath(path: string): string {
  return path.replace(KODADE_BUNDLE_SEGMENT, KODADE_BUNDLE_NAME);
}

function browserBundleRoot(path: string, suffix: string): string | null {
  if (!path.endsWith(suffix)) return null;
  const root = normalizeKodadeBundlePath(path.slice(0, -suffix.length));
  return root.endsWith(KODADE_BUNDLE_NAME) ? root : null;
}

// Structural equality over JSON-ish values (objects, arrays, primitives). Used to
// prove neighbor servers and out-of-map config survived the merge unchanged.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
    );
  }
  return false;
}

// A minimal line-level diff (common-prefix/suffix trim) for the preview surface.
// One hunk capturing the changed middle region — enough to render "N lines added"
// and show the new table, and enough for a test to assert an addition-only edit.
export function lineDiff(before: string, after: string): DiffHunk[] {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  if (removed.length === 0 && added.length === 0) return [];
  return [
    {
      before: removed.join("\n"),
      after: added.join("\n"),
      context: start > 0 ? `after line ${start}` : "at start of file",
    },
  ];
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
