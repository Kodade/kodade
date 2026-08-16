import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { afterEach, describe, expect, it } from "vitest";
import { createActivityModule } from "../../activity/activity";
import { newTask } from "../../kodwork/model";
import type { KodworkState } from "../../kodwork/store";
import type { ProjectsState } from "../../store/projects";
import { KodworkSection } from "./KodworkSection";

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
});
