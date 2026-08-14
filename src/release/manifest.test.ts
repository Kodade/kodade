import { describe, expect, it } from "vitest";
import { releaseManifestFor } from "./manifest";

describe("release manifest", () => {
  it("fails closed for every development-only feature in public builds", () => {
    expect(releaseManifestFor("public").features).toEqual({
      local: false,
      voice: false,
      ssh: false,
      work: false,
    });
  });

  it("keeps the full feature surface in development builds", () => {
    expect(releaseManifestFor("development").features).toEqual({
      local: true,
      voice: true,
      ssh: true,
      work: true,
    });
  });
});
