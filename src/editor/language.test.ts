import { describe, expect, it } from "vitest";
import { viewerKind } from "./language";

describe("viewerKind", () => {
  it("routes supported image extensions to the image viewer", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg"]) {
      expect(viewerKind(`/repo/diagram.${ext}`)).toBe("image");
    }
  });

  it("routes PDFs to the document viewer", () => {
    expect(viewerKind("/repo/spec.PDF")).toBe("pdf");
    expect(viewerKind("C:\\work\\spec.PDF")).toBe("pdf");
  });

  it("leaves text and unknown binary files on their existing paths", () => {
    expect(viewerKind("/repo/main.ts")).toBeNull();
    expect(viewerKind("/repo/archive.zip")).toBeNull();
  });
});
