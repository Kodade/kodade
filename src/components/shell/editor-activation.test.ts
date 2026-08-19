// The v2 Editor tab's auto-switch rule, driven against the REAL files store
// (issue #62). A mirror mock would only prove the rule agrees with itself; the
// point here is that every tab action the app actually calls lands on the
// right side of the line.

import { beforeEach, describe, expect, it } from "vitest";
import { MockFiles } from "../../ipc/mock";
import { createFilesStore } from "../../store/files";
import { isEditorOpenIntent, panelFlagsFor } from "./editor-activation";
import type { Tab } from "../../store/tabs";

const github: Tab = { kind: "github" };
const review: Tab = { kind: "review" };

// A store plus the shell's subscription: `switches` counts the times the v2
// shell would have pulled itself onto the Editor tab.
function harness() {
  const files = new MockFiles();
  files.tree.set("/repo", [
    { name: "a.ts", path: "/repo/a.ts", isDir: false },
    { name: "b.ts", path: "/repo/b.ts", isDir: false },
  ]);
  const persisted: Record<string, string[]> = {};
  const store = createFilesStore({
    files,
    onTabsChanged: (root, tabs) => void (persisted[root] = tabs),
  });
  let switches = 0;
  store.subscribe((next, prev) => {
    if (isEditorOpenIntent(next, prev)) switches += 1;
  });
  return {
    files,
    store,
    persisted,
    act: store.getState.bind(store),
    switched: () => switches,
  };
}

describe("Editor auto-switch against the files store", () => {
  let ctx: ReturnType<typeof harness>;
  beforeEach(() => {
    ctx = harness();
  });

  it("switches for the title bar's github and review actions, open or not", async () => {
    await ctx.act().setRoot("/repo");
    expect(ctx.switched()).toBe(0);

    ctx.act().openGithubTab();
    expect(ctx.switched()).toBe(1);
    ctx.act().openReviewTab();
    expect(ctx.switched()).toBe(2);

    // Pressing github again while its tab already exists — and while the files
    // store's active tab does not even change on the second press — is still a
    // request to look at it.
    ctx.act().openGithubTab();
    expect(ctx.switched()).toBe(3);
    ctx.act().openGithubTab();
    expect(ctx.switched()).toBe(4);
    expect(ctx.act().openTabs).toEqual([github, review]);
  });

  it("switches once for the browser tab and never for its navigation", async () => {
    await ctx.act().setRoot("/repo");

    ctx.act().openBrowserTab();
    expect(ctx.switched()).toBe(1);

    // Native navigation and redirects re-write the tab in place. Yanking the
    // user off the Code tab every time a page redirects is the bug.
    ctx.act().setBrowserUrl("https://kodade.com");
    ctx.act().setBrowserUrl("https://kodade.com/docs");
    expect(ctx.switched()).toBe(1);
    expect(ctx.act().activeTab).toEqual({
      kind: "browser",
      url: "https://kodade.com/docs",
    });
  });

  it("switches when a file is opened from the tree", async () => {
    await ctx.act().setRoot("/repo");

    await ctx.act().selectFile("/repo/a.ts");
    expect(ctx.switched()).toBe(1);
    await ctx.act().selectFile("/repo/b.ts");
    expect(ctx.switched()).toBe(2);
    // Re-clicking the file that is already open still counts: the user asked
    // for the editor.
    await ctx.act().selectFile("/repo/b.ts");
    expect(ctx.switched()).toBe(3);
  });

  it("never switches for closing, cycling, or the tab strip", async () => {
    await ctx.act().setRoot("/repo");
    await ctx.act().selectFile("/repo/a.ts");
    await ctx.act().selectFile("/repo/b.ts");
    ctx.act().openGithubTab();
    const before = ctx.switched();

    // Closing the active tab activates a neighbor — Cmd+W must not teleport
    // the user to the Editor tab.
    ctx.act().closeTab(github);
    expect(ctx.act().activeTab).toEqual({ kind: "file", path: "/repo/b.ts" });
    ctx.act().closeTab({ kind: "file", path: "/repo/b.ts" });
    expect(ctx.act().activeTab).toEqual({ kind: "file", path: "/repo/a.ts" });

    // Cycling is a shortcut within whatever tab the user is already on.
    ctx.act().openGithubTab();
    const cycled = ctx.switched();
    ctx.act().cycleTab(1);
    ctx.act().cycleTab(-1);
    expect(cycled).toBe(before + 1);

    // The tab strip lives inside the Editor tab; clicking it can't be a
    // request to go there.
    ctx.act().activateTab({ kind: "file", path: "/repo/a.ts" });
    expect(ctx.switched()).toBe(cycled);
  });

  it("never switches for a project switch or the tab restore that follows", async () => {
    ctx.files.tree.set("/other", [
      { name: "c.ts", path: "/other/c.ts", isDir: false },
    ]);

    // Session one: work in /repo, then leave it.
    await ctx.act().setRoot("/repo");
    await ctx.act().selectFile("/repo/a.ts");
    ctx.act().openGithubTab();
    const saved = ctx.persisted["/repo"];
    expect(saved).toEqual(["/repo/a.ts", "github:"]);

    await ctx.act().setRoot("/other");
    await ctx.act().setRoot("/repo");
    const before = ctx.switched();

    // A restart-style restore onto a fresh store: housekeeping, not a gesture.
    const second = harness();
    await second.act().setRoot("/repo");
    await second.act().restoreTabs("/repo", saved);
    expect(second.act().openTabs).toEqual([
      { kind: "file", path: "/repo/a.ts" },
      github,
    ]);
    expect(second.act().activeTab).toEqual(github);
    expect(second.switched()).toBe(0);

    // Returning to the project and clicking an already-open file IS a gesture.
    await second.act().selectFile("/repo/a.ts");
    expect(second.switched()).toBe(1);

    // The re-root in this store changed nothing either.
    expect(ctx.switched()).toBe(before);
  });
});

describe("panelFlagsFor", () => {
  it("reads the flags off the open tabs", () => {
    expect(panelFlagsFor([])).toEqual({ github: false, review: false });
    expect(panelFlagsFor([{ kind: "file", path: "/a/x.ts" }, review])).toEqual({
      github: false,
      review: true,
    });
    expect(panelFlagsFor([github, review])).toEqual({
      github: true,
      review: true,
    });
  });
});
