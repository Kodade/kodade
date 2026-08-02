// Pure tab-label tests (v1.1): basename display + parent-dir disambiguation.

import { describe, expect, it } from "vitest";
import { REVIEW_TAB_LABEL, tabLabels } from "./tab-labels";

describe("tabLabels", () => {
  it("uses the bare basename when it's unique", () => {
    const labels = tabLabels(["/repo/src/index.ts", "/repo/README.md"]);
    expect(labels["/repo/src/index.ts"]).toBe("index.ts");
    expect(labels["/repo/README.md"]).toBe("README.md");
  });

  it("disambiguates two files sharing a basename with the parent dir", () => {
    const labels = tabLabels(["/repo/src/index.ts", "/repo/test/index.ts"]);
    expect(labels["/repo/src/index.ts"]).toBe("index.ts — src");
    expect(labels["/repo/test/index.ts"]).toBe("index.ts — test");
  });

  it("only disambiguates the colliding basenames, not the rest", () => {
    const labels = tabLabels([
      "/repo/a/index.ts",
      "/repo/b/index.ts",
      "/repo/main.rs",
    ]);
    expect(labels["/repo/a/index.ts"]).toBe("index.ts — a");
    expect(labels["/repo/b/index.ts"]).toBe("index.ts — b");
    expect(labels["/repo/main.rs"]).toBe("main.rs"); // unique — no suffix
  });

  it("falls back to the bare basename when there's no parent to show", () => {
    // A top-level file has no parent directory to disambiguate with.
    const labels = tabLabels(["/a.ts", "/sub/a.ts"]);
    expect(labels["/a.ts"]).toBe("a.ts");
    expect(labels["/sub/a.ts"]).toBe("a.ts — sub");
  });

  it("is empty for no tabs", () => {
    expect(tabLabels([])).toEqual({});
  });

  it("labels the review tab with its stable fixed-kind label", () => {
    expect(REVIEW_TAB_LABEL).toBe("review");
  });

  it("labels and disambiguates Windows drive and UNC paths", () => {
    const drive = "C:\\work\\src\\index.ts";
    const unc = "\\\\server\\share\\test\\index.ts";
    const labels = tabLabels([drive, unc]);
    expect(labels[drive]).toBe("index.ts — src");
    expect(labels[unc]).toBe("index.ts — test");
  });
});
