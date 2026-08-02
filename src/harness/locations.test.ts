// M10g: unit coverage for resolveTemplate's platform-conditional `windows`
// override, isolated from any specific CLI adapter. The adapter-level tests
// (adapters.test.ts) prove the real catalog wiring; this proves the
// resolution primitive itself for every base kind and the fallback when a
// Windows-only ScanContext field is unexpectedly absent.

import { describe, expect, it } from "vitest";
import { resolveTemplate } from "./locations";
import type { ScanContext } from "./model";

const MAC: ScanContext = {
  home: "/Users/keith",
  platform: "mac",
  projectRoot: "/Users/keith/proj",
};

const WINDOWS: ScanContext = {
  home: "C:\\Users\\Keith",
  platform: "windows",
  projectRoot: "C:\\Users\\Keith\\proj",
  appDataRoaming: "C:\\Users\\Keith\\AppData\\Roaming",
  appDataLocal: "C:\\Users\\Keith\\AppData\\Local",
};

describe("resolveTemplate", () => {
  it("resolves home/projectRoot bases the same on every platform", () => {
    expect(resolveTemplate({ base: "home", segments: [".claude", "CLAUDE.md"] }, MAC)).toBe(
      "/Users/keith/.claude/CLAUDE.md",
    );
    expect(
      resolveTemplate({ base: "projectRoot", segments: ["CLAUDE.md"] }, WINDOWS),
    ).toBe("C:\\Users\\Keith\\proj\\CLAUDE.md");
  });

  it("a `windows` override is ignored on mac — the default base/segments resolve", () => {
    const template = {
      base: "home" as const,
      segments: [".config", "opencode", "AGENTS.md"],
      windows: { base: "appDataRoaming" as const, segments: ["opencode", "AGENTS.md"] },
    };
    expect(resolveTemplate(template, MAC)).toBe("/Users/keith/.config/opencode/AGENTS.md");
  });

  it("a `windows` override replaces the default entirely on windows", () => {
    const template = {
      base: "home" as const,
      segments: [".config", "opencode", "AGENTS.md"],
      windows: { base: "appDataRoaming" as const, segments: ["opencode", "AGENTS.md"] },
    };
    expect(resolveTemplate(template, WINDOWS)).toBe(
      "C:\\Users\\Keith\\AppData\\Roaming\\opencode\\AGENTS.md",
    );
  });

  it("resolves appDataLocal on windows", () => {
    expect(
      resolveTemplate({ base: "appDataLocal", segments: ["kodade", "cache.json"] }, WINDOWS),
    ).toBe("C:\\Users\\Keith\\AppData\\Local\\kodade\\cache.json");
  });

  it("a template with no `windows` override stays home-relative on windows too", () => {
    // The common case (Claude Code, Codex, Grok): no override means the
    // default base/segments resolve on every platform, unchanged.
    expect(
      resolveTemplate({ base: "home", segments: [".codex", "config.toml"] }, WINDOWS),
    ).toBe("C:\\Users\\Keith\\.codex\\config.toml");
  });

  it("falls back to `home` if an appData field is unexpectedly unset on windows", () => {
    // Defensive fallback: config_env should always populate these on real
    // Windows, but a missing value must degrade to something sane, never
    // produce a broken/undefined path segment.
    const windowsNoAppData: ScanContext = {
      home: "C:\\Users\\Keith",
      platform: "windows",
      projectRoot: "C:\\Users\\Keith\\proj",
    };
    const template = {
      base: "home" as const,
      segments: [".config", "opencode", "AGENTS.md"],
      windows: { base: "appDataRoaming" as const, segments: ["opencode", "AGENTS.md"] },
    };
    expect(resolveTemplate(template, windowsNoAppData)).toBe(
      "C:\\Users\\Keith\\opencode\\AGENTS.md",
    );
  });
});
