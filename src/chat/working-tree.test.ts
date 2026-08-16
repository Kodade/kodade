import { describe, expect, it } from "vitest";
import type { GitIpc, GitOutput } from "../ipc/contract";
import { createWorkingTreeSummaryStore } from "./working-tree";

class RootAwareGit implements GitIpc {
  readonly calls: { root: string; args: string[] }[] = [];
  readonly responses = new Map<string, GitOutput | Error>();

  async run(root: string, args: string[]): Promise<GitOutput> {
    this.calls.push({ root, args });
    const response = this.responses.get(root) ?? { stdout: "", stderr: "" };
    if (response instanceof Error) throw response;
    return response;
  }
}

describe("working-tree summary store", () => {
  it("replaces a prior project's summary before loading the requested root", async () => {
    const git = new RootAwareGit();
    git.responses.set("/repos/other", { stdout: "99\t0\told.ts\0", stderr: "" });
    git.responses.set("/repos/alpha", {
      stdout: ["3\t1\tsrc/a.ts", "2\t0\tsrc/b.ts", ""].join("\0"),
      stderr: "",
    });
    const store = createWorkingTreeSummaryStore(git);

    await store.getState().load("/repos/other");
    expect(store.getState().summary).toEqual({ files: 1, adds: 99, dels: 0 });

    const loading = store.getState().load("/repos/alpha");
    expect(store.getState()).toMatchObject({
      projectRoot: "/repos/alpha",
      loading: true,
      summary: null,
    });
    await loading;

    expect(store.getState().summary).toEqual({ files: 2, adds: 5, dels: 1 });
    expect(git.calls.map((call) => call.root)).toEqual(["/repos/other", "/repos/other", "/repos/alpha", "/repos/alpha"]);
  });

  it("clears a prior summary when the current root is not a git repository", async () => {
    const git = new RootAwareGit();
    git.responses.set("/repos/alpha", { stdout: "1\t0\ta.ts\0", stderr: "" });
    const store = createWorkingTreeSummaryStore(git);
    await store.getState().load("/repos/alpha");

    git.responses.set("/repos/alpha", new Error("not a git repository"));
    await store.getState().load("/repos/alpha");

    expect(store.getState()).toMatchObject({
      projectRoot: "/repos/alpha",
      loading: false,
      summary: null,
      error: "not a git repository",
    });
  });
});
