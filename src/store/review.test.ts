// Headless review-store tests: MockGit fixtures replayed through the real
// parse.ts, exactly the seam the app uses. No Tauri, no React. Assertions pin
// the exact git argv shapes run (MockGit records every call) so the allowlist
// contract with Rust can't drift silently.

import { describe, expect, it, vi } from "vitest";
import { MockGit } from "../ipc/mock";
import type { FsChangedEvent, GhOutput, GitIpc, GitOutput, GithubIpc, Unlisten } from "../ipc/contract";
import { createReviewStore } from "./review";

const ROOT = "/repo";

// In-memory GithubIpc fake for PR scope, mirroring MockGit's shape: scriptable
// per-argv output (longest-prefix match), records every call so tests can pin
// the exact `gh` argv the store runs against the Rust allowlist.
class MockGithub implements GithubIpc {
  responses = new Map<string, GhOutput | Error>();
  calls: string[][] = [];
  private lookup(args: string[]): GhOutput | Error | undefined {
    for (let take = args.length; take >= 1; take--) {
      const hit = this.responses.get(args.slice(0, take).join(" "));
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  run(_root: string, args: string[]): Promise<GhOutput> {
    this.calls.push(args);
    const r = this.lookup(args);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r ?? { stdout: "", stderr: "" });
  }
}

// A terminal-writer recorder for send-to-agent (the store's `terminal` dep).
function makeTerminal() {
  const writes: { sessionId: string; data: string }[] = [];
  return { writes, dep: { write: (sessionId: string, data: string) => (writes.push({ sessionId, data }), Promise.resolve()) } };
}

// A tiny fs-watch mock (FilesIpc.onChanged's shape) that lets a test emit a
// change batch on demand and asserts the store subscribed/unsubscribed.
class MockWatch {
  handlers = new Set<(e: FsChangedEvent) => void>();
  onChanged(handler: (e: FsChangedEvent) => void): Promise<Unlisten> {
    this.handlers.add(handler);
    return Promise.resolve(() => this.handlers.delete(handler));
  }
  emit(paths: string[]) {
    for (const h of this.handlers) h({ paths });
  }
}

// A GitIpc wrapper around MockGit that can hold one specific argv's response
// pending until the test releases it — lets a test race a slow per-file diff
// fetch against a scope switch (the generation-guard regression).
class DelayableGit implements GitIpc {
  inner = new MockGit();
  get calls() {
    return this.inner.calls;
  }
  get responses() {
    return this.inner.responses;
  }
  private delayKey: string | null = null;
  private release: ((out: GitOutput) => void) | null = null;
  delay(key: string) {
    this.delayKey = key;
  }
  resolveDelayed(out: GitOutput) {
    this.release?.(out);
    this.release = null;
  }
  run(root: string, args: string[]): Promise<GitOutput> {
    if (this.delayKey && args.join(" ") === this.delayKey) {
      this.inner.calls.push(args);
      return new Promise((resolve) => {
        this.release = resolve;
      });
    }
    return this.inner.run(root, args);
  }
}

// Build `diff --numstat -z` output: NUL-terminated "adds\tdels\tpath" records.
function numstat(rows: [string, string, string][]): string {
  return rows.map(([a, d, p]) => `${a}\t${d}\t${p}\0`).join("");
}

// A minimal one-file unified diff for `path` with one add line.
function fileDiff(path: string, addLine = "const x = 1;"): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 0000000..1111111 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,2 @@",
    " const y = 2;",
    `+${addLine}`,
    "",
  ].join("\n");
}

function makeStore(git: MockGit, watch = new MockWatch(), opts: { maxDiffBytes?: number; debounceMs?: number } = {}) {
  return createReviewStore({ git, watch, maxDiffBytes: opts.maxDiffBytes, debounceMs: opts.debounceMs ?? 0 });
}

describe("createReviewStore", () => {
  it("keeps the execution checkout selected when no delegated worktree has changes", async () => {
    const git = new MockGit();
    git.responses.set("worktree list --porcelain", { stdout: "worktree /repo\nHEAD a\n\nworktree /repo/delegated\nHEAD b\n", stderr: "" });
    const store = makeStore(git);
    const target = { threadId: "t1", executionRoot: ROOT, baselineSha: "base", branch: "main", sharedCheckout: true, pullRequest: null, selectedWorktreeRoot: null };
    await store.getState().openChatReview(target);
    expect(store.getState().projectRoot).toBe(ROOT);
    expect(store.getState().chatTargetChoices.map((choice) => choice.selectedWorktreeRoot)).toEqual([null, "/repo/delegated"]);
  });

  it("defaults a chat review to its only dirty delegated worktree", async () => {
    const calls: { root: string; args: string[] }[] = [];
    const git: GitIpc = {
      async run(root, args) {
        calls.push({ root, args });
        if (args[0] === "worktree") {
          return { stdout: "worktree /repo\nHEAD a\n\nworktree /repo/delegated\nHEAD b\n", stderr: "" };
        }
        if (args[0] === "status") {
          return { stdout: root === "/repo/delegated" ? "1 M. N... 100644 100644 100644 a b src/edited.ts\0" : "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    };
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0 });

    await store.getState().openChatReview({
      threadId: "t1",
      executionRoot: ROOT,
      baselineSha: "base",
      branch: "main",
      sharedCheckout: true,
      pullRequest: null,
      selectedWorktreeRoot: null,
    });

    expect(store.getState().projectRoot).toBe("/repo/delegated");
    expect(store.getState().chatTarget).toMatchObject({
      selectedWorktreeRoot: "/repo/delegated",
      sharedCheckout: false,
    });
    expect(calls.filter((call) => call.args[0] === "status").map((call) => call.root)).toEqual([
      "/repo",
      "/repo/delegated",
      "/repo/delegated",
    ]);
  });

  it("does not duplicate a persisted selected worktree when reopening Review", async () => {
    const git = new MockGit();
    git.responses.set("worktree list --porcelain", { stdout: "worktree /repo\nHEAD a\n\nworktree /repo/delegated\nHEAD b\n", stderr: "" });
    const store = makeStore(git);
    await store.getState().openChatReview({ threadId: "t1", executionRoot: ROOT, baselineSha: "base", branch: "main", sharedCheckout: false, pullRequest: null, selectedWorktreeRoot: "/repo/delegated" });
    expect(store.getState().chatTargetChoices.map((choice) => choice.selectedWorktreeRoot)).toEqual([]);
  });

  it("does not let delayed worktree discovery replace a newer selected target", async () => {
    const git = new DelayableGit();
    git.delay("worktree list --porcelain");
    const store = createReviewStore({ git, watch: new MockWatch() });
    const first = { threadId: "first", executionRoot: "/first", baselineSha: null, branch: null, sharedCheckout: true, pullRequest: null, selectedWorktreeRoot: null };
    const newer = { threadId: "newer", executionRoot: "/newer", baselineSha: null, branch: null, sharedCheckout: false, pullRequest: null, selectedWorktreeRoot: "/newer/work" };
    const opening = store.getState().openChatReview(first);
    await Promise.resolve();
    await store.getState().selectChatTarget(newer);
    git.resolveDelayed({ stdout: "worktree /first\n", stderr: "" });
    await opening;
    expect(store.getState().chatTarget?.threadId).toBe("newer");
    expect(store.getState().projectRoot).toBe("/newer/work");
  });

  it("does not let delayed chat discovery replace project-wide review", async () => {
    const git = new DelayableGit();
    git.delay("worktree list --porcelain");
    const store = createReviewStore({ git, watch: new MockWatch() });
    const opening = store.getState().openChatReview({ threadId: "t", executionRoot: "/chat", baselineSha: null, branch: null, sharedCheckout: true, pullRequest: null, selectedWorktreeRoot: null });
    await Promise.resolve();
    await store.getState().openWorktree("/project");
    git.resolveDelayed({ stdout: "worktree /chat\n", stderr: "" });
    await opening;
    expect(store.getState().chatTarget).toBeNull();
    expect(store.getState().projectRoot).toBe("/project");
  });

  it("does not let delayed chat discovery replace an explicit branch or PR scope", async () => {
    for (const scope of [{ kind: "branch" as const, base: "main" }, { kind: "pr" as const, number: 7 }]) {
      const git = new DelayableGit();
      git.delay("worktree list --porcelain");
      const store = createReviewStore({ git, watch: new MockWatch() });
      store.setState({ projectRoot: ROOT });
      const opening = store.getState().openChatReview({ threadId: "t", executionRoot: "/chat", baselineSha: null, branch: null, sharedCheckout: true, pullRequest: null, selectedWorktreeRoot: null });
      await Promise.resolve();
      await store.getState().setScope(scope);
      git.resolveDelayed({ stdout: "worktree /chat\n", stderr: "" });
      await opening;
      expect(store.getState().scope).toEqual(scope);
    }
  });

  it("discovers and persists the pull request associated with a chat checkout", async () => {
    const git = new MockGit();
    const github = new MockGithub();
    github.responses.set("pr view --json", {
      stdout: JSON.stringify({
        number: 42,
        title: "Chat work",
        author: { login: "keith" },
        state: "OPEN",
        url: "https://github.com/Kodade/kodade/pull/42",
        statusCheckRollup: [],
      }),
      stderr: "",
    });
    const selected: unknown[] = [];
    const store = createReviewStore({
      git,
      github,
      watch: new MockWatch(),
      onChatTargetSelected: (target) => selected.push(target),
    });
    const target = {
      threadId: "t1",
      executionRoot: ROOT,
      baselineSha: "base",
      branch: "feature/chat",
      sharedCheckout: true,
      pullRequest: null,
      selectedWorktreeRoot: null,
    };

    await store.getState().openChatReview(target);

    expect(store.getState().chatTarget?.pullRequest).toBe(42);
    expect(selected.at(-1)).toMatchObject({ pullRequest: 42 });
    expect(github.calls[0]).toEqual([
      "pr",
      "view",
      "--json",
      "number,title,author,state,url,statusCheckRollup",
    ]);
  });

  it("uses a chat's captured baseline for branch review", async () => {
    const git = new MockGit();
    git.responses.set("merge-base base HEAD", { stdout: "base\n", stderr: "" });
    git.responses.set("rev-parse --abbrev-ref HEAD", { stdout: "feature\n", stderr: "" });
    const store = makeStore(git);
    store.setState({ projectRoot: ROOT, chatTarget: { threadId: "t1", executionRoot: ROOT, baselineSha: "base", branch: "feature", sharedCheckout: true, pullRequest: null, selectedWorktreeRoot: null } });
    await store.getState().setScope({ kind: "branch", base: null });
    expect(store.getState().branchBase).toBe("base");
  });
  it("builds the working-tree file list from numstat and runs exactly one allowlisted shape", async () => {
    const git = new MockGit();
    git.responses.set(
      "diff --numstat -z",
      { stdout: numstat([["10", "2", "src/a.ts"], ["3", "0", "docs/README.md"]]), stderr: "" },
    );
    const store = makeStore(git);

    await store.getState().load(ROOT);
    const state = store.getState();

    expect(state.loading).toBe(false);
    expect(state.loaded).toBe(true);
    expect(state.error).toBeNull();
    expect(state.scope).toEqual({ kind: "worktree" });
    expect(state.files.map((f) => f.path)).toEqual(["src/a.ts", "docs/README.md"]);
    expect(state.totals).toEqual({ files: 2, adds: 13, dels: 2 });
    // The list load runs the plain working-tree numstat and nothing else.
    expect(git.calls).toEqual([["diff", "--numstat", "-z", "HEAD"], ["status", "--porcelain=v2", "-z", "--untracked-files=all"]]);
  });

  it("includes staged and untracked files exactly once", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z HEAD", {
      stdout: numstat([["2", "1", "src/staged.ts"]]),
      stderr: "",
    });
    git.responses.set("status --porcelain=v2 -z --untracked-files=all", {
      stdout: "? src/new.ts\0",
      stderr: "",
    });
    git.responses.set("diff --no-index --no-color -- /dev/null src/new.ts", {
      stdout: fileDiff("src/new.ts", "export const added = true;"),
      stderr: "",
    });
    const store = makeStore(git);

    await store.getState().load(ROOT);

    expect(store.getState().files.map((file) => file.path)).toEqual([
      "src/staged.ts",
      "src/new.ts",
    ]);
    expect(store.getState().totals.files).toBe(2);
  });

  it("drops stale untracked reads after selecting another review target", async () => {
    const git = new DelayableGit();
    git.responses.set("status --porcelain=v2 -z --untracked-files=all", {
      stdout: "? stale.ts\0",
      stderr: "",
    });
    git.delay("diff --no-index --no-color -- /dev/null stale.ts");
    const store = createReviewStore({ git, watch: new MockWatch() });

    const staleLoad = store.getState().load(ROOT);
    await vi.waitFor(() =>
      expect(
        git.calls.some(
          (args) =>
            args.join(" ") ===
            "diff --no-index --no-color -- /dev/null stale.ts",
        ),
      ).toBe(true),
    );
    git.responses.set("status --porcelain=v2 -z --untracked-files=all", {
      stdout: "",
      stderr: "",
    });
    await store.getState().load("/other");
    git.resolveDelayed({ stdout: fileDiff("stale.ts"), stderr: "" });
    await staleLoad;

    expect(store.getState().projectRoot).toBe("/other");
    expect(store.getState().files).toEqual([]);
  });

  it("treats a clean working tree (empty stdout) as zero files, not an error", async () => {
    const git = new MockGit(); // unset key → empty stdout
    const store = makeStore(git);

    await store.getState().load(ROOT);

    expect(store.getState().files).toEqual([]);
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().error).toBeNull();
    expect(store.getState().totals).toEqual({ files: 0, adds: 0, dels: 0 });
  });

  it("surfaces a git failure (missing git / not a repo) as an inline message, never a throw", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", new Error("not a git repository"));
    const store = makeStore(git);

    await expect(store.getState().load(ROOT)).resolves.toBeUndefined();
    expect(store.getState().error).toBe("not a git repository");
    expect(store.getState().loading).toBe(false);
  });

  it("lazily loads a file's diff on first expand via the per-file allowlisted shape", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["10", "2", "src/a.ts"]]), stderr: "" });
    git.responses.set("diff --no-color HEAD -- src/a.ts", { stdout: fileDiff("src/a.ts"), stderr: "" });
    const store = makeStore(git);

    await store.getState().load(ROOT);
    // No per-file diff runs until a row is expanded.
    expect(git.calls).toEqual([["diff", "--numstat", "-z", "HEAD"], ["status", "--porcelain=v2", "-z", "--untracked-files=all"]]);

    await store.getState().toggleFile("src/a.ts");
    const file = store.getState().files.find((f) => f.path === "src/a.ts")!;
    expect(file.expanded).toBe(true);
    expect(file.diffStatus).toBe("loaded");
    expect(file.diff?.hunks[0].lines.some((l) => l.kind === "add")).toBe(true);
    expect(git.calls).toEqual([
      ["diff", "--numstat", "-z", "HEAD"],
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      ["diff", "--no-color", "HEAD", "--", "src/a.ts"],
    ]);

    // Collapsing then re-expanding does not refetch the cached diff.
    await store.getState().toggleFile("src/a.ts");
    expect(store.getState().files[0].expanded).toBe(false);
    await store.getState().toggleFile("src/a.ts");
    expect(git.calls).toHaveLength(3);
  });

  it("renders a binary file as a stat-only row and never runs a per-file diff for it", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["-", "-", "img.png"]]), stderr: "" });
    const store = makeStore(git);

    await store.getState().load(ROOT);
    const bin = store.getState().files[0];
    expect(bin.binary).toBe(true);
    expect(bin.adds).toBeNull();

    await store.getState().toggleFile("img.png");
    expect(store.getState().files[0].diffStatus).toBe("binary");
    // Only the numstat ran — no diff for the binary file.
    expect(git.calls).toEqual([["diff", "--numstat", "-z", "HEAD"], ["status", "--porcelain=v2", "-z", "--untracked-files=all"]]);
  });

  it("flips an oversized per-file diff to a stat-only tooLarge state", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["9000", "0", "big.ts"]]), stderr: "" });
    git.responses.set("diff --no-color HEAD -- big.ts", { stdout: "x".repeat(2000), stderr: "" });
    const store = makeStore(git, new MockWatch(), { maxDiffBytes: 1000 });

    await store.getState().load(ROOT);
    await store.getState().toggleFile("big.ts");
    const file = store.getState().files[0];
    expect(file.diffStatus).toBe("tooLarge");
    expect(file.diff).toBeNull();
    expect(file.diffBytes).toBe(2000);
  });

  it("refresh preserves an expanded row and re-fetches its diff", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["10", "2", "src/a.ts"]]), stderr: "" });
    git.responses.set("diff --no-color -- src/a.ts", { stdout: fileDiff("src/a.ts"), stderr: "" });
    const store = makeStore(git);

    await store.getState().load(ROOT);
    await store.getState().toggleFile("src/a.ts");
    expect(store.getState().files[0].expanded).toBe(true);

    await store.getState().refresh();
    // Row stays open and its diff is reloaded (numstat + per-file both re-run).
    expect(store.getState().files[0].expanded).toBe(true);
    expect(store.getState().files[0].diffStatus).toBe("loaded");
    const numstatCalls = git.calls.filter((c) => c[1] === "--numstat").length;
    expect(numstatCalls).toBe(2);
  });

  it("debounced fs-watch subscription refreshes the current project", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "src/a.ts"]]), stderr: "" });
    const watch = new MockWatch();
    const store = makeStore(git, watch, { debounceMs: 0 });

    await store.getState().load(ROOT);
    const unlisten = await store.getState().watchFsChanges();
    expect(watch.handlers.size).toBe(1);

    watch.emit(["/repo/src/a.ts"]);
    // Let the 0ms debounce timer + the async refresh settle.
    await new Promise((r) => setTimeout(r, 5));
    await Promise.resolve();

    const numstatCalls = git.calls.filter((c) => c[1] === "--numstat").length;
    expect(numstatCalls).toBe(2); // initial load + one debounced refresh

    unlisten();
    expect(watch.handlers.size).toBe(0);
  });

  it("fs-watch does nothing before any project is loaded", async () => {
    const git = new MockGit();
    const watch = new MockWatch();
    const store = makeStore(git, watch, { debounceMs: 0 });

    await store.getState().watchFsChanges();
    watch.emit(["/repo/x"]);
    await new Promise((r) => setTimeout(r, 5));

    expect(git.calls).toEqual([]);
  });

  it("reset clears the file list and project root", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "src/a.ts"]]), stderr: "" });
    const store = makeStore(git);

    await store.getState().load(ROOT);
    expect(store.getState().files).toHaveLength(1);

    store.getState().reset();
    expect(store.getState().files).toEqual([]);
    expect(store.getState().projectRoot).toBeNull();
    expect(store.getState().loaded).toBe(false);
  });

  it("switching projects clears the previous project's rows", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "src/a.ts"]]), stderr: "" });
    const store = makeStore(git);

    await store.getState().load(ROOT);
    expect(store.getState().files).toHaveLength(1);

    await store.getState().load("/other");
    expect(store.getState().projectRoot).toBe("/other");
  });

  it("opens worktree review directly on the requested project, not the prior scoped root", async () => {
    const calls: { root: string; args: string[] }[] = [];
    const git: GitIpc = {
      async run(root, args) {
        calls.push({ root, args });
        return {
          stdout: root === "/current" ? numstat([["4", "1", "current.ts"]]) : "",
          stderr: "",
        };
      },
    };
    const store = createReviewStore({ git, watch: new MockWatch() });
    store.setState({
      scope: { kind: "pr", number: 7 },
      projectRoot: "/prior",
    });

    await store.getState().openWorktree("/current");

    expect(store.getState()).toMatchObject({
      scope: { kind: "worktree" },
      projectRoot: "/current",
      totals: { files: 1, adds: 4, dels: 1 },
    });
    expect(calls).toEqual([
      { root: "/current", args: ["diff", "--numstat", "-z", "HEAD"] },
      { root: "/current", args: ["status", "--porcelain=v2", "-z", "--untracked-files=all"] },
    ]);
  });
});

// A tiny in-memory stand-in for the reviewChecks persistence dep (the real
// one is backed by the projects document, see appStore.ts's wiring).
function makeReviewChecksMock() {
  const saved = new Map<string, string[]>();
  const saveCalls: { projectRoot: string; scopeKey: string; paths: string[] }[] = [];
  return {
    saveCalls,
    dep: {
      load: (projectRoot: string, scopeKey: string) => saved.get(`${projectRoot}::${scopeKey}`) ?? [],
      save: (projectRoot: string, scopeKey: string, paths: string[]) => {
        saved.set(`${projectRoot}::${scopeKey}`, paths);
        saveCalls.push({ projectRoot, scopeKey, paths });
      },
    },
  };
}

describe("createReviewStore — branch scope (M12d)", () => {
  it("resolves an explicit base via verify + merge-base, then runs the ranged numstat/per-file shapes", async () => {
    const git = new MockGit();
    git.responses.set("merge-base main HEAD", { stdout: "deadbeef\n", stderr: "" });
    git.responses.set("rev-parse --abbrev-ref HEAD", { stdout: "feature/x\n", stderr: "" });
    git.responses.set(
      "diff --numstat -z deadbeef...HEAD",
      { stdout: numstat([["10", "2", "src/a.ts"]]), stderr: "" },
    );
    git.responses.set("diff --no-color deadbeef...HEAD -- src/a.ts", { stdout: fileDiff("src/a.ts"), stderr: "" });
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    const store = makeStore(git);
    await store.getState().load(ROOT); // worktree first, like the pane's mount

    await store.getState().setScope({ kind: "branch", base: "main" });
    const state = store.getState();
    expect(state.error).toBeNull();
    expect(state.branchBase).toBe("main");
    expect(state.headBranch).toBe("feature/x");
    expect(state.files.map((f) => f.path)).toEqual(["src/a.ts"]);

    await store.getState().toggleFile("src/a.ts");
    expect(store.getState().files[0].diffStatus).toBe("loaded");

    expect(git.calls.slice(2)).toEqual([
      ["rev-parse", "--verify", "main"],
      ["merge-base", "main", "HEAD"],
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["diff", "--numstat", "-z", "deadbeef...HEAD"],
      ["diff", "--no-color", "deadbeef...HEAD", "--", "src/a.ts"],
    ]);
  });

  it("auto-detects the default branch, trying candidates in order until one verifies", async () => {
    const git = new MockGit();
    // origin/main fails to verify; main succeeds (unset keys default to success).
    git.responses.set("rev-parse --verify origin/main", new Error("unknown revision"));
    git.responses.set("merge-base main HEAD", { stdout: "abc123\n", stderr: "" });
    git.responses.set("rev-parse --abbrev-ref HEAD", { stdout: "feature/y\n", stderr: "" });
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    const store = makeStore(git);
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "branch", base: null });
    const state = store.getState();
    expect(state.error).toBeNull();
    expect(state.branchBase).toBe("main");
    expect(git.calls[2]).toEqual(["rev-parse", "--verify", "origin/main"]);
    expect(git.calls[3]).toEqual(["rev-parse", "--verify", "main"]);
  });

  it("surfaces an inline error when no default-branch candidate verifies", async () => {
    const git = new MockGit();
    for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
      git.responses.set(`rev-parse --verify ${candidate}`, new Error("unknown revision"));
    }
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    const store = makeStore(git);
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "branch", base: null });
    expect(store.getState().error).toMatch(/default branch/);
    expect(store.getState().files).toEqual([]);
  });

  it("surfaces an inline error when an explicit base branch doesn't exist", async () => {
    const git = new MockGit();
    git.responses.set("rev-parse --verify nope", new Error("unknown revision"));
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    const store = makeStore(git);
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "branch", base: "nope" });
    expect(store.getState().error).toMatch(/"nope" not found/);
  });

  it("surfaces a friendly inline error when merge-base fails (unrelated histories), not raw git stderr", async () => {
    const git = new MockGit();
    // The base verifies fine, but merge-base itself rejects (e.g. unrelated
    // histories) — this must not fall through to load()'s generic catch.
    git.responses.set("merge-base main HEAD", new Error("fatal: no merge base"));
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    const store = makeStore(git);
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "branch", base: "main" });
    expect(store.getState().error).toBe('no common ancestor with "main"');
  });

  it("treats a base equal to HEAD (empty range) as a normal empty state, not an error", async () => {
    const git = new MockGit();
    git.responses.set("merge-base main HEAD", { stdout: "sameSha\n", stderr: "" });
    git.responses.set("rev-parse --abbrev-ref HEAD", { stdout: "main\n", stderr: "" });
    // The ranged numstat key is left unset → MockGit's default empty stdout,
    // exactly what git would return for an empty "<sha>...HEAD" range.
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    const store = makeStore(git);
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "branch", base: "main" });
    const state = store.getState();
    expect(state.error).toBeNull();
    expect(state.loaded).toBe(true);
    expect(state.files).toEqual([]);
  });

  it("switching back to worktree scope re-runs the plain (unranged) shapes", async () => {
    const git = new MockGit();
    git.responses.set("merge-base main HEAD", { stdout: "sha1\n", stderr: "" });
    git.responses.set("rev-parse --abbrev-ref HEAD", { stdout: "feature/z\n", stderr: "" });
    git.responses.set("diff --numstat -z sha1...HEAD", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    git.responses.set("diff --numstat -z", { stdout: numstat([["2", "0", "b.ts"]]), stderr: "" });
    const store = makeStore(git);
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "branch", base: "main" });
    expect(store.getState().files.map((f) => f.path)).toEqual(["a.ts"]);

    await store.getState().setScope({ kind: "worktree" });
    const state = store.getState();
    expect(state.branchBase).toBeNull();
    expect(state.headBranch).toBeNull();
    expect(state.files.map((f) => f.path)).toEqual(["b.ts"]);
  });

  it("a slow in-flight per-file diff from a superseded generation never clobbers a newer load's result", async () => {
    const git = new DelayableGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["10", "2", "src/a.ts"]]), stderr: "" });
    git.responses.set("merge-base main HEAD", { stdout: "deadbeef\n", stderr: "" });
    git.responses.set("rev-parse --abbrev-ref HEAD", { stdout: "feature/x\n", stderr: "" });
    git.responses.set(
      "diff --numstat -z deadbeef...HEAD",
      { stdout: numstat([["1", "0", "src/a.ts"]]), stderr: "" },
    );
    git.responses.set(
      "diff --no-color deadbeef...HEAD -- src/a.ts",
      { stdout: fileDiff("src/a.ts", "branch content"), stderr: "" },
    );
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0 });

    await store.getState().load(ROOT);
    // Expand src/a.ts under worktree scope; hold its per-file diff pending.
    git.delay("diff --no-color -- src/a.ts");
    const stalePromise = store.getState().toggleFile("src/a.ts");
    expect(store.getState().files[0].diffStatus).toBe("loading");

    // Scope switch supersedes the in-flight worktree diff's generation; the
    // branch load re-fetches src/a.ts's diff under the new range (not delayed)
    // and resolves before the stale worktree fetch does.
    await store.getState().setScope({ kind: "branch", base: "main" });
    // The re-fetch for the still-expanded row is fire-and-forget (not awaited
    // by load()); let its microtask settle before asserting on it.
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().files[0].diffStatus).toBe("loaded");
    expect(store.getState().files[0].diff?.hunks[0].lines.some((l) => l.content === "branch content")).toBe(true);

    // Now let the stale worktree-scope fetch land — it must be dropped, not
    // overwrite the correct branch-scope diff that already loaded.
    git.resolveDelayed({ stdout: fileDiff("src/a.ts", "stale worktree content"), stderr: "" });
    await stalePromise;
    await Promise.resolve();

    const file = store.getState().files[0];
    expect(file.diffStatus).toBe("loaded");
    expect(file.diff?.hunks[0].lines.some((l) => l.content === "branch content")).toBe(true);
    expect(file.diff?.hunks[0].lines.some((l) => l.content === "stale worktree content")).toBe(false);
  });
});

describe("createReviewStore — reviewed checkmarks (M12d)", () => {
  it("loads a scope's previously-saved reviewed paths on load()", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    const { dep } = makeReviewChecksMock();
    dep.save(ROOT, "worktree", ["a.ts"]);
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0, reviewChecks: dep });

    await store.getState().load(ROOT);
    expect(store.getState().reviewed).toEqual({ "a.ts": true });
  });

  it("toggleReviewed flips one path and persists the scope's full reviewed set", async () => {
    const git = new MockGit();
    git.responses.set(
      "diff --numstat -z",
      { stdout: numstat([["1", "0", "a.ts"], ["1", "0", "b.ts"]]), stderr: "" },
    );
    const { dep, saveCalls } = makeReviewChecksMock();
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0, reviewChecks: dep });

    await store.getState().load(ROOT);
    store.getState().toggleReviewed("a.ts");
    expect(store.getState().reviewed).toEqual({ "a.ts": true });
    expect(saveCalls.at(-1)).toEqual({ projectRoot: ROOT, scopeKey: "worktree", paths: ["a.ts"] });

    store.getState().toggleReviewed("a.ts"); // un-check
    expect(store.getState().reviewed).toEqual({});
    expect(saveCalls.at(-1)).toEqual({ projectRoot: ROOT, scopeKey: "worktree", paths: [] });
  });

  it("markAllRead marks every currently-loaded file and persists the set", async () => {
    const git = new MockGit();
    git.responses.set(
      "diff --numstat -z",
      { stdout: numstat([["1", "0", "a.ts"], ["1", "0", "b.ts"]]), stderr: "" },
    );
    const { dep } = makeReviewChecksMock();
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0, reviewChecks: dep });

    await store.getState().load(ROOT);
    store.getState().markAllRead();
    expect(store.getState().reviewed).toEqual({ "a.ts": true, "b.ts": true });
  });

  it("keys reviewed checkmarks on branch identity (head + base), not just the project", async () => {
    const git = new MockGit();
    git.responses.set("merge-base main HEAD", { stdout: "sha1\n", stderr: "" });
    git.responses.set("rev-parse --abbrev-ref HEAD", { stdout: "feature/x\n", stderr: "" });
    git.responses.set("diff --numstat -z sha1...HEAD", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    const { dep, saveCalls } = makeReviewChecksMock();
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0, reviewChecks: dep });
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "branch", base: "main" });
    store.getState().toggleReviewed("a.ts");
    expect(saveCalls.at(-1)).toEqual({
      projectRoot: ROOT,
      scopeKey: "branch:feature/x:main",
      paths: ["a.ts"],
    });
  });

  it("reset clears the reviewed set", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    const store = makeStore(git);

    await store.getState().load(ROOT);
    store.getState().toggleReviewed("a.ts");
    expect(store.getState().reviewed).toEqual({ "a.ts": true });

    store.getState().reset();
    expect(store.getState().reviewed).toEqual({});
  });
});

// gh pr view --json fixture with a CI rollup, and a plain `pr checks` table.
function prViewJson(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    number: 7,
    title: "Widen the review store",
    author: { login: "contractorkeith" },
    state: "OPEN",
    url: "https://github.com/o/r/pull/7",
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
    ...over,
  });
}
function prChecksText(): string {
  return ["lint\tpass\t12s\thttps://x", "test\tfail\t34s\thttps://y", "build\tpending\t0\thttps://z"].join("\n");
}

describe("createReviewStore — PR scope (M12e)", () => {
  it("loads a PR via `gh pr diff` and eagerly parses every file's diff (no per-file fetch)", async () => {
    const git = new MockGit();
    const gh = new MockGithub();
    gh.responses.set("pr diff 7", { stdout: fileDiff("src/a.ts") + fileDiff("src/b.ts"), stderr: "" });
    gh.responses.set("pr view 7", { stdout: prViewJson(), stderr: "" });
    gh.responses.set("pr checks 7", { stdout: prChecksText(), stderr: "" });
    const store = createReviewStore({ git, github: gh, watch: new MockWatch(), debounceMs: 0 });
    await store.getState().load(ROOT); // worktree mount first
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });

    await store.getState().setScope({ kind: "pr", number: 7, title: "Widen the review store" });
    // allow the best-effort header loads to settle
    await new Promise((r) => setTimeout(r, 0));
    const state = store.getState();

    expect(state.error).toBeNull();
    expect(state.scope).toEqual({ kind: "pr", number: 7, title: "Widen the review store" });
    expect(state.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    // Diffs are present up front (loaded eagerly), so a toggle needs no gh call.
    expect(state.files[0].diffStatus).toBe("loaded");
    expect(state.files[0].diff?.hunks[0].lines.some((l) => l.kind === "add")).toBe(true);

    const callsBefore = gh.calls.length;
    await store.getState().toggleFile("src/a.ts");
    expect(store.getState().files[0].expanded).toBe(true);
    expect(gh.calls.length).toBe(callsBefore); // no extra gh call to expand

    // Exact allowlisted gh argv shapes.
    expect(gh.calls).toContainEqual(["pr", "diff", "7"]);
    expect(gh.calls).toContainEqual([
      "pr", "view", "7", "--json", "number,title,author,state,url,statusCheckRollup",
    ]);
    expect(gh.calls).toContainEqual(["pr", "checks", "7"]);
  });

  it("surfaces the PR header (state) and a checks summary from `pr checks`", async () => {
    const git = new MockGit();
    const gh = new MockGithub();
    gh.responses.set("pr diff 7", { stdout: fileDiff("src/a.ts"), stderr: "" });
    gh.responses.set("pr view 7", { stdout: prViewJson(), stderr: "" });
    gh.responses.set("pr checks 7", { stdout: prChecksText(), stderr: "" });
    const store = createReviewStore({ git, github: gh, watch: new MockWatch(), debounceMs: 0 });
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "pr", number: 7 });
    await new Promise((r) => setTimeout(r, 0));

    expect(store.getState().prView?.state).toBe("OPEN");
    expect(store.getState().prChecks).toEqual({ total: 3, passed: 1, failed: 1, pending: 1 });
  });

  it("falls back to the `pr view` rollup summary when `pr checks` fails (non-zero exit)", async () => {
    const git = new MockGit();
    const gh = new MockGithub();
    gh.responses.set("pr diff 7", { stdout: fileDiff("src/a.ts"), stderr: "" });
    gh.responses.set("pr view 7", { stdout: prViewJson(), stderr: "" });
    gh.responses.set("pr checks 7", new Error("checks failing")); // gh exits 1
    const store = createReviewStore({ git, github: gh, watch: new MockWatch(), debounceMs: 0 });
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "pr", number: 7 });
    await new Promise((r) => setTimeout(r, 0));

    // Rollup: one SUCCESS + one FAILURE.
    expect(store.getState().prChecks).toEqual({ total: 2, passed: 1, failed: 1, pending: 0 });
  });

  it("keys reviewed checkmarks on the PR number", async () => {
    const git = new MockGit();
    const gh = new MockGithub();
    gh.responses.set("pr diff 7", { stdout: fileDiff("src/a.ts"), stderr: "" });
    const { dep, saveCalls } = makeReviewChecksMock();
    const store = createReviewStore({ git, github: gh, watch: new MockWatch(), debounceMs: 0, reviewChecks: dep });
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "pr", number: 7 });
    store.getState().toggleReviewed("src/a.ts");
    expect(saveCalls.at(-1)).toEqual({ projectRoot: ROOT, scopeKey: "pr:7", paths: ["src/a.ts"] });
  });

  it("loadPrList runs the exact allowlisted `pr list` shape and parses the rows", async () => {
    const git = new MockGit();
    const gh = new MockGithub();
    gh.responses.set("pr list", {
      stdout: JSON.stringify([
        { number: 7, title: "Widen", author: { login: "keith" }, labels: [], updatedAt: "2026-07-15T00:00:00Z" },
      ]),
      stderr: "",
    });
    const store = createReviewStore({ git, github: gh, watch: new MockWatch(), debounceMs: 0 });
    await store.getState().load(ROOT);

    await store.getState().loadPrList();
    expect(store.getState().prList).toEqual([
      { number: 7, title: "Widen", author: "keith", labels: [], updatedAt: "2026-07-15T00:00:00Z" },
    ]);
    expect(gh.calls).toContainEqual([
      "pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,author,labels,updatedAt",
    ]);
  });

  it("surfaces a gh failure (missing gh / rate limit) inline via error", async () => {
    const git = new MockGit();
    const gh = new MockGithub();
    gh.responses.set("pr diff 7", new Error("gh: could not connect"));
    const store = createReviewStore({ git, github: gh, watch: new MockWatch(), debounceMs: 0 });
    await store.getState().load(ROOT);

    await store.getState().setScope({ kind: "pr", number: 7 });
    expect(store.getState().error).toBe("gh: could not connect");
  });

  it("a local fs-watch tick does not refresh PR scope (a PR is a remote snapshot)", async () => {
    const git = new MockGit();
    const gh = new MockGithub();
    gh.responses.set("pr diff 7", { stdout: fileDiff("src/a.ts"), stderr: "" });
    const watch = new MockWatch();
    const store = createReviewStore({ git, github: gh, watch, debounceMs: 0 });
    await store.getState().load(ROOT);
    await store.getState().watchFsChanges();
    await store.getState().setScope({ kind: "pr", number: 7 });
    const before = gh.calls.length;

    watch.emit(["/repo/src/a.ts"]);
    await new Promise((r) => setTimeout(r, 5));
    expect(gh.calls.length).toBe(before); // no re-run of `gh pr diff`
  });
});

describe("createReviewStore — comments (M12e)", () => {
  function loadedStore() {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "a.ts"], ["1", "0", "b.ts"]]), stderr: "" });
    return createReviewStore({ git, watch: new MockWatch(), debounceMs: 0 });
  }

  it("adds, edits, and deletes line comments keyed to the current scope", async () => {
    const store = loadedStore();
    await store.getState().load(ROOT);

    const id = store.getState().addComment({ path: "a.ts", startLine: 2, endLine: 2, body: "rename this" });
    store.getState().addComment({ path: "a.ts", startLine: 5, endLine: 5, body: "extract helper" });
    store.getState().addComment({ path: "b.ts", startLine: 1, endLine: 1, body: "typo" });
    expect(store.getState().comments).toHaveLength(3);

    store.getState().updateComment(id, "rename to loadPr");
    expect(store.getState().comments.find((c) => c.id === id)?.body).toBe("rename to loadPr");

    store.getState().deleteComment(id);
    expect(store.getState().comments.map((c) => c.body)).toEqual(["extract helper", "typo"]);

    // Per-file badge counts come straight from the comment list.
    const counts = store.getState().comments.reduce<Record<string, number>>((acc, c) => {
      acc[c.path] = (acc[c.path] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ "a.ts": 1, "b.ts": 1 });
  });

  it("preserves each scope's comments across a scope switch (session-local, per scope)", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    git.responses.set("merge-base main HEAD", { stdout: "sha1\n", stderr: "" });
    git.responses.set("rev-parse --abbrev-ref HEAD", { stdout: "feature/x\n", stderr: "" });
    git.responses.set("diff --numstat -z sha1...HEAD", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0 });
    await store.getState().load(ROOT);

    store.getState().addComment({ path: "a.ts", startLine: 1, endLine: 1, body: "worktree note" });
    await store.getState().setScope({ kind: "branch", base: "main" });
    expect(store.getState().comments).toEqual([]); // branch scope starts empty

    await store.getState().setScope({ kind: "worktree" });
    expect(store.getState().comments.map((c) => c.body)).toEqual(["worktree note"]);
  });
});

describe("createReviewStore — send to agent (M12e)", () => {
  it("compiles comments into a bracketed-paste fix prompt with no trailing newline", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    git.responses.set("diff --no-color -- a.ts", { stdout: fileDiff("a.ts"), stderr: "" });
    const term = makeTerminal();
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0, terminal: term.dep });
    await store.getState().load(ROOT);
    await store.getState().toggleFile("a.ts"); // load the diff so the excerpt is quoted

    store.getState().addComment({ path: "a.ts", startLine: 2, endLine: 2, body: "fix this line" });
    await store.getState().sendToSession("sess-1");

    expect(term.writes).toHaveLength(1);
    const { sessionId, data } = term.writes[0];
    expect(sessionId).toBe("sess-1");
    // Bracketed-paste framing so an agent CLI inserts it typed-but-unsent.
    expect(data.startsWith("\x1b[200~")).toBe(true);
    expect(data.endsWith("\x1b[201~")).toBe(true);
    expect(data.endsWith("\n")).toBe(false); // never auto-submitted
    // The compiled prompt body carries the comment and the addressed file/line.
    expect(data).toContain("fix this line");
    expect(data).toContain("a.ts:2");
  });

  it("rejects when no terminal writer is wired", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0 });
    await store.getState().load(ROOT);
    store.getState().addComment({ path: "a.ts", startLine: 1, endLine: 1, body: "x" });

    await expect(store.getState().sendToSession("sess-1")).rejects.toThrow(/no terminal/);
  });

  it("sanitizes control characters from an untrusted diff so a paste-end sequence can't break out of the frame", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    // Hostile hunk content: an interior paste-end escape plus a CR, as if a PR
    // author crafted a diff line to close the bracketed-paste frame early and
    // have the remainder land as live keystrokes.
    git.responses.set("diff --no-color -- a.ts", {
      stdout: fileDiff("a.ts", "\x1b[201~\rrm -rf ~\r"),
      stderr: "",
    });
    const term = makeTerminal();
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0, terminal: term.dep });
    await store.getState().load(ROOT);
    await store.getState().toggleFile("a.ts");

    store.getState().addComment({ path: "a.ts", startLine: 2, endLine: 2, body: "fix this" });
    await store.getState().sendToSession("sess-1");

    const { data } = term.writes[0];
    // Exactly one paste-end sequence — the frame's own closer — and no others.
    expect(data.split("\x1b[201~")).toHaveLength(2);
    expect(data).not.toContain("\r");
    // No stray ESC survives outside the two frame sequences.
    const escCount = (data.match(/\x1b/g) ?? []).length;
    expect(escCount).toBe(2); // PASTE_START + PASTE_END only
  });
});
