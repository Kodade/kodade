import { describe, expect, it, vi } from "vitest";
import type { GhOutput, GithubIpc } from "../ipc/contract";
import { createGithubStore } from "./store";

class FakeGithub implements GithubIpc {
  responses = new Map<string, GhOutput | Error>();
  calls: string[][] = [];

  async run(_root: string, args: string[]): Promise<GhOutput> {
    this.calls.push(args);
    const response = this.responses.get(args.slice(0, 2).join(" "));
    if (response instanceof Error) throw response;
    return response ?? { stdout: "[]", stderr: "" };
  }
}

function readyIpc() {
  const ipc = new FakeGithub();
  ipc.responses.set("auth status", { stdout: "github.com ok", stderr: "" });
  ipc.responses.set("repo view", {
    stdout: '{"url":"https://github.com/Kodade/kodade"}',
    stderr: "",
  });
  return ipc;
}

describe("github store", () => {
  it("exposes checking and per-list loading transitions", async () => {
    let releaseAuth!: (output: GhOutput) => void;
    let releaseIssues!: (output: GhOutput) => void;
    let releasePulls!: (output: GhOutput) => void;
    const auth = new Promise<GhOutput>((resolve) => { releaseAuth = resolve; });
    const issues = new Promise<GhOutput>((resolve) => { releaseIssues = resolve; });
    const pulls = new Promise<GhOutput>((resolve) => { releasePulls = resolve; });
    const ipc: GithubIpc = {
      run: (_root, args) => {
        const command = args.slice(0, 2).join(" ");
        if (command === "auth status") return auth;
        if (command === "repo view") {
          return Promise.resolve({ stdout: '{"url":"https://github.com/o/r"}', stderr: "" });
        }
        return command === "issue list" ? issues : pulls;
      },
    };
    const store = createGithubStore(ipc);
    const refresh = store.getState().refresh("/repo");
    expect(store.getState().auth).toBe("checking");

    releaseAuth({ stdout: "ok", stderr: "" });
    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({
        auth: "ok",
        repository: "github",
        issuesLoading: true,
        pullRequestsLoading: true,
      });
    });
    releaseIssues({ stdout: "[]", stderr: "" });
    releasePulls({ stdout: "[]", stderr: "" });
    await refresh;
    expect(store.getState()).toMatchObject({
      issuesLoading: false,
      pullRequestsLoading: false,
    });
  });

  it("transitions through authenticated repository and list success", async () => {
    const ipc = readyIpc();
    ipc.responses.set("issue list", {
      stdout: '[{"number":1,"title":"one","author":{"login":"a"},"labels":[],"updatedAt":"2026-01-01T00:00:00Z"}]',
      stderr: "",
    });
    const store = createGithubStore(ipc);
    await store.getState().refresh("/repo");
    expect(store.getState()).toMatchObject({
      auth: "ok",
      repository: "github",
      repositoryUrl: "https://github.com/Kodade/kodade",
      issuesLoading: false,
      pullRequestsLoading: false,
      issuesError: null,
      pullRequestsError: null,
    });
    expect(store.getState().issues).toHaveLength(1);
    expect(ipc.calls).toContainEqual([
      "issue", "list", "--state", "open", "--limit", "50", "--json",
      "number,title,author,labels,updatedAt",
    ]);
  });

  it("stops at missing and unauthenticated states", async () => {
    for (const [message, expected] of [
      ["gh is not installed: command not found", "missing"],
      ["You are not logged into any GitHub hosts", "unauthenticated"],
    ] as const) {
      const ipc = new FakeGithub();
      ipc.responses.set("auth status", new Error(message));
      const store = createGithubStore(ipc);
      await store.getState().refresh("/repo");
      expect(store.getState().auth).toBe(expected);
      expect(ipc.calls).toHaveLength(1);
    }
  });

  it("treats a missing or non-GitHub remote as a quiet repository state", async () => {
    const ipc = readyIpc();
    ipc.responses.set("repo view", new Error("no remotes found"));
    const store = createGithubStore(ipc);
    await store.getState().refresh("/repo");
    expect(store.getState()).toMatchObject({ auth: "ok", repository: "none" });
    expect(ipc.calls).toHaveLength(2);
  });

  it("surfaces malformed repository JSON as a retryable repository error", async () => {
    const ipc = readyIpc();
    ipc.responses.set("repo view", { stdout: "not json", stderr: "" });
    const store = createGithubStore(ipc);

    await store.getState().refresh("/repo");

    expect(store.getState()).toMatchObject({
      auth: "ok",
      repository: "error",
      repositoryError: "gh returned malformed repository JSON",
    });
    expect(ipc.calls).toHaveLength(2);
  });

  it("surfaces repository CLI failures that are not genuine no-remote states", async () => {
    const ipc = readyIpc();
    ipc.responses.set("repo view", new Error("github api unavailable"));
    const store = createGithubStore(ipc);

    await store.getState().refresh("/repo");

    expect(store.getState()).toMatchObject({
      repository: "error",
      repositoryError: "github api unavailable",
    });
  });

  it("keeps independent list errors and successful list data", async () => {
    const ipc = readyIpc();
    ipc.responses.set("issue list", new Error("issues unavailable"));
    const store = createGithubStore(ipc);
    await store.getState().refresh("/repo");
    expect(store.getState()).toMatchObject({
      issuesError: "issues unavailable",
      pullRequests: [],
      pullRequestsError: null,
      issuesLoading: false,
      pullRequestsLoading: false,
    });
  });
});
