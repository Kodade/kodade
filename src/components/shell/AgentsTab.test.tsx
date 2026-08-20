// The v2 Agents tab (#64, slice 2): persona rail + editor CRUD, the skills
// multi-select, and launching a run through the existing work-store path. The
// stores are injected (a real agents store over MockStorage; fakes for the
// project/work/harness seams) so the tab is exercised without app singletons.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockStorage } from "../../ipc/mock";
import { RELEASE_MANIFEST } from "../../release/manifest";
import { createPersonaStore, type PersonaScope } from "../../agents/persona-store";
import { createAgentsStore } from "../../agents/agents-store";
import type { KodworkState } from "../../kodwork/store";
import type { HarnessState } from "../../store/harness";
import type { ProjectsState } from "../../store/projects";
import { AgentsTab } from "./AgentsTab";

const APP: PersonaScope = { kind: "app" };

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
});

function agents() {
  const storage = new MockStorage();
  let seq = 0;
  const personaStore = createPersonaStore({
    storage,
    newId: () => `id-${++seq}`,
    now: () => 1000,
  });
  return { storage, store: createAgentsStore({ store: personaStore }) };
}

function fakeProjects(overrides: Partial<Record<string, unknown>> = {}) {
  return createStore(() => ({
    projects: [{ id: "p1", name: "Kodade", path: "/repo" }],
    activeProjectId: "p1",
    setActiveProject: vi.fn(async () => {}),
    addWorkSession: vi.fn(() => "task-1"),
    ...overrides,
  })) as unknown as StoreApi<ProjectsState>;
}

function fakeWork() {
  return createStore(() => ({
    tasks: {},
    openTask: vi.fn(async () => {}),
    setProvider: vi.fn(() => {}),
    setOutcome: vi.fn(() => {}),
  })) as unknown as StoreApi<KodworkState>;
}

function fakeHarness(kodSkills: unknown = null) {
  return createStore(() => ({
    kodSkills,
    loadKodSkills: vi.fn(async () => {}),
  })) as unknown as StoreApi<HarnessState>;
}

const WORK_MANIFEST = {
  ...RELEASE_MANIFEST,
  features: { ...RELEASE_MANIFEST.features, work: true },
};

async function render(
  node: React.ReactElement,
): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted = createRoot(host);
  await act(async () => {
    mounted?.render(node);
  });
  return host;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!match) throw new Error(`no button with text "${text}"`);
  return match as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

// Set a controlled input/textarea's value the way React's tracker expects.
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AgentsTab", () => {
  it("renders both scope groups and their empty states", async () => {
    const { store } = agents();
    const host = await render(
      <AgentsTab
        store={store}
        workStore={fakeWork()}
        projectsStore={fakeProjects()}
        harness={fakeHarness()}
        manifest={WORK_MANIFEST}
      />,
    );
    expect(host.querySelector('[data-testid="persona-rail"]')).not.toBeNull();
    expect(host.querySelector('[data-persona-scope="app"]')).not.toBeNull();
    expect(host.querySelector('[data-persona-scope="project:p1"]')).not.toBeNull();
    expect(host.textContent).toContain("No personas yet.");
  });

  it("creates a persona from the app scope with default values", async () => {
    const { store } = agents();
    const host = await render(
      <AgentsTab
        store={store}
        workStore={fakeWork()}
        projectsStore={fakeProjects()}
        harness={fakeHarness()}
        manifest={WORK_MANIFEST}
      />,
    );
    await click(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="New persona for All projects"]',
      )!,
    );
    expect(host.textContent).toContain("New agent");
    await click(button(host, "Create"));

    // Persisted with the clamped default name, and shown in the app group.
    expect(store.getState().personasFor(APP)).toHaveLength(1);
    expect(store.getState().personasFor(APP)[0].name).toBe("New persona");
    const appGroup = host.querySelector('[data-persona-scope="app"]')!;
    expect(appGroup.textContent).toContain("New persona");
  });

  it("edits a persona's name and saves it", async () => {
    const { store } = agents();
    await store.getState().load();
    const made = await store.getState().createPersona(APP, {
      providerId: "claude",
      name: "Reviewer",
    });
    const host = await render(
      <AgentsTab
        store={store}
        workStore={fakeWork()}
        projectsStore={fakeProjects()}
        harness={fakeHarness()}
        manifest={WORK_MANIFEST}
      />,
    );
    await click(host.querySelector<HTMLButtonElement>(`[data-persona-id="${made!.id}"]`)!);
    expect(host.textContent).toContain("Edit agent");

    const name = host.querySelector<HTMLInputElement>("#persona-name")!;
    expect(name.value).toBe("Reviewer");
    await type(name, "Senior reviewer");
    await click(button(host, "Save"));

    expect(store.getState().getPersona(APP, made!.id)?.name).toBe("Senior reviewer");
  });

  it("deletes the selected persona", async () => {
    const { store } = agents();
    await store.getState().load();
    const made = await store.getState().createPersona(APP, {
      providerId: "claude",
      name: "Throwaway",
    });
    const host = await render(
      <AgentsTab
        store={store}
        workStore={fakeWork()}
        projectsStore={fakeProjects()}
        harness={fakeHarness()}
        manifest={WORK_MANIFEST}
      />,
    );
    await click(host.querySelector<HTMLButtonElement>(`[data-persona-id="${made!.id}"]`)!);
    await click(button(host, "Delete"));

    expect(store.getState().personasFor(APP)).toStrictEqual([]);
    // Back to the empty run/editor state.
    expect(host.querySelector(`[data-persona-id="${made!.id}"]`)).toBeNull();
  });

  it("lists installed KödSkills and stores a toggled id on create", async () => {
    const { store } = agents();
    const harness = fakeHarness({
      pack: {
        skills: [
          { id: "code-review", description: "reviews code" },
          { id: "release-notes", description: "" },
        ],
      },
    });
    const host = await render(
      <AgentsTab
        store={store}
        workStore={fakeWork()}
        projectsStore={fakeProjects()}
        harness={harness}
        manifest={WORK_MANIFEST}
      />,
    );
    await click(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="New persona for All projects"]',
      )!,
    );
    const checkboxes = host.querySelectorAll<HTMLInputElement>(
      'fieldset input[type="checkbox"]',
    );
    expect(checkboxes).toHaveLength(2);
    await click(checkboxes[0]);
    await click(button(host, "Create"));

    expect(store.getState().personasFor(APP)[0].skills).toStrictEqual(["code-review"]);
  });

  it("launches a run from the editor through the work store", async () => {
    const { store } = agents();
    await store.getState().load();
    const made = await store.getState().createPersona(APP, {
      providerId: "claude",
      name: "Reviewer",
      prompt: "Review the code",
    });
    const work = fakeWork();
    const projects = fakeProjects();
    const host = await render(
      <AgentsTab
        store={store}
        workStore={work}
        projectsStore={projects}
        harness={fakeHarness()}
        manifest={WORK_MANIFEST}
      />,
    );
    await click(host.querySelector<HTMLButtonElement>(`[data-persona-id="${made!.id}"]`)!);
    await click(button(host, "Run agent"));

    expect(projects.getState().addWorkSession).toHaveBeenCalledWith("p1");
    expect(work.getState().openTask).toHaveBeenCalledWith("task-1", "p1");
    expect(work.getState().setProvider).toHaveBeenCalledWith("task-1", "claude");
    expect(work.getState().setOutcome).toHaveBeenCalledWith("task-1", "Review the code");
    expect(store.getState().selectedRunTaskId).toBe("task-1");
    // The editor gave way to the run area (KodworkPane, here with no task doc).
    expect(host.textContent).toContain("no longer open");
  });
});
