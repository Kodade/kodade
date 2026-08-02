// ChatPane render + composer behaviour, driven by real (mock-backed) stores.
// The terminal split is asserted structurally: the point is that the EXISTING
// terminal machinery is what gets mounted, not a reimplementation.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgentIpc, MockStorage } from "../../ipc/mock";
import { createChatStore } from "../../chat/store";
import { createProjectsStore } from "../../store/projects";
import { createProvidersStore } from "../../providers/store";
import { ChatPane } from "./ChatPane";

// The split mounts the real TerminalPane, which owns registry hosts outside
// React. Stub it so this suite tests the pane's own behaviour, not xterm.
vi.mock("../TerminalPane", () => ({
  TerminalPane: () => <div data-testid="stub-terminal-pane" />,
}));

function fakeRegistry() {
  return {
    open: () => undefined,
    ready: async () => undefined,
    close: async () => undefined,
    write: async () => undefined,
  };
}

async function mount() {
  const storage = new MockStorage();
  const agent = new MockAgentIpc();
  const projectsStore = createProjectsStore({
    storage,
    registry: fakeRegistry(),
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
      />,
    );
  });
  return { host, root, projectsStore, chatThreadsStore, agent, storage, projectId };
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

    expect(host.querySelector('[data-testid="stub-terminal-pane"]')).not.toBeNull();
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

  it("the header toggle opens and closes the terminal split", async () => {
    const { host, root, projectsStore, chatThreadsStore, projectId } =
      await mount();
    mounted = root;
    await act(async () => {
      const threadId = projectsStore
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
    // It mounts the EXISTING terminal pane rather than a second implementation.
    expect(split!.querySelector('[data-testid="stub-terminal-pane"]')).not.toBeNull();

    const hide = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide terminal"]',
    )!;
    expect(hide.textContent).toContain("Hide terminal");
    await act(async () => hide.click());
    expect(host.querySelector('[data-testid="chat-terminal-split"]')).toBeNull();
  });
});
