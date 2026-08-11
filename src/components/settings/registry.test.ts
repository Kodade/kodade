import { describe, expect, it } from "vitest";
import { releaseManifestFor } from "../../release/manifest";
import { availableSettingsSections, settingsSection } from "./registry";

describe("public settings surface", () => {
  const publicManifest = releaseManifestFor("public");

  it("omits every development-only settings section", () => {
    expect(
      availableSettingsSections(publicManifest).map((section) => section.id),
    ).not.toEqual(expect.arrayContaining(["local", "voice", "ssh"]));
  });

  it("redirects a development-only deep link to the first public section", () => {
    expect(settingsSection("ssh", publicManifest).id).toBe("general");
  });

  it("keeps the retired providers deep link pointed at KödChat", () => {
    expect(settingsSection("providers", publicManifest).id).toBe("chat");
  });
});
