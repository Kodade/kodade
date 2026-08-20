import { describe, expect, it } from "vitest";
import { releaseManifestFor } from "./manifest";

describe("release manifest", () => {
  it("keeps only supported features in public builds", () => {
    expect(releaseManifestFor("public").features).toEqual({
      local: false,
      voice: false,
      ssh: false,
      work: true,
      shell: true, // graduated in v2.0.0 (#65)
      browser: false,
    });
  });

  it("keeps the full feature surface in development builds", () => {
    expect(releaseManifestFor("development").features).toEqual({
      local: true,
      voice: true,
      ssh: true,
      work: true,
      shell: true,
      browser: true,
    });
  });
});
