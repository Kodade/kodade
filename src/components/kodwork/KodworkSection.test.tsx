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
  const work = createStore(() => ({
    tasks: { working, waiting },
    loaded: { working: true, waiting: true },
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
  it("groups task sessions into working and needs-you inbox lanes", () => {
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
  });
});
