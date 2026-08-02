import { describe, expect, it } from "vitest";
import { parseRemoteFind } from "./remoteTree";

describe("parseRemoteFind", () => {
  it("builds a nested tree from marker-prefixed find output", () => {
    const stdout = [
      "D:/repo/src",
      "F:/repo/src/app.ts",
      "D:/repo/src/lib",
      "F:/repo/src/lib/util.ts",
      "F:/repo/README.md",
      "L:/repo/link.txt",
    ].join("\n");

    const listing = parseRemoteFind("/repo", stdout, 2000);

    expect(listing.truncated).toBe(false);
    // Dirs first, then alphabetical (case-insensitive: "link" < "README").
    expect(listing.nodes.map((n) => n.name)).toEqual(["src", "link.txt", "README.md"]);
    const src = listing.nodes.find((n) => n.name === "src")!;
    expect(src.type).toBe("dir");
    expect(src.children?.map((c) => c.name)).toEqual(["lib", "app.ts"]);
    const lib = src.children!.find((c) => c.name === "lib")!;
    expect(lib.children?.map((c) => c.name)).toEqual(["util.ts"]);
    // Symlinks are treated as files for tree purposes.
    const link = listing.nodes.find((n) => n.name === "link.txt")!;
    expect(link.type).toBe("file");
  });

  it("drops the root's own listed line", () => {
    const stdout = ["D:/repo", "F:/repo/a.txt"].join("\n");
    const listing = parseRemoteFind("/repo", stdout, 2000);
    expect(listing.nodes.map((n) => n.name)).toEqual(["a.txt"]);
  });

  it("flags truncation when the line count exceeds the entry cap", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `F:/repo/file${i}.txt`);
    const listing = parseRemoteFind("/repo", lines.join("\n"), 3);
    expect(listing.truncated).toBe(true);
    expect(listing.nodes).toHaveLength(3);
  });

  it("does not flag truncation when the line count is exactly at the cap", () => {
    const lines = Array.from({ length: 3 }, (_, i) => `F:/repo/file${i}.txt`);
    const listing = parseRemoteFind("/repo", lines.join("\n"), 3);
    expect(listing.truncated).toBe(false);
  });

  it("drops malformed lines instead of guessing", () => {
    const stdout = [
      "F:/repo/a.txt",
      "garbage line with no marker",
      "X:/repo/unknown-marker.txt", // unrecognized type marker
      "",
    ].join("\n");
    const listing = parseRemoteFind("/repo", stdout, 2000);
    expect(listing.nodes.map((n) => n.name)).toEqual(["a.txt"]);
  });

  it("drops entries outside the probed root (defensive, e.g. a foreign/injected line)", () => {
    const stdout = ["F:/repo/a.txt", "F:/etc/passwd"].join("\n");
    const listing = parseRemoteFind("/repo", stdout, 2000);
    expect(listing.nodes.map((n) => n.name)).toEqual(["a.txt"]);
  });

  it("handles filenames with spaces and quotes (safe once the line survives quoting on the remote)", () => {
    const stdout = ["F:/repo/has space.txt", "F:/repo/quote'd.txt"].join("\n");
    const listing = parseRemoteFind("/repo", stdout, 2000);
    expect(listing.nodes.map((n) => n.name).sort()).toEqual(["has space.txt", "quote'd.txt"]);
  });

  it("known limitation: a literal newline inside a filename corrupts it into a spurious entry, not a crash", () => {
    // find prints "F:/repo/weird\nname.txt" (one file whose name contains a
    // newline) as two separate lines. The first half ("F:/repo/weird")
    // happens to still match the marker+path shape, so it's admitted as a
    // (wrong) entry named "weird"; the second half has no marker and is
    // dropped. This is the documented v1 gap: such a file never appears
    // under its real name, but parsing never throws or drops unrelated
    // entries because of it.
    const stdout = ["F:/repo/weird", "name.txt", "F:/repo/normal.txt"].join("\n");
    const listing = parseRemoteFind("/repo", stdout, 2000);
    expect(listing.nodes.map((n) => n.name).sort()).toEqual(["normal.txt", "weird"]);
  });

  it("handles a target pinned at the filesystem root '/'", () => {
    const stdout = ["D:/", "D:/etc", "F:/etc/hosts", "F:/readme.txt"].join("\n");
    const listing = parseRemoteFind("/", stdout, 2000);

    expect(listing.root).toBe("/");
    expect(listing.nodes.map((n) => n.name)).toEqual(["etc", "readme.txt"]);
    const etc = listing.nodes.find((n) => n.name === "etc")!;
    expect(etc.children?.map((c) => c.name)).toEqual(["hosts"]);
  });

  it("returns an empty tree for an empty directory", () => {
    const listing = parseRemoteFind("/repo", "D:/repo", 2000);
    expect(listing.nodes).toEqual([]);
    expect(listing.truncated).toBe(false);
  });

  it("rejoins `./`-relative entries (the cd && find . probe) to the pinned root", () => {
    const stdout = [
      "D:.",
      "D:./src",
      "F:./src/app.ts",
      "F:./README.md",
    ].join("\n");

    const listing = parseRemoteFind("/repo", stdout, 2000);

    expect(listing.nodes.map((n) => n.name)).toEqual(["src", "README.md"]);
    const src = listing.nodes.find((n) => n.name === "src")!;
    expect(src.path).toBe("/repo/src");
    expect(src.children?.map((c) => c.path)).toEqual(["/repo/src/app.ts"]);
  });

  it("keeps a home-relative `~/…` root working: entries land under the literal tilde path", () => {
    // The regression behind the "empty directory" pane for tilde pins: the
    // probe expands `"$HOME"` remotely, so absolute output can never
    // prefix-match a `~/…` root. Relative rejoining sidesteps the expansion
    // entirely.
    const stdout = ["D:.", "D:./src", "F:./src/app.ts"].join("\n");

    const listing = parseRemoteFind("~/code/repo", stdout, 2000);

    expect(listing.root).toBe("~/code/repo");
    expect(listing.nodes).toHaveLength(1);
    expect(listing.nodes[0].path).toBe("~/code/repo/src");
    expect(listing.nodes[0].children?.map((c) => c.path)).toEqual([
      "~/code/repo/src/app.ts",
    ]);
  });

  it("rejoins relative entries under a root pinned at '/' without doubling the slash", () => {
    const stdout = ["D:.", "F:./readme.txt"].join("\n");
    const listing = parseRemoteFind("/", stdout, 2000);
    expect(listing.nodes.map((n) => n.path)).toEqual(["/readme.txt"]);
  });

  it("sorts directories before files, alphabetically within each group", () => {
    const stdout = ["F:/repo/zeta.txt", "D:/repo/beta", "F:/repo/alpha.txt", "D:/repo/gamma"].join("\n");
    const listing = parseRemoteFind("/repo", stdout, 2000);
    expect(listing.nodes.map((n) => n.name)).toEqual(["beta", "gamma", "alpha.txt", "zeta.txt"]);
  });
});
