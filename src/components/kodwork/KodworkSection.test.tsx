import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActivityModule } from "../../activity/activity";
import { newTask } from "../../kodwork/model";
import type { KodworkState } from "../../kodwork/store";
import { filesStore } from "../../store/appStore";
import type { ProjectsState } from "../../store/projects";
import { KodworkSection } from "./KodworkSection";
import { KodworkPane } from "./KodworkPane";

function stores() {
  const projects = createStore(() => ({
    projects: [{ id: "p1", name: "kodade", path: "/repo" }],
    sessions: [
      { id: "working", projectId: "p1", name: "work", kind: "work" as const },
      { id: "waiting", projectId: "p1", name: "work", kind: "work" as const },
      { id: "settled", projectId: "p1", name: "work", kind: "work" as const },
    ],
    expandedProjects: { p1: true },
    activeProjectId: "p1",
  })) as unknown as StoreApi<ProjectsState>;
  const working = {
    ...newTask("working", "p1", "/repo", "claude", 1),
    title: "Build feature",
    state: "running" as const,
  };
  const waiting = {
    ...newTask("waiting", "p1", "/repo", "codex", 1),
    title: "Review output",
    state: "needs-user" as const,
  };
  const settled = {
    ...newTask("settled", "p1", "/repo", "claude", 1),
    title: "Finished task",
    state: "done" as const,
  };
  const work = createStore(() => ({
    tasks: { working, waiting, settled },
    loaded: { working: true, waiting: true, settled: true },
  })) as unknown as StoreApi<KodworkState>;
  return { projects, work };
}

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("KodworkSection", () => {
  it("keeps a many-project zero-task state compact and gives the active project an explicit target", () => {
    const projectList = Array.from({ length: 12 }, (_, index) => ({
      id: `p${index}`,
      name: `project ${index}`,
      path: `/repo/${index}`,
    }));
    const projects = createStore(() => ({
      projects: projectList,
      sessions: [],
      expandedProjects: {},
      activeProjectId: "p7",
    })) as unknown as StoreApi<ProjectsState>;
    const work = createStore(() => ({ tasks: {}, loaded: {} })) as unknown as StoreApi<KodworkState>;
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);

    act(() =>
      mounted?.render(
        <KodworkSection
          projectsStore={projects}
          workStore={work}
          activity={createActivityModule()}
        />,
      ),
    );

    expect(host.textContent).toContain("outcome-based background tasks");
    expect(host.querySelectorAll("[data-kodwork-project]")).toHaveLength(0);
    expect(host.querySelector('button[aria-label="New KödWork task"]')).not.toBeNull();
    expect(host.querySelectorAll('button[aria-label="New KödWork task"]')).toHaveLength(1);
    const target = host.querySelector<HTMLSelectElement>('select[aria-label="Target project"]');
    expect(target?.value).toBe("p7");
    expect(target?.className).toContain("min-w-0");
  });

  it("keeps target controls on one non-overflowing row in a narrow sidebar", () => {
    const projects = createStore(() => ({
      projects: [{ id: "p1", name: "A very long project name", path: "/repo" }],
      sessions: [],
      expandedProjects: {},
      activeProjectId: "p1",
    })) as unknown as StoreApi<ProjectsState>;
    const work = createStore(() => ({ tasks: {}, loaded: {} })) as unknown as StoreApi<KodworkState>;
    const host = document.createElement("div");
    host.style.width = "180px";
    document.body.appendChild(host);
    mounted = createRoot(host);

    act(() =>
      mounted?.render(
        <KodworkSection
          projectsStore={projects}
          workStore={work}
          activity={createActivityModule()}
        />,
      ),
    );

    const header = host.querySelector('[data-testid="kodwork-header"]');
    const controls = host.querySelector('[data-testid="kodwork-controls"]');
    expect(header?.className).toContain("grid");
    expect(controls?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(controls?.querySelectorAll("select, button")).toHaveLength(2);
    expect(controls?.querySelector("select")?.className).toContain("w-full");
    expect(controls?.querySelector("button")?.className).toContain("shrink-0");
  });

  it("requires a target-project selection when no project is active", () => {
    const projects = createStore(() => ({
      projects: [{ id: "p1", name: "kodade", path: "/repo" }],
      sessions: [],
      expandedProjects: {},
      activeProjectId: null,
    })) as unknown as StoreApi<ProjectsState>;
    const work = createStore(() => ({ tasks: {}, loaded: {} })) as unknown as StoreApi<KodworkState>;
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);

    act(() =>
      mounted?.render(
        <KodworkSection
          projectsStore={projects}
          workStore={work}
          activity={createActivityModule()}
        />,
      ),
    );

    expect(host.querySelector<HTMLButtonElement>('button[aria-label="New KödWork task"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Target project"]')?.value).toBe("");
  });

  it("creates and focuses a draft in the selected target project", async () => {
    let projects: StoreApi<ProjectsState>;
    const setActiveProject = vi.fn(async (projectId: string) => {
      projects.setState({ activeProjectId: projectId });
    });
    const addWorkSession = vi.fn((projectId: string) => {
      projects.setState((state) => ({
        sessions: [
          ...state.sessions,
          { id: "draft", projectId, name: "work", kind: "work" as const },
        ],
      }));
      return "draft";
    });
    projects = createStore(() => ({
      projects: [
        { id: "p1", name: "kodade", path: "/repo" },
        { id: "p2", name: "archive", path: "/archive" },
      ],
      sessions: [],
      expandedProjects: {},
      activeProjectId: "p1",
      setActiveProject,
      addWorkSession,
    })) as unknown as StoreApi<ProjectsState>;
    let work: StoreApi<KodworkState>;
    const openTask = vi.fn(async (taskId: string, projectId: string) => {
      work.setState({
        tasks: { [taskId]: newTask(taskId, projectId, "/archive", "claude", 1) },
      });
    });
    work = createStore(() => ({
      tasks: {},
      loaded: {},
      templates: [],
      templatesLoading: false,
      templatesError: null,
      openTask,
      loadTemplates: vi.fn(),
    })) as unknown as StoreApi<KodworkState>;
    filesStore.setState({ rootPath: "/archive" });
    vi.spyOn(filesStore.getState(), "openKodworkTab").mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);

    act(() =>
      mounted?.render(
        <>
          <KodworkSection
            projectsStore={projects}
            workStore={work}
            activity={createActivityModule()}
          />
          <KodworkPane taskId="draft" workStore={work} />
        </>,
      ),
    );
    const target = host.querySelector<HTMLSelectElement>('select[aria-label="Target project"]')!;
    act(() => {
      target.value = "p2";
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="New KödWork task"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(setActiveProject).toHaveBeenCalledWith("p2");
    expect(addWorkSession).toHaveBeenCalledWith("p2");
    expect(projects.getState().sessions.find((session) => session.id === "draft")?.projectId).toBe("p2");
    expect(work.getState().tasks.draft?.projectId).toBe("p2");
    expect(document.activeElement).toBe(
      host.querySelector('[data-voice-target="kodwork-outcome"]'),
    );
  });

  it("adopts the active project when projects finish loading", () => {
    const projects = createStore(() => ({
      projects: [] as ProjectsState["projects"],
      sessions: [],
      expandedProjects: {},
      activeProjectId: null as string | null,
    })) as unknown as StoreApi<ProjectsState>;
    const work = createStore(() => ({ tasks: {}, loaded: {} })) as unknown as StoreApi<KodworkState>;
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);

    act(() =>
      mounted?.render(
        <KodworkSection
          projectsStore={projects}
          workStore={work}
          activity={createActivityModule()}
        />,
      ),
    );
    act(() =>
      projects.setState({
        projects: [{ id: "p1", name: "kodade", path: "/repo" }],
        activeProjectId: "p1",
      }),
    );

    expect(
      host.querySelector<HTMLSelectElement>('select[aria-label="Target project"]')
        ?.value,
    ).toBe("p1");
  });

  it("shows only task-bearing projects once work exists", () => {
    const { projects, work } = stores();
    projects.setState({
      projects: [
        { id: "p1", name: "kodade", path: "/repo" },
        { id: "p2", name: "archive", path: "/archive" },
      ],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);

    act(() =>
      mounted?.render(
        <KodworkSection
          projectsStore={projects}
          workStore={work}
          activity={createActivityModule()}
        />,
      ),
    );

    expect(host.querySelector('[data-kodwork-project="p1"]')).not.toBeNull();
    expect(host.querySelector('[data-kodwork-project="p2"]')).toBeNull();
  });

  it("groups task sessions into needs-you, working, and settled inbox lanes", () => {
    const { projects, work } = stores();
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() =>
      mounted?.render(
        <KodworkSection
          projectsStore={projects}
          workStore={work}
          activity={createActivityModule()}
        />,
      ),
    );

    expect(host.textContent).toContain("KödWork");
    expect(host.textContent).toContain("Build feature");
    expect(host.textContent).toContain("Review output");
    expect(host.querySelector('[data-task-group="working"]')).not.toBeNull();
    expect(host.querySelector('[data-task-group="needs-user"]')).not.toBeNull();
    expect(host.querySelector('[data-task-group="settled"]')).not.toBeNull();
  });

  it("renders green for working and red for needs-user or settled lanes — no other dot color (#59)", () => {
    const { projects, work } = stores();
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted = createRoot(host);
    act(() =>
      mounted?.render(
        <KodworkSection
          projectsStore={projects}
          workStore={work}
          activity={createActivityModule()}
        />,
      ),
    );

    const working = host.querySelector('[data-task-group="working"]');
    const needsUser = host.querySelector('[data-task-group="needs-user"]');
    const settled = host.querySelector('[data-task-group="settled"]');
    const workingDot = working?.querySelector<HTMLElement>(".rounded-full");
    const needsUserDot = needsUser?.querySelector<HTMLElement>(".rounded-full");
    const settledDot = settled?.querySelector<HTMLElement>(".rounded-full");
    expect(workingDot?.className).toContain("kd-dot-pulse");
    expect(workingDot?.className).toContain("bg-emerald-400");
    expect(workingDot?.className).not.toContain("bg-accent");
    expect(workingDot?.className).not.toContain("bg-text-dim");
    expect(needsUserDot?.className).toContain("bg-red-400");
    expect(needsUserDot?.className).not.toContain("bg-accent");
    expect(needsUserDot?.className).not.toContain("bg-text-dim");
    expect(settledDot?.className).toContain("bg-red-400");
    expect(settledDot?.className).not.toContain("bg-accent");
    expect(settledDot?.className).not.toContain("bg-text-dim");
    expect(settled?.querySelector(".bg-red-400")).not.toBeNull();
  });
});
