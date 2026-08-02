// Per-CLI/per-OS path templates and their resolution. The catalog (catalog.ts)
// stores the templates as data; this module defines their shape and turns them
// into absolute ArtifactLocations at scan time.
//
// Templates are separator-free by construction: a base ("home" or
// "projectRoot") plus relative segments, joined with nativeJoin so the OS
// separator is correct on macOS and Windows alike. There are no hardcoded
// absolute paths and no "/" vs "\\" assumptions anywhere in the data.

import { nativeJoin } from "../platform/native-path";
import type { HarnessScope, ScanContext } from "./model";
import type { ArtifactLocation } from "./contract";

// A location relative to one of the two runtime bases. Deviation from the plan's
// illustrative string templates: structured base+segments keeps Windows
// separators correct and guarantees zero hardcoded separators in the catalog.
// `appDataRoaming`/`appDataLocal` are Windows-only bases (M10g) — resolved
// against ScanContext's %APPDATA%/%LOCALAPPDATA% fields, for the one
// confirmed case (opencode) where a CLI's Windows global config lives
// outside the home-relative dotfile pattern every other adapter uses.
export type PathBase = "home" | "projectRoot" | "appDataRoaming" | "appDataLocal";

export type PathTemplate = {
  base: PathBase;
  segments: string[]; // relative path components, joined with the OS separator
  // Platform override: when the runtime is Windows and this is set, resolve
  // THIS template instead of the fields above. Lets one catalog entry say
  // "normally under `home`, but Windows actually keeps it under %APPDATA%"
  // without a parallel, easy-to-drift second catalog entry per scope.
  windows?: { base: PathBase; segments: string[] };
};

// An MCP config file (per scope), the format to parse it as, and the key that
// holds the server map (e.g. "mcpServers" in .mcp.json, "mcp_servers" in codex
// config.toml).
export type HarnessMcpLocation = {
  scope: HarnessScope;
  template: PathTemplate;
  format: "json" | "jsonc" | "toml";
  keyPath: string;
};

// The harness data one provider contributes to the catalog. All optional: a CLI
// that has no subagents simply omits `subagents`.
export type HarnessLocations = {
  instruction: {
    global?: PathTemplate | PathTemplate[];
    project?: PathTemplate | PathTemplate[];
  };
  skills?: {
    global?: PathTemplate[];
    project?: PathTemplate[];
    // The preferred physical destination for app-managed installs. Discovery
    // can retain legacy and compatibility paths without installing duplicates.
    install?: { global?: PathTemplate; project?: PathTemplate };
  };
  subagents?: { global?: PathTemplate; project?: PathTemplate };
  mcp?: HarnessMcpLocation[];
};

// Resolve `base` against the scan context. appData bases fall back to `home`
// if the (Windows-only) field is unset — this should never happen on real
// Windows (config_env always reads a value or the OS itself is broken), but a
// silent nonsense path is worse than a degraded-but-sane one.
function baseValue(base: PathBase, ctx: ScanContext): string {
  switch (base) {
    case "home":
      return ctx.home;
    case "projectRoot":
      return ctx.projectRoot;
    case "appDataRoaming":
      return ctx.appDataRoaming ?? ctx.home;
    case "appDataLocal":
      return ctx.appDataLocal ?? ctx.home;
  }
}

// Resolve one template to an absolute path against the scan context. nativeJoin
// folds each segment with the correct OS separator, so a Windows home like
// `C:\Users\Keith` yields `C:\Users\Keith\.claude\skills`. On Windows, a
// template's `windows` override (if present) is resolved INSTEAD of its
// default base/segments — see PathTemplate.
export function resolveTemplate(template: PathTemplate, ctx: ScanContext): string {
  const effective = ctx.platform === "windows" && template.windows ? template.windows : template;
  const base = baseValue(effective.base, ctx);
  return effective.segments.reduce((path, segment) => nativeJoin(path, segment), base);
}

// Turn a provider's harness data into the concrete locations to inspect for one
// scope. A CLI adapter calls this in detect(); scan() then reads each location.
export function resolveLocations(
  cli: string,
  harness: HarnessLocations,
  scope: HarnessScope,
  ctx: ScanContext,
): ArtifactLocation[] {
  const locations: ArtifactLocation[] = [];

  const instruction = harness.instruction[scope];
  const instructions = instruction ? (Array.isArray(instruction) ? instruction : [instruction]) : [];
  for (const template of instructions) {
    locations.push({
      cli,
      scope,
      kind: "instruction",
      container: "file",
      path: resolveTemplate(template, ctx),
      format: "markdown",
    });
  }

  for (const template of harness.skills?.[scope] ?? []) {
    locations.push({
      cli,
      scope,
      kind: "skill",
      container: "dir",
      path: resolveTemplate(template, ctx),
    });
  }

  const subagents = harness.subagents?.[scope];
  if (subagents) {
    locations.push({
      cli,
      scope,
      kind: "subagent",
      container: "dir",
      path: resolveTemplate(subagents, ctx),
    });
  }

  for (const mcp of harness.mcp ?? []) {
    if (mcp.scope !== scope) continue;
    locations.push({
      cli,
      scope,
      kind: "mcp-server",
      container: "file",
      path: resolveTemplate(mcp.template, ctx),
      format: mcp.format,
      mcpKeyPath: mcp.keyPath,
    });
  }

  return locations;
}
