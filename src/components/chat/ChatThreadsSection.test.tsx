// Sidebar thread-row label rules (issue #6): an empty thread reads "New chat"
// — never the provider-numbered session name — the loaded title takes over
// once the thread has messages, and a locked (renamed) session name always
// wins.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { newThread, type ChatThread } from "../../chat/model";
import { createChatStore } from "../../chat/store";
import { MockAgentIpc, MockStorage } from "../../ipc/mock";
import { createProjectsStore, type SessionMeta } from "../../store/projects";
import { ChatThreadRow, ChatThreadsSection } from "./ChatThreadsSection";

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id: "t1", projectId: "p1", kind: "chat", name: "claude 1", ...overrides };
}

let mountedRoots: Root[] = [];
afterEach(() => {
  const roots = mountedRoots;
  mountedRoots = [];
  for (const root of roots) act(() => root.unmount());
  document.body.innerHTML = "";
});

function renderRow(meta: SessionMeta, thread: ChatThread | undefined): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ul>
        <ChatThreadRow
          session={meta}
          thread={thread}
          selected={false}
          onActivate={() => undefined}
          onClose={() => undefined}
        />
      </ul>,
    );
  });
  mountedRoots.push(root);
  return host;
}

// Minimal stand-in for the terminal registry — this suite never inspects PTY
// I/O, it only needs addProject()'s auto-open to resolve.
function fakeRegistry() {
  return {
    open: () => {},
    close: async () => {},
    write: () => {},
  };
}

async function setupSection() {
  const projectsStore = createProjectsStore({
    storage: new MockStorage(),
    registry: fakeRegistry(),
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });
  await projectsStore.getState().hydrate();
  await projectsStore.getState().addProject("/repo-a");
  await projectsStore.getState().addProject("/repo-b");
  // addProject() force-expands the project it activates, so /repo-a is
  // expanded too even though /repo-b (added after) is the active one now.
  // Force repo-a explicitly closed so its row exercises a real
  // closed -> open transition.
  const project = projectsStore
    .getState()
    .projects.find((p) => p.path === "/repo-a")!;
  projectsStore.getState().toggleProjectExpanded(project.id);

  const chatThreadsStore = createChatStore({
    agent: new MockAgentIpc(),
    storage: new MockStorage(),
    projectRoot: () => "/repo",
    remoteTarget: () => null,
    persistDebounceMs: 0,
  });
  await chatThreadsStore.getState().start();

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ChatThreadsSection
        projectsStore={projectsStore}
        chatThreadsStore={chatThreadsStore}
      />,
    );
  });
  mountedRoots.push(root);
  return { host, projectsStore, project };
}

function dotClassOf(host: HTMLElement): string {
  return host.querySelector("button[data-thread-state] > span[aria-hidden]")?.className ?? "";
}

describe("ChatThreadRow label", () => {
  it("shows New chat for a brand-new empty thread, not the session name", () => {
    const host = renderRow(session(), newThread("t1", "p1", "claude", 0));
    expect(host.textContent).toContain("New chat");
    expect(host.textContent).not.toContain("claude 1");
  });

  it("shows New chat before an unrenamed thread's transcript loads", () => {
    const host = renderRow(session(), undefined);
    expect(host.textContent).toContain("New chat");
    expect(host.textContent).not.toContain("claude 1");
  });

  it("shows the thread title once it has messages", () => {
    const thread = {
      ...newThread("t1", "p1", "claude", 0),
      title: "login form validation",
      entries: [{ kind: "message", id: "m1", role: "user", text: "hi" } as const],
    };
    const host = renderRow(session(), thread);
    expect(host.textContent).toContain("login form validation");
  });

  it("a locked (renamed) session name always wins", () => {
    const thread = {
      ...newThread("t1", "p1", "claude", 0),
      title: "login form validation",
      entries: [{ kind: "message", id: "m1", role: "user", text: "hi" } as const],
    };
    const host = renderRow(
      session({ name: "My thread", nameLocked: true }),
      thread,
    );
    expect(host.textContent).toContain("My thread");
    expect(host.textContent).not.toContain("login form validation");
  });
});

describe("ChatThreadRow status dot (#59)", () => {
  it("renders green for a working thread, never accent or dim", () => {
    const host = renderRow(session(), { ...newThread("t1", "p1", "claude", 0), status: "working" });
    const dotClass = dotClassOf(host);
    expect(dotClass).toContain("bg-emerald-400");
    expect(dotClass).toContain("kd-dot-pulse");
    expect(dotClass).not.toContain("bg-accent");
    expect(dotClass).not.toContain("bg-text-dim");
  });

  it("renders red for a settled thread, never accent or dim", () => {
    const host = renderRow(session(), { ...newThread("t1", "p1", "claude", 0), status: "idle" });
    const dotClass = dotClassOf(host);
    expect(dotClass).toContain("bg-red-400");
    expect(dotClass).not.toContain("bg-accent");
    expect(dotClass).not.toContain("bg-text-dim");
  });

  it("renders red for a needs-you thread, never accent or dim", () => {
    const host = renderRow(session(), { ...newThread("t1", "p1", "claude", 0), status: "error" });
    const dotClass = dotClassOf(host);
    expect(dotClass).toContain("bg-red-400");
    expect(dotClass).not.toContain("bg-accent");
    expect(dotClass).not.toContain("bg-text-dim");
  });
});

describe("workspace row click expands (#60)", () => {
  it("clicking the project row name toggles the sessions dropdown and sets it active", async () => {
    const { host, projectsStore, project } = await setupSection();
    const nameButton = host.querySelector(
      `[data-workspace-project="${project.id}"] button[aria-label="Open ${project.name} project"]`,
    ) as HTMLButtonElement;
    expect(nameButton).toBeTruthy();

    // A second, later-added project is now active; this row starts collapsed.
    expect(nameButton.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      nameButton.click();
    });

    expect(projectsStore.getState().expandedProjects[project.id]).toBe(true);
    expect(projectsStore.getState().activeProjectId).toBe(project.id);
    expect(nameButton.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking the name of an already-expanded, active row collapses it", async () => {
    const { host, projectsStore, project } = await setupSection();
    const nameButton = host.querySelector(
      `[data-workspace-project="${project.id}"] button[aria-label="Open ${project.name} project"]`,
    ) as HTMLButtonElement;

    // First click: closed -> open + active (setActiveProject is a no-op
    // since it's already active from the prior expand-open flow below).
    await act(async () => {
      nameButton.click();
    });
    expect(projectsStore.getState().expandedProjects[project.id]).toBe(true);
    expect(projectsStore.getState().activeProjectId).toBe(project.id);
    expect(nameButton.getAttribute("aria-expanded")).toBe("true");

    // Second click on the same (already active, already expanded) row must
    // collapse it. This is the case the async setActiveProject/toggle race
    // broke: setActiveProject force-expands on every call, so a naive
    // "toggle immediately" onClick could never actually collapse a row.
    await act(async () => {
      nameButton.click();
    });
    expect(projectsStore.getState().expandedProjects[project.id]).toBe(false);
    expect(projectsStore.getState().activeProjectId).toBe(project.id);
    expect(nameButton.getAttribute("aria-expanded")).toBe("false");
  });
});
