// ChatPane render + composer behaviour, driven by real (mock-backed) stores.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgentIpc, MockStorage } from "../../ipc/mock";
import { createChatStore } from "../../chat/store";
import { createActivityModule } from "../../activity/activity";
import { createProjectsStore, isChatSession } from "../../store/projects";
import { createProvidersStore } from "../../providers/store";
import { filesStore } from "../../store/appStore";
import { projectWorkspaceView } from "../ProjectsSidebar";
import { ChatPane } from "./ChatPane";

function fakeRegistry() {
  const hosts = new Map<string, HTMLElement>();
  return {
    open: vi.fn((id: string) => {
      const host = document.createElement("div");
      host.dataset.terminalSessionId = id;
      hosts.set(id, host);
    }),
    ready: vi.fn(async () => undefined),
    close: vi.fn(async (id: string) => {
      hosts.get(id)?.remove();
      hosts.delete(id);
    }),
    write: vi.fn(async () => undefined),
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

async function mount() {
  const storage = new MockStorage();
  const agent = new MockAgentIpc();
  const terminalRegistry = fakeRegistry();
  const projectsStore = createProjectsStore({
    storage,
    registry: terminalRegistry,
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
  };
}

let mounted: Root | null = null;
afterEach(() => {
  const root = mounted;
  mounted = null;
  if (root) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("ChatPane", () => {
  it("shows a selected terminal as the full workspace instead of an empty chat", async () => {
    const { host, root } = await mount();
    mounted = root;

    expect(host.querySelector("[data-terminal-layout]")).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-terminal-split"]')).toBeNull();
    expect(host.textContent).not.toContain("Send a message to start the conversation.");
    expect(
      host.querySelector('button[aria-label="Show terminal"]'),
    ).toBeNull();
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

    expect(host.querySelector('[data-testid="chat-tool-card"]')?.textContent).toContain(
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

    // Provider menu: options carry the brand badge and terminal-only providers
    // are listed but not selectable.
    const providerTrigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Provider"]',
    )!;
    await act(async () => providerTrigger.click());
    expect(optionByLabel("Ollama")?.disabled).toBe(true);
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
      .sessions.find((session) => !isChatSession(session))!;
    await act(async () => {
      await projectsStore.getState().closeSession(initialTerminal.id);
    });
    terminalRegistry.open.mockClear();

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
    expect(host.textContent).toContain("Send a message to start the conversation.");
    expect(split!.querySelector("[data-terminal-leaf-id]")).not.toBeNull();
    expect(split!.textContent).not.toContain("No terminal is open");
    expect(split!.textContent).not.toContain("New terminal");

    const state = projectsStore.getState();
    const terminal = state.sessions.find((session) => !isChatSession(session));
    expect(terminal).toMatchObject({ projectId, workspaceId: threadId });
    expect(state.activeSessionByProject[projectId]).toBe(threadId);
    expect(terminalRegistry.open).toHaveBeenCalledWith(terminal!.id, "/repos/alpha");

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
});
