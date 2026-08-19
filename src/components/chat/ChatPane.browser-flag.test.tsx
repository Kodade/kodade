// Archived embedded browser (#62), public profile: a link in a KödChat reply
// leaves for the OS browser instead of opening a pane that no longer exists.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// The whole app graph compiles against the public manifest for this file.
vi.mock("../../release/manifest", () => {
  const features = {
    local: false,
    voice: false,
    ssh: false,
    work: true,
    shell: false,
    browser: false,
  };
  const manifest = { profile: "public", features };
  return {
    RELEASE_MANIFEST: manifest,
    releaseManifestFor: () => manifest,
    developmentFeatureEnabled: (feature: keyof typeof features) =>
      features[feature],
  };
});

import { CMD } from "../../ipc/contract";
import { MockAgentIpc, MockStorage } from "../../ipc/mock";
import { createChatStore } from "../../chat/store";
import { createProjectsStore } from "../../store/projects";
import { createProvidersStore } from "../../providers/store";
import { createReviewStore } from "../../store/review";
import { createWorkingTreeSummaryStore } from "../../chat/working-tree";
import { MockGit } from "../../ipc/mock";
import { filesStore } from "../../store/appStore";
import { ChatPane } from "./ChatPane";

function fakeRegistry() {
  return {
    open: vi.fn(),
    ready: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    sync: vi.fn(),
  };
}

let mounted: Root | null = null;
afterEach(() => {
  const root = mounted;
  mounted = null;
  if (root) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("KödChat links without the embedded browser", () => {
  it("opens an assistant link in the OS browser and adds no browser tab", async () => {
    const storage = new MockStorage();
    const agent = new MockAgentIpc();
    const terminalRegistry = fakeRegistry();
    const projectsStore = createProjectsStore({
      storage,
      registry: terminalRegistry,
      autoStartTerminal: false,
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

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted = root;
    await act(async () => {
      root.render(
        <ChatPane
          projectsStore={projectsStore}
          chatThreadsStore={chatThreadsStore}
          providers={createProvidersStore({
            ipc: { detect: async () => null },
            launch: async () => undefined,
          })}
          terminalRegistry={terminalRegistry}
          review={createReviewStore({
            git: new MockGit(),
            watch: { onChanged: async () => () => {} },
          })}
          workingTree={createWorkingTreeSummaryStore(new MockGit())}
        />,
      );
    });

    filesStore.setState({
      rootPath: "/repos/alpha",
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
    const url = "https://kodade.com/docs";

    await act(async () => {
      agent.emit(
        runId,
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_link",
            role: "assistant",
            content: [{ type: "text", text: `[Read the docs](${url})` }],
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

    expect(invoke).toHaveBeenCalledWith(CMD.openUrl, { url });
    expect(filesStore.getState().activeTab).toBeNull();
    expect(filesStore.getState().openTabs).toEqual([]);
  });
});
