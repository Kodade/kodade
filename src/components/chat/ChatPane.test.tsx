// ChatPane render + composer behaviour, driven by real (mock-backed) stores.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgentIpc, MockStorage } from "../../ipc/mock";
import { createChatStore, providerModelKey } from "../../chat/store";
import { createActivityModule } from "../../activity/activity";
import { createProjectsStore, isChatSession } from "../../store/projects";
import { createProvidersStore } from "../../providers/store";
import { filesStore } from "../../store/appStore";
import { createReviewStore } from "../../store/review";
import { MockGit } from "../../ipc/mock";
import { createWorkingTreeSummaryStore } from "../../chat/working-tree";
import { projectWorkspaceView } from "../ProjectsSidebar";
import { ChatPane } from "./ChatPane";
import { remoteProjectId, remoteTargetForProjectId } from "../../ssh/model";

function fakeRegistry() {
  const hosts = new Map<string, HTMLElement>();
  const write = vi.fn(async (_id: string, _data: string) => undefined);
  return {
    open: vi.fn((id: string) => {
      const host = document.createElement("div");
      host.dataset.terminalSessionId = id;
      const input = document.createElement("textarea");
      input.setAttribute("aria-label", "Terminal input");
      input.addEventListener("input", () => {
        void write(id, input.value);
      });
      host.appendChild(input);
      hosts.set(id, host);
    }),
    ready: vi.fn(async () => undefined),
    close: vi.fn(async (id: string) => {
      hosts.get(id)?.remove();
      hosts.delete(id);
    }),
    write,
    sync: vi.fn(
      (
        container: HTMLElement,
        visible: string | string[] | null,
      ) => {
        for (const host of hosts.values()) {
          if (host.parentElement !== container) container.appendChild(host);
        }
        const visibleIds = new Set(
          Array.isArray(visible) ? visible : visible ? [visible] : [],
        );
        for (const [id, host] of hosts) {
          host.style.display = visibleIds.has(id) ? "" : "none";
        }
      },
    ),
  };
}

// react-resizable-panels discovers adjacent panels from layout geometry.
// happy-dom reports every offset as zero, which sorts the separator after both
// panels; give this one nested group realistic vertical positions instead.
let restoreAriaDisabled: (() => void) | null = null;

function mockResizableGeometry() {
  const ariaDisabledDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "ariaDisabled",
  );
  Object.defineProperty(HTMLElement.prototype, "ariaDisabled", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("aria-disabled");
    },
  });
  restoreAriaDisabled = () => {
    if (ariaDisabledDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "ariaDisabled",
        ariaDisabledDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "ariaDisabled");
    }
  };
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
    function (this: HTMLElement) {
      if (this.id === "chat-terminal-resize-handle") return 550;
      if (this.id === "terminal") return 558;
      return 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      if (this.id === "chat") return 550;
      if (this.id === "chat-terminal-resize-handle") return 8;
      if (this.id === "terminal") return 450;
      return 0;
    },
  );
}

function makeReviewStore(git = new MockGit()) {
  return createReviewStore({ git, watch: { onChanged: async () => () => {} } });
}

function makeWorkingTreeStore(git = new MockGit()) {
  return createWorkingTreeSummaryStore(git);
}

async function mount({
  review = makeReviewStore(),
  workingTree = makeWorkingTreeStore(),
} = {}) {
  const storage = new MockStorage();
  const agent = new MockAgentIpc();
  const terminalRegistry = fakeRegistry();
  const projectsStore = createProjectsStore({
    storage,
    registry: terminalRegistry,
    autoStartTerminal: false,
    newId: (() => {
      let n = 0;
      return () => `s-${++n}`;
    })(),
  });
  await projectsStore.getState().hydrate();
  await projectsStore.getState().addProject("/repos/alpha");
  const projectId = projectsStore.getState().projects[0].id;

  const chatThreadsStore = createChatStore({
    agent,
    storage,
    projectRoot: () => "/repos/alpha",
    remoteTarget: (id) =>
      remoteTargetForProjectId(projectsStore.getState().remoteTargets, id),
    persistDebounceMs: 0,
  });
  await chatThreadsStore.getState().start();

  const providers = createProvidersStore({
    ipc: { detect: async () => null },
    launch: async () => undefined,
  });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChatPane
        projectsStore={projectsStore}
        chatThreadsStore={chatThreadsStore}
        providers={providers}
        terminalRegistry={terminalRegistry}
        review={review}
        workingTree={workingTree}
      />,
    );
  });
  return {
    host,
    root,
    projectsStore,
    chatThreadsStore,
    agent,
    storage,
    projectId,
    terminalRegistry,
    review,
    workingTree,
  };
}

let mounted: Root | null = null;
afterEach(() => {
  const root = mounted;
  mounted = null;
  if (root) act(() => root.unmount());
  document.body.innerHTML = "";
  restoreAriaDisabled?.();
  restoreAriaDisabled = null;
  vi.restoreAllMocks();
});

describe("ChatPane", () => {
  it("keeps a remote OpenCode thread Default-only even when local models are cached", async () => {
    const { host, root, projectsStore, chatThreadsStore } = await mount();
    mounted = root;
    const target = { host: "studio", path: "/srv/project" };
    const remoteId = remoteProjectId(target);
    const threadId = "remote-chat";

    await act(async () => {
      projectsStore.setState((state) => ({
        remoteTargets: [...state.remoteTargets, target],
        activeProjectId: remoteId,
        activeSessionByProject: {
          ...state.activeSessionByProject,
          [remoteId]: threadId,
        },
        sessions: [
          ...state.sessions,
          {
            id: threadId,
            projectId: remoteId,
            kind: "chat" as const,
            name: "opencode 1",
          },
        ],
      }));
      chatThreadsStore.setState((state) => ({
        providerModels: {
          ...state.providerModels,
          [providerModelKey("opencode", remoteId)]: {
            status: "ready",
            models: [{ id: "local/should-not-leak", label: "local/should-not-leak" }],
            message: null,
          },
        },
      }));
      await chatThreadsStore
        .getState()
        .openThread(threadId, remoteId, "opencode");
    });

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!;
    await act(async () => trigger.click());
    expect([...host.querySelectorAll('[role="option"]')].map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Default model"),
    ]);
  });

  it("keeps a newly selected project free of a terminal until a chat requests one", async () => {
    const { host, root } = await mount();
    mounted = root;

    expect(host.querySelector("[data-terminal-layout]")).toBeNull();
    expect(host.querySelector('[data-testid="chat-terminal-split"]')).toBeNull();
    expect(host.textContent).toContain("Send a message to start the conversation.");
    expect(host.querySelector('button[aria-label="Show terminal"]')).not.toBeNull();
  });

  it("shows the empty state until a message is sent", async () => {
    const { host, root, projectsStore, chatThreadsStore, projectId } = await mount();
    mounted = root;

    await act(async () => {
      const threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
    });

    expect(host.textContent).toContain("Send a message to start the conversation.");
    // The umlaut is not optional in a KödChat surface.
    expect(host.textContent).toContain("KödChat");
  });

  it("Enter sends and Shift+Enter does not", async () => {
    const { host, root, projectsStore, chatThreadsStore, agent, projectId } =
      await mount();
    mounted = root;

    await act(async () => {
      const threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
    });

    const textarea = host.querySelector("textarea")!;
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    await type("hello agent");
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      );
    });
    expect(agent.starts).toHaveLength(0);

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(agent.starts).toHaveLength(1);
    expect(agent.starts[0].stdin).toBe("hello agent");
    // The user's message is in the transcript immediately.
    expect(host.querySelector('[data-chat-role="user"]')?.textContent).toBe(
      "hello agent",
    );
  });

  it("keeps unsent drafts isolated when switching chat threads", async () => {
    const { host, root, projectsStore, chatThreadsStore, projectId } = await mount();
    mounted = root;

    const type = async (value: string) => {
      const textarea = host.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    let firstThreadId = "";
    let secondThreadId = "";
    await act(async () => {
      firstThreadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(firstThreadId, projectId, "claude");
    });
    await type("draft for the first thread");

    await act(async () => {
      secondThreadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(secondThreadId, projectId, "claude");
    });
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");

    await type("draft for the second thread");
    await act(async () => {
      projectsStore.getState().setActiveSession(projectId, firstThreadId);
    });
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
      "draft for the first thread",
    );

    await act(async () => {
      projectsStore.getState().setActiveSession(projectId, secondThreadId);
    });
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
      "draft for the second thread",
    );

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click();
    });
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");

    await act(async () => {
      projectsStore.getState().setActiveSession(projectId, firstThreadId);
    });
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
      "draft for the first thread",
    );
  });

  it("auto-titles the session from the first prompt, never over a manual rename", async () => {
    const { host, root, projectsStore, chatThreadsStore, projectId } = await mount();
    mounted = root;

    let threadId = "";
    await act(async () => {
      threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
    });

    const send = async (text: string) => {
      const textarea = host.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(textarea, text);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
    };

    // First prompt renames the session to a short topic, not the raw line.
    await send("Please help me fix the login form validation");
    const named = projectsStore.getState().sessions.find((s) => s.id === threadId)!;
    expect(named.name).toBe("login form validation");

    // A manually renamed (locked) thread is never overwritten by auto-titling.
    let lockedId = "";
    await act(async () => {
      lockedId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(lockedId, projectId, "claude");
      projectsStore.getState().renameSession(lockedId, "My thread");
    });
    await send("Please help me fix the login form validation");
    const locked = projectsStore.getState().sessions.find((s) => s.id === lockedId)!;
    expect(locked.name).toBe("My thread");
  });

  it("renders a streaming answer and a tool card, then settles", async () => {
    const { host, root, projectsStore, chatThreadsStore, agent, projectId } =
      await mount();
    mounted = root;

    let threadId = "";
    await act(async () => {
      threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
      await chatThreadsStore.getState().send(threadId, "read the file");
    });
    const runId = agent.starts[0].id;

    // Working indicator is up while the run is in flight.
    expect(host.querySelector('[data-testid="chat-working"]')).not.toBeNull();

    await act(async () => {
      agent.emit(
        runId,
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_1",
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.txt" } },
            ],
          },
        }),
      );
      agent.emit(
        runId,
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "hello world" },
            ],
          },
        }),
      );
      agent.emit(
        runId,
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_2",
            role: "assistant",
            content: [{ type: "text", text: "The file says **hello world**." }],
          },
        }),
      );
      agent.emit(runId, JSON.stringify({ type: "result", is_error: false }));
      agent.exit(runId, 0, "");
    });

    expect(host.querySelector('[data-testid="chat-tool-activity"]')?.textContent).toContain(
      "Read",
    );
    const assistant = host.querySelector('[data-chat-role="assistant"]');
    expect(assistant?.textContent).toContain("hello world");
    // Markdown is rendered, not shown as source.
    expect(assistant?.innerHTML).toContain("<strong>");
    expect(host.querySelector('[data-testid="chat-working"]')).toBeNull();
  });

  it("opens assistant links in the editor browser tab without leaving KödChat", async () => {
    const { host, root, projectsStore, chatThreadsStore, agent, projectId } =
      await mount();
    mounted = root;
    filesStore.setState({
      rootPath: "/repos/chat-link-test",
      openTabs: [],
      activeTab: null,
    });

    let threadId = "";
    await act(async () => {
      threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
      await chatThreadsStore.getState().send(threadId, "open the release");
    });
    const runId = agent.starts[0].id;
    const url = "https://github.com/Kodade/kodade/releases/tag/v1.4.14";

    await act(async () => {
      agent.emit(
        runId,
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_link",
            role: "assistant",
            content: [{ type: "text", text: `[Open the release](${url})` }],
          },
        }),
      );
      agent.emit(runId, JSON.stringify({ type: "result", is_error: false }));
      agent.exit(runId, 0, "");
    });

    const link = host.querySelector<HTMLAnchorElement>(
      '[data-chat-role="assistant"] a',
    )!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      expect(link.dispatchEvent(click)).toBe(false);
    });

    expect(filesStore.getState().activeTab).toEqual({ kind: "browser", url });
    expect(host.textContent).toContain("KödChat");
    expect(host.querySelector('button[aria-label="Show terminal"]')).not.toBeNull();
  });

  it("shows current working-tree edits after a completed turn and opens the existing review tab", async () => {
    const summaryGit = new MockGit();
    summaryGit.responses.set("diff --numstat -z", {
      stdout: ["3\t1\tsrc/a.ts", "2\t0\tsrc/b.ts", ""].join("\0"),
      stderr: "",
    });
    const review = makeReviewStore();
    review.setState({
      scope: { kind: "branch", base: "main" },
      projectRoot: "/repos/other",
    });
    const workingTree = makeWorkingTreeStore(summaryGit);
    workingTree.setState({
      projectRoot: "/repos/other",
      summary: { files: 1, adds: 99, dels: 0 },
      loaded: true,
    });
    const { host, root, projectsStore, chatThreadsStore, agent, projectId } =
      await mount({ review, workingTree });
    mounted = root;
    filesStore.setState({ rootPath: "/repos/alpha", openTabs: [], activeTab: null });

    let threadId = "";
    await act(async () => {
      threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
      await chatThreadsStore.getState().send(threadId, "make the edits");
      agent.exit(agent.starts[0].id, 0, "");
    });
    for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());

    const card = host.querySelector('[data-testid="chat-edited-files"]')!;
    expect(card.textContent).toContain("Edited 2 files");
    expect(card.textContent).toContain("+5");
    expect(card.textContent).toContain("−1");
    expect(card.textContent).toContain("Current working tree");
    expect(card.textContent).not.toContain("99");
    expect(review.getState()).toMatchObject({
      scope: { kind: "branch", base: "main" },
      projectRoot: "/repos/other",
    });
    expect(workingTree.getState().projectRoot).toBe("/repos/alpha");
    expect(card.tagName).toBe("BUTTON");
    expect(card.querySelector("button")).toBeNull();

    const cardCopy = card.querySelector('[data-testid="chat-edited-files-copy"]')!;
    act(() => cardCopy.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
    expect(filesStore.getState().activeTab).toEqual({ kind: "review" });
    expect(review.getState()).toMatchObject({
      scope: { kind: "worktree" },
      projectRoot: "/repos/alpha",
    });

    filesStore.setState({ activeTab: null, openTabs: [] });
    review.setState({ scope: { kind: "pr", number: 7 }, projectRoot: "/repos/other" });
    const reviewAffordance = card.querySelector('[data-testid="chat-review-affordance"]')!;
    act(() => reviewAffordance.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
    expect(filesStore.getState().activeTab).toEqual({ kind: "review" });
    expect(review.getState()).toMatchObject({
      scope: { kind: "worktree" },
      projectRoot: "/repos/alpha",
    });
    expect(summaryGit.calls.filter((args) => args.join(" ") === "diff --numstat -z HEAD")).toHaveLength(1);
    expect(card.querySelector('[data-testid="chat-additions"]')?.className).toContain(
      "var(--kd-success)",
    );
    expect(card.querySelector('[data-testid="chat-deletions"]')?.className).toContain(
      "var(--kd-error)",
    );
  });

  it("keeps the edited-files card quiet for a clean or unreadable working tree", async () => {
    const cleanGit = new MockGit();
    cleanGit.responses.set("diff --numstat -z", { stdout: "", stderr: "" });
    const workingTree = makeWorkingTreeStore(cleanGit);
    const { host, root, projectsStore, chatThreadsStore, agent, projectId } =
      await mount({ workingTree });
    mounted = root;
    filesStore.setState({ rootPath: "/repos/alpha", openTabs: [], activeTab: null });

    await act(async () => {
      const threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
      await chatThreadsStore.getState().send(threadId, "check it");
      agent.exit(agent.starts[0].id, 0, "");
    });
    for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
    expect(host.querySelector('[data-testid="chat-edited-files"]')).toBeNull();
  });

  it("keeps a prior card from surviving a current working-tree read failure", async () => {
    const git = new MockGit();
    git.responses.set("diff --numstat -z", { stdout: "1\t0\tsrc/a.ts\0", stderr: "" });
    const workingTree = makeWorkingTreeStore(git);
    const { host, root, projectsStore, chatThreadsStore, agent, projectId } =
      await mount({ workingTree });
    mounted = root;
    filesStore.setState({ rootPath: "/repos/alpha", openTabs: [], activeTab: null });

    let threadId = "";
    await act(async () => {
      threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
      await chatThreadsStore.getState().send(threadId, "make one edit");
      agent.exit(agent.starts[0].id, 0, "");
    });
    for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
    expect(host.querySelector('[data-testid="chat-edited-files"]')).not.toBeNull();

    git.responses.set("diff --numstat -z", new Error("not a git repository"));
    await act(async () => {
      await chatThreadsStore.getState().send(threadId, "try again");
      agent.exit(agent.starts[1].id, 0, "");
    });
    for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
    expect(host.querySelector('[data-testid="chat-edited-files"]')).toBeNull();
    expect(git.calls.filter((args) => args.join(" ") === "diff --numstat -z HEAD")).toHaveLength(2);
  });

  it("offers a login terminal on an auth failure", async () => {
    const { host, root, projectsStore, chatThreadsStore, agent, projectId } =
      await mount();
    mounted = root;

    await act(async () => {
      const threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
      await chatThreadsStore.getState().send(threadId, "hello");
      agent.exit(agent.starts[0].id, 1, "Invalid API key · Please run /login");
    });

    const card = host.querySelector('[data-testid="chat-auth-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Open a terminal to log in");
    expect(host.querySelector('[data-testid="chat-error-card"]')).toBeNull();
  });

  it("switches provider and picks a codex model through the styled menus", async () => {
    const { host, root, projectsStore, chatThreadsStore, projectId } = await mount();
    mounted = root;

    let threadId = "";
    await act(async () => {
      threadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(threadId, projectId, "claude");
    });

    const optionByLabel = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
        (option) => option.textContent?.includes(label),
      );

    // Provider menu: options carry the brand badge; Ollama is a first-class
    // local HTTP chat provider, while genuinely terminal-only entries stay disabled.
    const providerTrigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Provider"]',
    )!;
    await act(async () => providerTrigger.click());
    expect(optionByLabel("Ollama")?.disabled).toBe(false);
    await act(async () => optionByLabel("Codex")?.click());
    expect(chatThreadsStore.getState().threads[threadId].providerId).toBe("codex");

    // Codex now offers a model picker, same as Claude (issue: parity).
    const modelTrigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Model"]',
    )!;
    await act(async () => modelTrigger.click());
    await act(async () => optionByLabel("GPT-5.6-Sol")?.click());
    expect(chatThreadsStore.getState().threads[threadId].model).toBe("gpt-5.6-sol");
  });

  it("opens one thread-owned terminal without leaving the chat or adding a workspace card", async () => {
    const {
      host,
      root,
      projectsStore,
      chatThreadsStore,
      projectId,
      terminalRegistry,
    } = await mount();
    mounted = root;
    const initialTerminal = projectsStore
      .getState()
      .sessions.find((session) => !isChatSession(session));
    if (initialTerminal) {
      await act(async () => {
        await projectsStore.getState().closeSession(initialTerminal.id);
      });
    }
    terminalRegistry.open.mockClear();
    mockResizableGeometry();

    let threadId = "";
    await act(async () => {
      threadId = projectsStore
        .getState()
        .addChatThread(projectId, "claude")!;
      await chatThreadsStore
        .getState()
        .openThread(threadId, projectId, "claude");
    });

    expect(host.querySelector('[data-testid="chat-terminal-split"]')).toBeNull();
    const toggle = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Show terminal"]',
    )!;
    expect(toggle.textContent).toContain("Show terminal");
    await act(async () => toggle.click());

    const split = host.querySelector('[data-testid="chat-terminal-split"]');
    expect(split).not.toBeNull();
    const resizeHandle = host.querySelector<HTMLElement>(
      '[data-testid="chat-terminal-resize-handle"]',
    );
    expect(resizeHandle?.getAttribute("role")).toBe("separator");
    expect(resizeHandle?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(resizeHandle?.getAttribute("aria-controls")).toBe("chat");
    expect(resizeHandle?.classList.contains("h-2")).toBe(true);
    expect(
      resizeHandle?.querySelector('[data-testid="chat-terminal-resize-line"]'),
    ).not.toBeNull();
    expect(host.textContent).toContain("Send a message to start the conversation.");
    expect(split!.querySelector("[data-terminal-leaf-id]")).not.toBeNull();
    expect(split!.textContent).not.toContain("No terminal is open");
    expect(split!.textContent).not.toContain("New terminal");

    const state = projectsStore.getState();
    const terminal = state.sessions.find((session) => !isChatSession(session));
    expect(terminal).toMatchObject({ projectId, workspaceId: threadId });
    expect(state.activeSessionByProject[projectId]).toBe(threadId);
    expect(terminalRegistry.open).toHaveBeenCalledWith(terminal!.id, "/repos/alpha");

    const terminalHost = split!.querySelector<HTMLElement>(
      `[data-terminal-session-id="${terminal!.id}"]`,
    )!;
    const terminalInput = terminalHost.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Terminal input"]',
    )!;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      resizeHandle?.focus();
      resizeHandle?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Home",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(Number(resizeHandle?.getAttribute("aria-valuenow"))).toBe(30);
    await act(async () => {
      resizeHandle?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "End",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(Number(resizeHandle?.getAttribute("aria-valuenow"))).toBe(80);
    expect(
      split!.querySelector(`[data-terminal-session-id="${terminal!.id}"]`),
    ).toBe(terminalHost);
    terminalInput.focus();
    terminalInput.value = "pwd";
    terminalInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(document.activeElement).toBe(terminalInput);
    expect(terminalInput.value).toBe("pwd");
    expect(terminalRegistry.write).toHaveBeenCalledWith(terminal!.id, "pwd");

    const activity = createActivityModule({ now: () => 0 });
    activity.observe({
      type: "project-added",
      at: 0,
      projectId,
      projectName: "alpha",
    });
    for (const session of state.sessions) {
      activity.observe({
        type: "session-created",
        at: 0,
        projectId,
        sessionId: session.id,
        name: session.name,
      });
    }
    expect(
      projectWorkspaceView(activity, state.sessions, 0).groups.flatMap(
        (group) => group.sessions,
      ),
    ).toHaveLength(0);

    const hide = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide terminal"]',
    )!;
    expect(hide.textContent).toContain("Hide terminal");
    await act(async () => hide.click());
    expect(host.querySelector('[data-testid="chat-terminal-split"]')).toBeNull();

    await act(async () => toggle.click());
    expect(projectsStore.getState().sessions).toHaveLength(2);
    expect(terminalRegistry.open).toHaveBeenCalledTimes(1);

    await act(async () => {
      await projectsStore.getState().closeWorkspace(threadId);
    });
    expect(projectsStore.getState().sessions).toHaveLength(0);
    expect(terminalRegistry.close).toHaveBeenCalledWith(terminal!.id);
  });

  it("keeps an opened terminal inside its owning chat when switching threads", async () => {
    const {
      host,
      root,
      projectsStore,
      chatThreadsStore,
      projectId,
      terminalRegistry,
    } = await mount();
    mounted = root;

    const initialTerminal = projectsStore
      .getState()
      .sessions.find((session) => !isChatSession(session));
    if (initialTerminal) {
      await act(async () => {
        await projectsStore.getState().closeSession(initialTerminal.id);
      });
    }
    terminalRegistry.open.mockClear();

    let firstThreadId = "";
    let secondThreadId = "";
    await act(async () => {
      firstThreadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(firstThreadId, projectId, "claude");
    });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Show terminal"]')?.click(),
    );
    expect(host.querySelector('[data-testid="chat-terminal-split"]')).not.toBeNull();
    const firstTerminal = projectsStore
      .getState()
      .sessions.find((session) => !isChatSession(session))!;
    const firstTerminalHost = host.querySelector(
      `[data-terminal-session-id="${firstTerminal.id}"]`,
    );

    await act(async () => {
      secondThreadId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(secondThreadId, projectId, "claude");
    });

    expect(host.querySelector('[data-testid="chat-terminal-split"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Show terminal"]')).not.toBeNull();
    expect(
      projectsStore
        .getState()
        .sessions.filter((session) => !isChatSession(session)),
    ).toHaveLength(1);
    expect(terminalRegistry.open).toHaveBeenCalledTimes(1);

    await act(async () => {
      projectsStore.getState().setActiveSession(projectId, firstThreadId);
      await chatThreadsStore
        .getState()
        .openThread(firstThreadId, projectId, "claude");
    });

    expect(host.querySelector('[data-testid="chat-terminal-split"]')).not.toBeNull();
    expect(
      host.querySelector(`[data-terminal-session-id="${firstTerminal.id}"]`),
    ).toBe(firstTerminalHost);
    expect(terminalRegistry.open).toHaveBeenCalledTimes(1);
  });

  it("resolves a defensively selected owned terminal back to its chat", async () => {
    const { host, root, projectsStore, chatThreadsStore, projectId } = await mount();
    mounted = root;
    let chatId = "";

    await act(async () => {
      chatId = projectsStore.getState().addChatThread(projectId, "claude")!;
      await chatThreadsStore.getState().openThread(chatId, projectId, "claude");
      projectsStore.getState().addTerminal(projectId, chatId);
      await Promise.resolve();
    });

    expect(projectsStore.getState().activeSessionByProject[projectId]).toBe(chatId);
    expect(host.textContent).toContain("KödChat");
    expect(host.querySelector("[data-terminal-layout]")).toBeNull();
    expect(host.querySelector('button[aria-label="New terminal"]')).toBeNull();
  });

  it("does not render a stale unowned local terminal as a root workspace", async () => {
    const { host, root, projectsStore, projectId } = await mount();
    mounted = root;

    await act(async () => {
      projectsStore.setState({
        sessions: [{ id: "stale-root", projectId, name: "zsh 1" }],
        activeSessionByProject: { [projectId]: "stale-root" },
      });
    });

    expect(host.textContent).toContain("KödChat");
    expect(host.querySelector("[data-terminal-layout]")).toBeNull();
    expect(host.querySelector('button[aria-label="New terminal"]')).toBeNull();
  });
});
