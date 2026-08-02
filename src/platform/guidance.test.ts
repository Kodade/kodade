import { describe, expect, it } from "vitest";
import {
  githubCliInstallGuidance,
  REVEAL_IN_FILE_MANAGER_LABEL,
} from "./guidance";

describe("platform guidance", () => {
  it("uses a neutral file-manager reveal label", () => {
    expect(REVEAL_IN_FILE_MANAGER_LABEL).toBe("reveal in file manager");
  });

  it("preserves Homebrew guidance on macOS", () => {
    expect(githubCliInstallGuidance(true)).toEqual({
      command: "brew install gh",
      copyTitle: "copy brew install gh",
    });
  });

  it("uses Windows Package Manager guidance on Windows", () => {
    expect(githubCliInstallGuidance(false)).toEqual({
      command: "winget install --id GitHub.cli",
      copyTitle: "copy winget install --id GitHub.cli",
    });
  });
});
