// versionToken trims the varied `--version` banners the CLIs print down to a
// short chip label. Parsing lives in TypeScript (Rust returns raw stdout).

import { describe, expect, it } from "vitest";
import { resolveLocations } from "../harness/locations";
import { releaseManifestFor } from "../release/manifest";
import {
  availableProviders,
  loginCommandFor,
  PROVIDERS,
  versionToken,
} from "./catalog";

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

  // Sign-in is reachable from a chat thread, so the command Ködade types has
  // to actually start each CLI's own login flow (issue #63).
  it("knows how every chat provider signs in", () => {
    const command = (id: string) =>
      loginCommandFor(PROVIDERS.find((provider) => provider.id === id)!);
    // Every shipped CLI has a one-purpose sign-in flow, so none of them is
    // dropped into a TUI to hunt for the login screen.
    expect(command("claude")).toBe("claude auth login");
    expect(command("grok")).toBe("grok login");
    expect(command("codex")).toBe("codex login");
    expect(command("opencode")).toBe("opencode auth login");
  });

  it("runs the same sign-in line on a remote host, minus a renamed binary", () => {
    const opencode = PROVIDERS.find((provider) => provider.id === "opencode")!;
    const local = PROVIDERS.find((provider) => provider.id === "kodade-local")!;
    expect(loginCommandFor(opencode, true)).toBe("opencode auth login");
    // KödLocal ships as a differently named remote binary, so the remote
    // launch wins over any local login line.
    expect(loginCommandFor(local, true)).toBe(local.remote?.launch);
  });

  it("omits KödLocal from the public provider surface", () => {
    expect(
      availableProviders(PROVIDERS, releaseManifestFor("public")).map(
        (provider) => provider.id,
      ),
    ).not.toContain("kodade-local");
  });

  it("discovers OpenCode models dynamically instead of shipping a guessed catalog", () => {
    const stream = PROVIDERS.find((provider) => provider.id === "opencode")?.stream;
    expect(stream?.models).toBeUndefined();
    expect(stream?.modelDiscovery).toEqual({ args: ["models"], format: "lines" });
  });

  it("offers Grok 4.6 before the retained Grok 4.5 model", () => {
    const stream = PROVIDERS.find((provider) => provider.id === "grok")?.stream;
    expect(stream?.models).toEqual([
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "grok-4.5", label: "Grok 4.5" },
    ]);
  });

  it("discovers Codex custom agents at user and project scope", () => {
    const codex = PROVIDERS.find((provider) => provider.id === "codex");
    expect(codex?.harness).toBeDefined();

    const context = {
      home: "/Users/keith",
      projectRoot: "/work/acme",
      platform: "mac" as const,
    };

    expect(resolveLocations("codex", codex!.harness!, "global", context)).toContainEqual({
      cli: "codex",
      scope: "global",
      kind: "subagent",
      container: "dir",
      path: "/Users/keith/.codex/agents",
    });
    expect(resolveLocations("codex", codex!.harness!, "project", context)).toContainEqual({
      cli: "codex",
      scope: "project",
      kind: "subagent",
      container: "dir",
      path: "/work/acme/.codex/agents",
    });
  });
});
