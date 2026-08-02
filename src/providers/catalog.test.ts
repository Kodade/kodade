// versionToken trims the varied `--version` banners the CLIs print down to a
// short chip label. Parsing lives in TypeScript (Rust returns raw stdout).

import { describe, expect, it } from "vitest";
import { releaseManifestFor } from "../release/manifest";
import { availableProviders, PROVIDERS, versionToken } from "./catalog";

describe("versionToken", () => {
  it("pulls a dotted version out of common banner shapes", () => {
    expect(versionToken("claude 1.2.3")).toBe("1.2.3");
    expect(versionToken("codex-cli 0.9.0 (abc123)")).toBe("0.9.0");
    expect(versionToken("ollama version is 0.4.1")).toBe("0.4.1");
    expect(versionToken("grok 2.0")).toBe("2.0");
    expect(versionToken("v1.10.4-beta.2\n")).toBe("1.10.4-beta.2");
  });

  it("falls back to the first line when there's no dotted number", () => {
    expect(versionToken("dev build\nmore noise")).toBe("dev build");
  });

  it("never returns empty", () => {
    expect(versionToken("   ")).toBe("installed");
  });
});

describe("provider catalog", () => {
  it("has unique ids and bins for the shipping providers", () => {
    const ids = PROVIDERS.map((p) => p.id);
    const bins = PROVIDERS.map((p) => p.bin);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(bins).size).toBe(bins.length);
    expect(ids).toEqual(["claude", "codex", "grok", "opencode", "ollama", "kodade-local"]);
  });

  it("omits KödLocal from the public provider surface", () => {
    expect(
      availableProviders(PROVIDERS, releaseManifestFor("public")).map(
        (provider) => provider.id,
      ),
    ).not.toContain("kodade-local");
  });
});
