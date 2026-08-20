import { describe, expect, it } from "vitest";
import { releaseManifestFor } from "../../release/manifest";
import { availableSettingsSections, settingsSection } from "./registry";

describe("settings sections", () => {
  const publicManifest = releaseManifestFor("public");

  it("is exactly general, providers, ködmem, advanced in every build", () => {
    const ids = ["general", "providers", "memory", "advanced"];
    expect(availableSettingsSections(publicManifest).map((s) => s.id)).toEqual(
      ids,
    );
    expect(
      availableSettingsSections(releaseManifestFor("development")).map(
        (s) => s.id,
      ),
    ).toEqual(ids);
  });

  it("keeps KödMem on the full-bleed layout", () => {
    expect(settingsSection("memory", publicManifest).layout).toBe("full");
  });

  it("resolves every retired section id to its new home", () => {
    const homes = {
      chat: "providers",
      providers: "providers",
      keybindings: "general",
      harness: "advanced",
      local: "advanced",
      voice: "advanced",
      ssh: "advanced",
    } as const;
    for (const [retired, home] of Object.entries(homes)) {
      expect(
        settingsSection(retired as keyof typeof homes, publicManifest).id,
      ).toBe(home);
    }
  });

  it("offers no advanced reset in a public build and one in development", () => {
    const advanced = (manifest: ReturnType<typeof releaseManifestFor>) =>
      settingsSection("advanced", manifest).restoreDefaults;
    expect(advanced(publicManifest)).toBeUndefined();
    expect(advanced(releaseManifestFor("development"))).toBeTypeOf("function");
  });

  it("keeps a reset for general and providers", () => {
    expect(settingsSection("general", publicManifest).restoreDefaults).toBeTypeOf(
      "function",
    );
    expect(
      settingsSection("providers", publicManifest).restoreDefaults,
    ).toBeTypeOf("function");
  });
});
