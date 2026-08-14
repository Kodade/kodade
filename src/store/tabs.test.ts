import { describe, expect, it } from "vitest";
import { decodeTab, decodeTabs, encodeTab, encodeTabs, type Tab } from "./tabs";

describe("tab encoding", () => {
  it.each<Tab>([
    { kind: "file", path: "/repo/src/app.ts" },
    { kind: "github" },
    { kind: "browser", url: "https://example.com/docs?q=tauri" },
    { kind: "browser", url: "" },
    { kind: "review" },
    { kind: "remote-preview", host: "buildbox", path: "/home/keith/code/myproj/src/app.ts" },
    { kind: "kodwork", taskId: "3f6c1a2e-task" },
  ])("round-trips $kind tabs", (tab) => {
    expect(decodeTab(encodeTab(tab))).toEqual(tab);
  });

  it("uses the reserved remote-preview NUL-joined encoding", () => {
    expect(encodeTab({ kind: "remote-preview", host: "box", path: "/repo/a.ts" })).toBe(
      "remote-preview:box\0/repo/a.ts",
    );
  });

  it("drops a malformed remote tab body instead of guessing", () => {
    expect(decodeTab("remote-files:no-separator")).toBeNull();
    expect(decodeTab("remote-files:box\0")).toBeNull(); // empty path
    expect(decodeTab("remote-files:\0/repo")).toBeNull(); // empty host
    expect(decodeTab("remote-preview:no-separator")).toBeNull();
  });

  it("drops retired remote-files tabs now that the tree lives in the files pane", () => {
    expect(decodeTab("remote-files:box\0/repo")).toBeNull();
    expect(
      decodeTabs([
        "remote-files:box\0/repo",
        "remote-preview:box\0/repo/README.md",
      ]),
    ).toEqual([
      { kind: "remote-preview", host: "box", path: "/repo/README.md" },
    ]);
  });

  it("uses the reserved browser URL encoding", () => {
    expect(encodeTab({ kind: "browser", url: "https://example.com/a#b" })).toBe(
      "browser:https://example.com/a#b",
    );
  });

  it("drops retired persisted harness tabs now that KödHarness lives in settings", () => {
    expect(decodeTab("harness:project")).toBeNull();
    expect(decodeTab("harness:global")).toBeNull();
    expect(decodeTab("harness:workspace")).toBeNull();
  });

  it("uses the reserved bare review encoding", () => {
    expect(encodeTab({ kind: "review" })).toBe("review:");
  });

  it("drops a review encoding with an unexpected scope suffix instead of guessing", () => {
    // The prefix is reserved; scope lives in the review store, not the tab.
    expect(decodeTab("review:worktree")).toBeNull();
  });

  it("keeps one review tab per project", () => {
    expect(decodeTabs(["review:", "review:"])).toEqual([{ kind: "review" }]);
  });

  it("drops retired persisted memory tabs now that KödMem lives in settings", () => {
    expect(decodeTab("memory:ws_abc123")).toBeNull();
    expect(decodeTab("memory:")).toBeNull();
  });

  it("uses the reserved KödWork task encoding and drops a bare prefix", () => {
    expect(encodeTab({ kind: "kodwork", taskId: "task-1" })).toBe("kodwork:task-1");
    // No task id is a corrupt/hand-edited encoding — drop it rather than guess.
    expect(decodeTab("kodwork:")).toBeNull();
  });

  it("keeps one KödWork tab per task", () => {
    expect(decodeTabs(["kodwork:task-1", "kodwork:task-1", "kodwork:task-2"])).toEqual([
      { kind: "kodwork", taskId: "task-1" },
      { kind: "kodwork", taskId: "task-2" },
    ]);
  });

  it("migrates legacy persisted file-path arrays without changing their encoding", () => {
    const legacy = ["/repo/a.ts", "/repo/b.ts"];
    expect(decodeTabs(legacy)).toEqual([
      { kind: "file", path: "/repo/a.ts" },
      { kind: "file", path: "/repo/b.ts" },
    ]);
    expect(encodeTabs(decodeTabs(legacy))).toEqual(legacy);
  });

  it("deduplicates one non-file tab per kind and repeated file paths", () => {
    expect(
      decodeTabs([
        "github:",
        "/repo/a.ts",
        "browser:https://one.example/",
        "github:",
        "/repo/a.ts",
        "browser:https://two.example/",
        "memory:ws_1",
        "memory:ws_1",
      ]),
    ).toEqual([
      { kind: "github" },
      { kind: "file", path: "/repo/a.ts" },
      { kind: "browser", url: "https://one.example/" },
    ]);
  });
});
