import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appStore, filesStore } from "../store/appStore";
import { createReviewStore } from "../store/review";
import { MockGit } from "../ipc/mock";
import type { FsChangedEvent, GhOutput, GithubIpc, Unlisten } from "../ipc/contract";
import { createEntitlements } from "../app/entitlements";
import { ReviewPane } from "./ReviewPane";

// Minimal GithubIpc fake for PR-scope pane tests: scriptable per-argv output.
class FakeGithub implements GithubIpc {
  responses = new Map<string, GhOutput>();
  async run(_root: string, args: string[]): Promise<GhOutput> {
    for (let take = args.length; take >= 1; take--) {
      const hit = this.responses.get(args.slice(0, take).join(" "));
      if (hit) return hit;
    }
    return { stdout: "", stderr: "" };
  }
}

function prDiff(path: string): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,2 @@", " keep", "+add", ""].join("\n");
}

// A no-op fs-watch that satisfies the store's `watch` dep (the pane subscribes
// on mount). Emitting is unnecessary for these render assertions.
class MockWatch {
  onChanged(_h: (e: FsChangedEvent) => void): Promise<Unlisten> {
    return Promise.resolve(() => {});
  }
}

function numstat(rows: [string, string, string][]): string {
  return rows.map(([a, d, p]) => `${a}\t${d}\t${p}\0`).join("");
}

function fileDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,2 @@",
    " keep me",
    "+added here",
    "",
  ].join("\n");
}

// Build a review store over MockGit; scripts the numstat + optional per-file
// diffs. debounceMs 0 keeps any fs refresh cheap.
function storeWith(numstatOut: string, diffs: Record<string, string> = {}) {
  const git = new MockGit();
  git.responses.set("diff --numstat -z", { stdout: numstatOut, stderr: "" });
  for (const [path, out] of Object.entries(diffs)) {
    git.responses.set(`diff --no-color HEAD -- ${path}`, { stdout: out, stderr: "" });
  }
  return { git, store: createReviewStore({ git, watch: new MockWatch(), debounceMs: 0 }) };
}

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

describe("ReviewPane", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    filesStore.setState({ rootPath: "/repo" });
    appStore.setState({
      activeProjectId: "p1",
      projects: [{ id: "p1", name: "kodade", path: "/repo" }],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    filesStore.setState({ rootPath: null });
    appStore.setState({ activeProjectId: null, projects: [], sessions: [] });
  });

  it("prompts to pick a project when none is active", async () => {
    // Null rootPath before clearing the project so appStore's project-switch
    // subscriber (wired outside this test) no-ops instead of driving real IPC.
    filesStore.setState({ rootPath: null });
    appStore.setState({ activeProjectId: null, projects: [] });
    const { store } = storeWith("");
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();
    expect(container!.textContent).toContain("select a project to review its changes");
  });

  it("renders the working-tree summary line and file rows", async () => {
    const { store } = storeWith(numstat([["10", "2", "src/a.ts"], ["3", "0", "docs/README.md"]]));
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();

    expect(container!.textContent).toContain("review · kodade");
    expect(container!.textContent).toContain("2 files · +13 −2");
    expect(container!.textContent).toContain("src/a.ts");
    expect(container!.textContent).toContain("docs/README.md");
  });

  it("shows an honest empty state for a clean working tree", async () => {
    const { store } = storeWith("");
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();
    expect(container!.textContent).toContain("no changes in the working tree");
  });

  it("surfaces a git error inline, not as a crash", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", new Error("not a git repository"));
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0 });
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();

    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("not a git repository");
  });

  it("expands a file row and renders its themed diff", async () => {
    const { store } = storeWith(numstat([["1", "0", "a.txt"]]), { "a.txt": fileDiff("a.txt") });
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();

    const rowButton = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("a.txt"),
    )!;
    act(() => rowButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container!.querySelector(".cm-editor")).not.toBeNull();
    expect(container!.textContent).toContain("added here");
    expect(container!.querySelector('[data-diff="add"]')).not.toBeNull();
  });

  it("renders a binary file as a stat-only row, no editor", async () => {
    const { store } = storeWith(numstat([["-", "-", "img.png"]]));
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();
    expect(container!.textContent).toContain("binary");

    const rowButton = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("img.png"),
    )!;
    act(() => rowButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container!.textContent).toContain("binary file — no diff to show");
    expect(container!.querySelector(".cm-editor")).toBeNull();
  });

  it("toggles the unified/split view mode", async () => {
    const { store } = storeWith(numstat([["1", "0", "a.txt"]]), { "a.txt": fileDiff("a.txt") });
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();

    const rowButton = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("a.txt"),
    )!;
    act(() => rowButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container!.querySelector('[data-diff-view="unified"]')).not.toBeNull();

    const splitButton = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "split",
    )!;
    act(() => splitButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container!.querySelector('[data-diff-view="split"]')).not.toBeNull();
  });

  it("hides the pro lock footer when kodpr.branch is entitled (the stubbed default)", async () => {
    const { store } = storeWith(numstat([["1", "0", "a.txt"]]));
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();
    // Default entitlements stub true → the Pro surface is unlocked, footer gone.
    expect(container!.textContent).not.toContain("are kodade pro");
  });

  it("shows the honest lock footer when kodpr.branch is not entitled", async () => {
    const { store } = storeWith(numstat([["1", "0", "a.txt"]]));
    const free = createEntitlements({ "kodpr.branch": false });
    await act(async () => root?.render(<ReviewPane store={store} entitlements={free} />));
    await flush();

    expect(container!.textContent).toContain(
      "Branch review, risk ranking, PR checks, and send-to-agent are Ködade Pro.",
    );
  });

  it("free tier hides the branch pill and renders a flat (unranked) list", async () => {
    const { store } = storeWith(numstat([["500", "0", "src/git.rs"], ["1", "0", "docs/x.md"]]));
    const free = createEntitlements({ "kodpr.branch": false });
    await act(async () => root?.render(<ReviewPane store={store} entitlements={free} />));
    await flush();

    const pillLabels = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(pillLabels).not.toContain("branch");
    expect(container!.textContent).not.toContain("read first");
    expect(container!.textContent).not.toContain("routine");
  });

  it("Pro shows the branch pill; selecting it resolves the base and shows '<head> vs <base>' in the header", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    git.responses.set("rev-parse --verify origin/main", new Error("unknown revision"));
    git.responses.set("merge-base main HEAD", { stdout: "deadbeef\n", stderr: "" });
    git.responses.set("rev-parse --abbrev-ref HEAD", { stdout: "feature/m12-kodpr\n", stderr: "" });
    git.responses.set(
      "diff --numstat -z deadbeef...HEAD",
      { stdout: numstat([["1", "0", "src/a.ts"]]), stderr: "" },
    );
    const store = createReviewStore({ git, watch: new MockWatch(), debounceMs: 0 });
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();

    const branchPill = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "branch",
    )!;
    expect(branchPill).toBeDefined();
    act(() => branchPill.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container!.textContent).toContain("feature/m12-kodpr vs main");
  });

  it("Pro groups files into read-first/routine/trivial sections with reasons and a ranked summary line", async () => {
    // A security-sensitive path forces "risky"; a lockfile is always "trivial".
    const { store } = storeWith(
      numstat([["20", "0", "src/ipc/allowlist.ts"], ["3", "1", "pnpm-lock.yaml"]]),
    );
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();

    expect(container!.textContent).toContain("read first");
    expect(container!.textContent).toContain("trivial");
    expect(container!.textContent).toContain("security-sensitive path");
    expect(container!.textContent).toContain("lockfile change");
    expect(container!.textContent).toContain("1 risky");
    expect(container!.textContent).toContain("1 trivial");
  });

  it("toggles a file's reviewed checkbox and persists it, and 'mark all read' checks every file", async () => {
    const { store } = storeWith(numstat([["1", "0", "a.ts"], ["1", "0", "b.ts"]]));
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();

    const checkboxes = () => Array.from(container!.querySelectorAll('input[type="checkbox"]'));
    expect(checkboxes()).toHaveLength(2);
    expect(checkboxes().every((c) => (c as HTMLInputElement).checked)).toBe(false);

    act(() => checkboxes()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(store.getState().reviewed).toEqual({ "a.ts": true });

    const markAllButton = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "mark all read",
    )!;
    act(() => markAllButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(store.getState().reviewed).toEqual({ "a.ts": true, "b.ts": true });
    expect(checkboxes().every((c) => (c as HTMLInputElement).checked)).toBe(true);
  });

  // --- M12e: PR scope + comments + send-to-agent ---

  function clickText(label: string) {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
    if (!btn) throw new Error(`no button "${label}"; have: ${JSON.stringify(Array.from(container!.querySelectorAll("button")).map((b) => b.textContent?.trim()))}`);
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  it("Pro shows the PR pill; free (kodpr.pr false) hides it", async () => {
    const { store } = storeWith(numstat([["1", "0", "a.ts"]]));
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();
    const labels = () => Array.from(container!.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(labels()).toContain("pr");

    const noPr = createEntitlements({ "kodpr.pr": false });
    await act(async () => root?.render(<ReviewPane store={store} entitlements={noPr} />));
    await flush();
    expect(labels()).not.toContain("pr");
  });

  it("opening the PR picker loads open PRs; selecting one switches to PR scope and shows its header", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    const gh = new FakeGithub();
    gh.responses.set(
      "pr list",
      { stdout: JSON.stringify([{ number: 7, title: "Widen store", author: { login: "k" }, labels: [], updatedAt: "2026-07-15T00:00:00Z" }]), stderr: "" },
    );
    gh.responses.set("pr diff 7", { stdout: prDiff("src/a.ts"), stderr: "" });
    gh.responses.set("pr view 7", { stdout: JSON.stringify({ number: 7, title: "Widen store", state: "OPEN", url: "https://x", statusCheckRollup: [] }), stderr: "" });
    const store = createReviewStore({ git, github: gh, watch: new MockWatch(), debounceMs: 0 });
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();

    clickText("pr"); // opens the picker + kicks off pr list
    await flush();
    expect(container!.querySelector("[data-pr-picker]")).not.toBeNull();
    expect(container!.textContent).toContain("Widen store");

    const prRow = Array.from(container!.querySelectorAll("[data-pr-picker] button")).find((b) =>
      b.textContent?.includes("Widen store"),
    )!;
    act(() => prRow.dispatchEvent(new MouseEvent("click", { bubbles: true }))); // pick the PR
    await flush();
    expect(store.getState().scope).toEqual({ kind: "pr", number: 7, title: "Widen store" });
    expect(container!.textContent).toContain("#7 · Widen store");
    expect(container!.textContent).toContain("src/a.ts");
  });

  it("renders a per-file comment badge and the send-to-agent control gated by kodpr.pr", async () => {
    appStore.setState({ sessions: [{ id: "s1", projectId: "p1", name: "claude 1" }] });
    const term: { writes: { sessionId: string; data: string }[] } = { writes: [] };
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: numstat([["1", "0", "a.ts"]]), stderr: "" });
    const store = createReviewStore({
      git,
      watch: new MockWatch(),
      debounceMs: 0,
      terminal: { write: (sessionId, data) => (term.writes.push({ sessionId, data }), Promise.resolve()) },
    });
    await act(async () => root?.render(<ReviewPane store={store} />));
    await flush();

    // No comments yet → no send control.
    expect(container!.querySelector("[data-send-to-agent]")).toBeNull();

    act(() => {
      store.getState().addComment({ path: "a.ts", startLine: 1, endLine: 1, body: "fix" });
    });
    await flush();

    // Per-file badge + the send control now render.
    expect(container!.querySelector("[data-comment-count]")?.textContent).toContain("1");
    const send = container!.querySelector("[data-send-to-agent]")!;
    expect(send).not.toBeNull();
    expect(send.textContent).toContain("1 comment");
    expect(send.textContent).toContain("claude 1");

    clickText("send");
    await flush();
    expect(term.writes).toHaveLength(1);
    expect(term.writes[0].sessionId).toBe("s1");
    expect(term.writes[0].data.startsWith("\x1b[200~")).toBe(true);

    // Not entitled → the whole send surface is hidden even with comments present.
    const noPr = createEntitlements({ "kodpr.pr": false });
    await act(async () => root?.render(<ReviewPane store={store} entitlements={noPr} />));
    await flush();
    expect(container!.querySelector("[data-send-to-agent]")).toBeNull();
  });
});
