import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgentIpc, MockStorage } from "../../ipc/mock";
import { appStore } from "../../store/appStore";
import { createProjectsStore } from "../../store/projects";
import { newTask } from "../../kodwork/model";
import { createKodworkStore, type KodworkState } from "../../kodwork/store";
import { KodworkPane } from "./KodworkPane";

// The module-global app store is shared by every suite in the process; these
// tests select projects and sessions on it, so snapshot and put it back.
let appSnapshot: ReturnType<typeof appStore.getState>;
beforeEach(() => {
  appSnapshot = appStore.getState();
});
afterEach(() => {
  appStore.setState(appSnapshot, true);
});

// Minimal terminal registry: records what a launch actually types into a PTY.
function fakeRegistry() {
  return {
    open: vi.fn(),
    ready: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    write: vi.fn(async (_id: string, _data: string) => undefined),
    sync: vi.fn(),
  };
}

// A real projects store with one project, exactly as the desktop runtime
// builds it (PTYs hang off a chat thread, nothing auto-starts).
async function projectsSetup() {
  const registry = fakeRegistry();
  const store = createProjectsStore({
    storage: new MockStorage(),
    registry,
    autoStartTerminal: false,
    newId: (() => {
      let n = 0;
      return () => `s-${++n}`;
    })(),
  });
  await store.getState().hydrate();
  // Seed the task's own project ("project-1", the id signedOutTask opens the
  // task in) and make it active, so a login terminal hosts in the right place.
  store.setState({
    projects: [{ id: "project-1", name: "repo", path: "/repo" }],
    activeProjectId: "project-1",
  });
  return { store, registry, projectId: "project-1" };
}

// A real KödWork store driven through the real adapters: the only fake is the
// process. Returns a task that failed the way a signed-out CLI fails.
async function signedOutTask(providerId: string, stderr: string) {
  const agent = new MockAgentIpc();
  const store = createKodworkStore({
    agent,
    storage: new MockStorage(),
    memory: {
      resolveWorkspace: async () => null,
      checkpoint: async () => ({ id: "cp-1" }) as never,
    },
    projectRoot: () => "/repo",
    enabled: () => true,
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    now: () => 1_000,
    persistDebounceMs: 0,
  });
  await store.getState().start();
  await store.getState().openTask("t1", "project-1");
  store.getState().setOutcome("t1", "tidy the docs folder");
  store.getState().setProvider("t1", providerId);
  await store.getState().startTask("t1");
  agent.exit(agent.starts.at(-1)!.id, 1, stderr);
  return store;
}

function progressStore() {
  const task = {
    ...newTask("task-1", "project-1", "/repo", "claude", 1),
    outcome: "Prepare the release report",
    title: "Prepare release report",
    state: "done" as const,
    plan: [{ text: "Draft report", status: "completed" as const }],
    tools: [{ id: "tool-1", tool: "Write", detail: "/repo/report.md", ok: true }],
    summary: "Created report.md",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  };
  return createStore(() => ({
    tasks: { [task.id]: task },
    pendingRestore: null,
    loaded: { [task.id]: true },
    start: vi.fn(),
    openTask: vi.fn(),
    setOutcome: vi.fn(),
    setFolder: vi.fn(),
    setProvider: vi.fn(),
    setAccess: vi.fn(),
    startTask: vi.fn(),
    resumeTask: vi.fn(),
    cancelTask: vi.fn(),
    setReviewFeedback: vi.fn(),
    acceptReview: vi.fn(),
    rejectReview: vi.fn(),
    prepareRestore: vi.fn(),
    confirmRestore: vi.fn(),
    cancelRestore: vi.fn(),
    noteHumanChange: vi.fn(),
    respondPermission: vi.fn(),
    steerTask: vi.fn(),
    loadTemplates: vi.fn(),
    applyTemplate: vi.fn(),
    setRecurrence: vi.fn(),
    reconcileSchedules: vi.fn(),
    tickSchedules: vi.fn(),
    removeTask: vi.fn(),
    flush: vi.fn(),
  })) as unknown as StoreApi<KodworkState>;
}

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
});

describe("KodworkPane", () => {
  it("renders task progress, files, summary, and token usage without a chat transcript", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() => mounted?.render(<KodworkPane taskId="task-1" workStore={progressStore()} />));

    expect(host.textContent).toContain("Prepare release report");
    expect(host.textContent).toContain("Draft report");
    expect(host.textContent).toContain("/repo/report.md");
    expect(host.textContent).toContain("Created report.md");
    expect(host.textContent).toContain("30 total");
    expect(host.textContent).not.toContain("You said");
  });

  it("shows an honest missing-task state for a stale tab", () => {
    const store = createStore(() => ({ tasks: {} })) as unknown as StoreApi<KodworkState>;
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() => mounted?.render(<KodworkPane taskId="gone" workStore={store} />));
    expect(host.textContent).toContain("no longer open");
  });

  it("exposes the draft outcome to KödWhisper and shows scheduling cost before enable", () => {
    const store = progressStore();
    const task = store.getState().tasks["task-1"]!;
    store.setState({
      tasks: { "task-1": { ...task, state: "draft" } },
      templates: [],
      templatesLoading: false,
      templatesError: null,
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() => mounted?.render(<KodworkPane taskId="task-1" workStore={store} />));

    expect(host.querySelector('[data-voice-target="kodwork-outcome"]')).not.toBeNull();
    const schedule = host.querySelector<HTMLSelectElement>('[aria-label="Task schedule"] select');
    act(() => {
      schedule!.value = "daily";
      schedule!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("Projected:");
    expect(host.textContent).toContain("900 tokens / 30 days");
  });

  it("renders changed output with risk, feedback, and explicit review actions", () => {
    const store = progressStore();
    const current = store.getState().tasks["task-1"]!;
    store.setState({
      tasks: {
        "task-1": {
          ...current,
          state: "needs-user",
          review: {
            kind: "folder",
            status: "pending",
            feedback: "",
            fingerprint: "abc",
            files: [{
              path: "/repo/report.md",
              relativePath: "report.md",
              change: "modified",
              binary: false,
              humanTouched: true,
              before: "old",
              after: "new",
              bucket: "risky",
              reasons: ["source change"],
            }],
          },
        },
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() => mounted?.render(<KodworkPane taskId="task-1" workStore={store} />));
    expect(host.textContent).toContain("Output review");
    expect(host.textContent).toContain("Changed by you during this task");
    expect(host.textContent).toContain("Reject & continue");
    expect(host.textContent).toContain("Restore output");
    expect(host.querySelector<HTMLButtonElement>('button[title="Continue this task"]')?.disabled).toBe(true);
  });

  // KödWork hits the same signed-out CLI as KödChat, so it offers the same
  // remedy in place instead of sending the user to settings (issue #63). The
  // failure travels the real route: CLI stderr → adapter → engine's auth
  // classifier → kodwork store → this card.
  it.each([
    ["claude", "Invalid API key · Please run /login", "claude auth login"],
    ["codex", "stream error: unauthorized; run `codex login`", "codex login"],
    ["grok", "Error: authentication failed (401)", "grok login"],
    ["opencode", "Error: OpenRouter API key is missing.", "opencode auth login"],
  ])(
    "runs %s's own login command in a real terminal when a task is signed out",
    async (providerId, stderr, command) => {
      const workStore = await signedOutTask(providerId, stderr);
      expect(workStore.getState().tasks.t1).toMatchObject({ needsLogin: true });

      // A selected chat thread is what hosts the login PTY.
      const { store: projectsStore, registry, projectId } = await projectsSetup();
      projectsStore.getState().addChatThread(projectId, providerId);

      const host = document.createElement("div");
      document.body.appendChild(host);
      mounted = createRoot(host);
      act(() =>
        mounted?.render(
          <KodworkPane taskId="t1" workStore={workStore} projectsStore={projectsStore} />,
        ),
      );

      const card = host.querySelector('[data-testid="kodwork-auth-card"]');
      expect(card?.textContent).toContain(stderr);
      const button = [...card!.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.includes("log in"),
      )!;
      expect(button.disabled).toBe(false);

      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());

      expect(registry.write.mock.calls.map(([, data]) => data)).toContain(
        `${command}\r`,
      );
    },
  );

  // Slice 3: the login terminal hosts at project scope, so a task can sign in
  // with no chat thread in the project — the button is enabled and clicking it
  // opens a project-scoped login shell.
  it("opens a project-scoped login terminal when only a task is open", async () => {
    const workStore = await signedOutTask("claude", "Not logged in.");
    const { store: projectsStore, registry, projectId } = await projectsSetup();
    projectsStore.getState().addWorkSession(projectId);
    // No chat threads exist in the project.
    expect(
      projectsStore.getState().sessions.some((s) => s.kind === "chat"),
    ).toBe(false);

    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() =>
      mounted?.render(
        <KodworkPane taskId="t1" workStore={workStore} projectsStore={projectsStore} />,
      ),
    );

    const card = host.querySelector('[data-testid="kodwork-auth-card"]')!;
    const button = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("log in"),
    )!;
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());

    expect(registry.write.mock.calls.map(([, data]) => data)).toContain(
      "claude auth login\r",
    );
  });

  // A login terminal opens in the ACTIVE project, so a task belonging to a
  // different (background) project disables the button with an honest hint
  // instead of signing in against the wrong project.
  it("disables login when the task's project is not the active one", async () => {
    const workStore = await signedOutTask("claude", "Not logged in.");
    const { store: projectsStore, registry } = await projectsSetup();
    // Switch the active project away from the task's project ("project-1").
    projectsStore.setState({
      projects: [
        { id: "project-1", name: "repo", path: "/repo" },
        { id: "other", name: "other", path: "/other" },
      ],
      activeProjectId: "other",
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() =>
      mounted?.render(
        <KodworkPane taskId="t1" workStore={workStore} projectsStore={projectsStore} />,
      ),
    );

    const card = host.querySelector('[data-testid="kodwork-auth-card"]')!;
    const button = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("log in"),
    )!;
    expect(button.disabled).toBe(true);
    const guidance = card.querySelector(`#${button.getAttribute("aria-describedby")}`);
    expect(guidance?.textContent).toContain("Open this task's project");

    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(registry.write).not.toHaveBeenCalled();
  });

  it("keeps an ordinary failure a plain error with no login affordance", async () => {
    const workStore = await signedOutTask("claude", "segmentation fault");
    const { store: projectsStore, projectId } = await projectsSetup();
    projectsStore.getState().addChatThread(projectId, "claude");

    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() =>
      mounted?.render(
        <KodworkPane taskId="t1" workStore={workStore} projectsStore={projectsStore} />,
      ),
    );

    expect(host.querySelector('[data-testid="kodwork-auth-card"]')).toBeNull();
    expect(host.querySelector('[data-testid="kodwork-error"]')?.textContent).toContain(
      "segmentation fault",
    );
  });
});
