import { describe, expect, it } from "vitest";
import { iconCategoryFor } from "./file-icons";

describe("iconCategoryFor", () => {
  it.each([
    ["src/main.ts", "code"],
    ["src/component.tsx", "code"],
    ["Cargo.toml", "config"],
    ["README.md", "markup"],
    ["styles/app.css", "style"],
    ["assets/logo.svg", "image"],
    ["notes.txt", "document"],
    ["pnpm-lock.yaml", "lockfile"],
    ["scripts/build.sh", "shell"],
    ["proposal.pdf", "pdf"],
    ["LICENSE", "document"],
    [".gitignore", "config"],
    [".gitattributes", "config"],
    [".env", "config"],
    [".env.local", "config"],
    [".bashrc", "shell"],
    [".zshrc", "shell"],
    [".zprofile", "shell"],
    ["Dockerfile", "config"],
    ["Makefile", "shell"],
    ["unknown.data", "generic"],
  ] as const)("maps %s to %s", (path, category) => {
    expect(iconCategoryFor(path)).toBe(category);
  });

  it("matches extensions case-insensitively", () => {
    expect(iconCategoryFor("PHOTO.PNG")).toBe("image");
  });
});
