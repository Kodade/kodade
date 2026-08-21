// The v2 Workspaces sidebar (issue #62, slice b): one list, one row per
// workspace (project), and every chat, terminal, and task inside it. No
// branded section headings survive into v2.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { afterEach, describe, expect, it } from "vitest";
import { createActivityModule } from "../../activity/activity";
import type { ChatState } from "../../chat/store";
import { newTask } from "../../kodwork/model";
import type { KodworkState } from "../../kodwork/store";
import { MockStorage } from "../../ipc/mock";
import { RELEASE_MANIFEST } from "../../release/manifest";
import {
  createProjectsStore,
  type ProjectsState,
  type SessionMeta,
} from "../../store/projects";
import { projectTerminalGroups } from "../sidebar/terminals";
import { WorkspacesSection } from "./WorkspacesSidebar";

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
});

function pty(overrides: Partial<SessionMeta> & { id: string }): SessionMeta {
  return { projectId: "p1", name: overrides.id, ...overrides };
}

function emptyChatStore() {
  return createStore(() => ({ threads: {} })) as unknown as StoreApi<ChatState>;
}

function render(node: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted = createRoot(host);
  act(() => mounted?.render(node));
  return host;
}

describe("projectTerminalGroups", () => {
  it("nests split terminals under their root and skips other projects", () => {
    const groups = projectTerminalGroups(
      [
        pty({ id: "t1" }),
        pty({ id: "t2", workspaceId: "t1" }),
        pty({ id: "t3" }),
        pty({ id: "other", projectId: "p2" }),
      ],
      "p1",
    );
    expect(groups.map((group) => group.root.id)).toEqual(["t1", "t3"]);
    expect(groups[0].children.map((session) => session.id)).toEqual(["t2"]);
    expect(groups[1].children).toEqual([]);
  });

  it("nests a split listed before its root", () => {
    const groups = projectTerminalGroups(
      [pty({ id: "t2", workspaceId: "t1" }), pty({ id: "t1" })],
      "p1",
    );
    expect(groups.map((group) => group.root.id)).toEqual(["t1"]);
    expect(groups[0].children.map((session) => session.id)).toEqual(["t2"]);
  });

  it("promotes a depth-2 chain's orphan instead of dropping it", () => {
    const groups = projectTerminalGroups(
      [
        pty({ id: "t1" }),
        pty({ id: "t2", workspaceId: "t1" }),
        pty({ id: "t3", workspaceId: "t2" }),
      ],
      "p1",
    );
    const rendered = groups.flatMap((group) => [
      group.root.id,
      ...group.children.map((session) => session.id),
    ]);
    expect(rendered.sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("hides terminals embedded in a chat thread or task workspace", () => {
    const groups = projectTerminalGroups(
      [
        { id: "c1", projectId: "p1", name: "claude 1", kind: "chat" },
        { id: "w1", projectId: "p1", name: "work 1", kind: "work" },
        pty({ id: "embedded", workspaceId: "c1" }),
        pty({ id: "task-shell", workspaceId: "w1" }),
        pty({ id: "standalone" }),
      ],
      "p1",
    );
    expect(groups.map((group) => group.root.id)).toEqual(["standalone"]);
  });
});

describe("WorkspacesSection", () => {
  const projectsWithEverything = () => {
    const projects = createStore(() => ({
      projects: [
        { id: "p1", name: "kodade", path: "/repo" },
        { id: "p2", name: "docs", path: "/docs" },
      ],
      sessions: [
        { id: "c1", projectId: "p1", name: "claude 1", kind: "chat" as const, nameLocked: true },
        pty({ id: "zsh", name: "zsh" }),
        pty({ id: "zsh split", name: "zsh split", workspaceId: "zsh" }),
        { id: "task1", projectId: "p1", name: "work 1", kind: "work" as const },
        { id: "c2", projectId: "p2", name: "codex 1", kind: "chat" as const, nameLocked: true },
      ],
      expandedProjects: { p1: true, p2: false },
      activeProjectId: "p1",
      activeSessionByProject: { p1: "c1" },
    })) as unknown as StoreApi<ProjectsState>;
    const work = createStore(() => ({
      tasks: {
        task1: { ...newTask("task1", "p1", "/repo", "claude", 1), title: "Ship the sidebar" },
      },
      loaded: { task1: true },
    })) as unknown as StoreApi<KodworkState>;
    return { projects, work };
  };

  it("renders one row per workspace with no KödChat or KödWork labels", () => {
    const { projects, work } = projectsWithEverything();
    const host = render(
      <WorkspacesSection
        projectsStore={projects}
        chatThreadsStore={emptyChatStore()}
        workStore={work}
        activity={createActivityModule()}
      />,
    );

    expect(host.querySelectorAll("[data-workspace-project]")).toHaveLength(2);
    // The chrome title already says "workspaces"; the section itself renders
    // no visible heading (a11y keeps the aria-label).
    expect(host.textContent).not.toContain("Workspaces");
    expect(host.querySelector('[aria-label="Workspaces"]')).not.toBeNull();
    expect(host.textContent).not.toContain("KödChat");
    expect(host.textContent).not.toContain("KödWork");
  });

  it("highlights the remembered session only in the active project", () => {
    // Every project remembers its own selection, but only the active
    // project's session is on screen — a highlighted row under every expanded
    // project reads as several open windows at once.
    const { projects, work } = projectsWithEverything();
    projects.setState({
      expandedProjects: { p1: true, p2: true },
      activeSessionByProject: { p1: "c1", p2: "c2" },
    } as Partial<ProjectsState>);
    const host = render(
      <WorkspacesSection
        projectsStore={projects}
        chatThreadsStore={emptyChatStore()}
        workStore={work}
        activity={createActivityModule()}
      />,
    );

    const current = [...host.querySelectorAll('[aria-current="true"]')];
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("claude 1");
  });

  it("lists an expanded workspace's chats, terminals, and tasks together", () => {
    const { projects, work } = projectsWithEverything();
    const host = render(
      <WorkspacesSection
        projectsStore={projects}
        chatThreadsStore={emptyChatStore()}
        workStore={work}
        activity={createActivityModule()}
      />,
    );

    const open = host.querySelector('[data-workspace-sessions="p1"]')!;
    expect(open).not.toBeNull();
    expect(open.querySelector("button[data-thread-state]")?.textContent).toContain(
      "claude 1",
    );
    const terminals = [
      ...open.querySelectorAll("button[data-terminal-state]"),
    ].map((button) => button.textContent);
    expect(terminals.some((label) => label?.includes("zsh split"))).toBe(true);
    expect(open.querySelector("button[data-task-group]")?.textContent).toContain(
      "Ship the sidebar",
    );
    // A collapsed workspace lists nothing.
    expect(host.querySelector('[data-workspace-sessions="p2"]')).toBeNull();
  });

  it("names the chevron for sessions, not chats — the one v1 string divergence", () => {
    const { projects, work } = projectsWithEverything();
    const host = render(
      <WorkspacesSection
        projectsStore={projects}
        chatThreadsStore={emptyChatStore()}
        workStore={work}
        activity={createActivityModule()}
      />,
    );

    const chevrons = [...host.querySelectorAll("button[aria-expanded]")].map(
      (button) => button.getAttribute("aria-label"),
    );
    expect(chevrons).toContain("Collapse kodade sessions");
    expect(chevrons).toContain("Expand docs sessions");
    expect(chevrons.some((label) => label?.includes("chats"))).toBe(false);
  });

  it("shows no task rows and excludes work sessions from the count on a build without KödWork", () => {
    const { projects, work } = projectsWithEverything();
    const host = render(
      <WorkspacesSection
        projectsStore={projects}
        chatThreadsStore={emptyChatStore()}
        workStore={work}
        activity={createActivityModule()}
        manifest={{
          ...RELEASE_MANIFEST,
          features: { ...RELEASE_MANIFEST.features, work: false },
        }}
      />,
    );

    expect(host.querySelectorAll("button[data-task-group]")).toHaveLength(0);
    expect(host.textContent).not.toContain("Ship the sidebar");
    // 1 chat + 1 terminal + 1 split; the work session is not counted.
    const count = host.querySelector(
      '[data-workspace-project="p1"] button[aria-label="Open kodade project"] span:last-child',
    );
    expect(count?.textContent).toBe("3");
  });

  it("renders no session container for an expanded, empty workspace", () => {
    const projects = createStore(() => ({
      projects: [{ id: "p1", name: "kodade", path: "/repo" }],
      sessions: [],
      expandedProjects: { p1: true },
      activeProjectId: "p1",
      activeSessionByProject: {},
    })) as unknown as StoreApi<ProjectsState>;
    const host = render(
      <WorkspacesSection
        projectsStore={projects}
        chatThreadsStore={emptyChatStore()}
        workStore={createStore(() => ({ tasks: {}, loaded: {} })) as unknown as StoreApi<KodworkState>}
        activity={createActivityModule()}
      />,
    );

    expect(host.querySelector("[data-workspace-sessions]")).toBeNull();
  });
});

// Minimal stand-in for the terminal registry: this suite never inspects PTY
// I/O, it only needs addProject()'s auto-open to resolve.
function fakeRegistry() {
  return {
    open: () => {},
    close: async () => {},
    write: () => {},
  };
}

async function setupLiveSection() {
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
  // addProject() force-expands the project it activates; force /repo-a closed
  // so its row exercises a real closed -> open transition.
  const project = projectsStore
    .getState()
    .projects.find((p) => p.path === "/repo-a")!;
  projectsStore.getState().toggleProjectExpanded(project.id);

  const work = createStore(() => ({ tasks: {}, loaded: {} })) as unknown as StoreApi<KodworkState>;
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted = createRoot(host);
  await act(async () => {
    mounted?.render(
      <WorkspacesSection
        projectsStore={projectsStore}
        chatThreadsStore={emptyChatStore()}
        workStore={work}
        activity={createActivityModule()}
      />,
    );
  });
  return { host, projectsStore, project };
}

describe("workspace row click expands (#60, carried into v2)", () => {
  it("clicking the row expands it and makes it active", async () => {
    const { host, projectsStore, project } = await setupLiveSection();
    const nameButton = host.querySelector(
      `[data-workspace-project="${project.id}"] button[aria-label="Open ${project.name} project"]`,
    ) as HTMLButtonElement;
    expect(nameButton.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      nameButton.click();
    });

    expect(projectsStore.getState().expandedProjects[project.id]).toBe(true);
    expect(projectsStore.getState().activeProjectId).toBe(project.id);
    expect(nameButton.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking an already-expanded, active row collapses it", async () => {
    const { host, projectsStore, project } = await setupLiveSection();
    const nameButton = host.querySelector(
      `[data-workspace-project="${project.id}"] button[aria-label="Open ${project.name} project"]`,
    ) as HTMLButtonElement;

    await act(async () => {
      nameButton.click();
    });
    expect(projectsStore.getState().expandedProjects[project.id]).toBe(true);

    // setActiveProject force-expands on every call, so the collapse path has
    // to reconcile after it resolves — the async race #60 fixed.
    await act(async () => {
      nameButton.click();
    });
    expect(projectsStore.getState().expandedProjects[project.id]).toBe(false);
    expect(projectsStore.getState().activeProjectId).toBe(project.id);
    expect(nameButton.getAttribute("aria-expanded")).toBe("false");
  });
});
