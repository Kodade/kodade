import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_ACTIVITY_MS,
  STABILITY_WINDOW_MS,
  createActivityModule,
  type WorkspaceView,
} from "../activity/activity";
import {
  FullWorkspaceProjection,
  FullWorkspaceSidebar,
  ProjectRail,
  ProjectsSidebar,
  projectWorkspaceView,
} from "./ProjectsSidebar";
import { activityModule, appStore, registry } from "../store/appStore";
import { tauriMemory } from "../ipc/memory";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function replayWorkspace(
  reducedMotion = false,
  selectedSessionId: "working" | null = null,
): WorkspaceView {
  const activity = createActivityModule({ reducedMotion, now: () => 0 });
  for (const event of [
    { type: "project-added" as const, at: 0, projectId: "kodade", projectName: "Kodade" },
    { type: "project-added" as const, at: 0, projectId: "website", projectName: "Website" },
    { type: "session-created" as const, at: 0, projectId: "kodade", sessionId: "attention", name: "Fix the sidebar" },
    { type: "session-created" as const, at: 0, projectId: "website", sessionId: "working", name: "Codex implementation" },
    { type: "session-created" as const, at: 0, projectId: "website", sessionId: "settled", name: "Release plan" },
    { type: "terminal-foreground" as const, at: 1, projectId: "website", sessionId: "working", process: "codex" },
    { type: "attention-reported" as const, at: 2, projectId: "kodade", sessionId: "attention", attention: "needs-user" as const, provenance: "mcp" as const, reason: "Choose the card layout" },
    { type: "terminal-exited" as const, at: 3, projectId: "website", sessionId: "settled", code: 0 },
  ]) activity.observe(event);
  if (selectedSessionId) {
    activity.observe({
      type: "session-selected",
      at: 4,
      projectId: "website",
      sessionId: selectedSessionId,
    });
  }
  return activity.workspaceView(RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS + 3);
}

const workspaceView = replayWorkspace();

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let restoreAppStore: (() => void) | null = null;
let restoreActivityModule: (() => void) | null = null;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document
    .querySelectorAll("[data-test-rail-outside]")
    .forEach((node) => node.remove());
  restoreAppStore?.();
  restoreAppStore = null;
  restoreActivityModule?.();
  restoreActivityModule = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function renderSidebar({
  view = workspaceView,
  projects = [
    { id: "kodade", name: "Kodade", path: "/repos/kodade" },
    { id: "website", name: "Website", path: "/repos/website" },
    { id: "archive", name: "Archive", path: "/repos/archive" },
  ],
}: {
  view?: WorkspaceView;
  projects?: Array<{ id: string; name: string; path: string }>;
} = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const actions = {
    activateSession: vi.fn(),
    setActiveProject: vi.fn(),
    addProject: vi.fn(),
    addSession: vi.fn(),
    renameSession: vi.fn(),
    closeSession: vi.fn(),
    closeWorkspace: vi.fn(),
    clearSettledWorkspaces: vi.fn(),
    setProjectColor: vi.fn(),
    removeProject: vi.fn(),
  };
  await act(async () =>
    root?.render(
      <FullWorkspaceSidebar
        view={view}
        projects={projects}
        activeProjectId="website"
        appearance="dark"
        actions={actions}
      />,
    ),
  );
  return actions;
}

async function renderStoreBackedRail() {
  const previousState = appStore.getState();
  restoreAppStore = () => appStore.setState(previousState, true);
  appStore.setState({
    projects: [
      {
        id: "rail",
        name: "Rail project",
        path: "/repos/rail",
        color: "teal",
      },
    ],
    sessions: [],
    activeProjectId: null,
    sidebarMode: "rail",
  });
  const railContainer = document.createElement("div");
  container = railContainer;
  document.body.appendChild(railContainer);
  root = createRoot(railContainer);
  await act(async () => root?.render(<ProjectsSidebar />));
  return {
    railContainer,
    opener: railContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Rail project"]',
    ),
  };
}

async function openRailColorMenu(opener: HTMLButtonElement | null) {
  await act(async () =>
    opener?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 12,
        clientY: 14,
      }),
    ),
  );
}

describe("ProjectsSidebar adaptive workspace seam", () => {
  it("keeps a zero-session project actionable from the KödChat list", async () => {
    // The KödChat section is the sidebar's one project list now, so a project
    // with no sessions still gets open, new-chat, color, and remove there.
    const previousState = appStore.getState();
    restoreAppStore = () => appStore.setState(previousState, true);
    vi.spyOn(registry, "open").mockResolvedValue(undefined);
    vi.spyOn(registry, "close").mockResolvedValue(undefined);
    vi.spyOn(tauriMemory, "resolveWorkspace").mockResolvedValue(null);
    await appStore.getState().hydrate().catch(() => undefined);
    appStore.setState({
      projects: [{ id: "archive", name: "Archive", path: "/repos/archive" }],
      sessions: [],
      activeProjectId: null,
      activeSessionByProject: {},
      sidebarMode: "full",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<ProjectsSidebar />));

    const openProject = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Archive project"]',
    );
    const projectRow = container?.querySelector<HTMLElement>(
      '[data-workspace-project="archive"]',
    );
    const newChat = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="New chat in Archive"]',
    );
    const remove = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Archive project"]',
    );

    expect(openProject).not.toBeNull();
    expect(projectRow).not.toBeNull();
    expect(newChat).not.toBeNull();
    expect(remove).not.toBeNull();
    expect(container?.querySelector('[aria-label^="New session"]')).toBeNull();

    await act(async () => {
      openProject?.click();
    });
    expect(appStore.getState().activeProjectId).toBe("archive");

    await act(async () => {
      projectRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    const colorAction = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Project color for Archive"]',
    );
    expect(colorAction).not.toBeNull();
    await act(async () => {
      colorAction?.click();
    });
    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>('button[aria-label="Teal"]')
        ?.click(),
    );
    expect(appStore.getState().projects[0]?.color).toBe("teal");

    await act(async () => remove?.click());
    expect(appStore.getState().projects).toHaveLength(0);
  });

  it("closes a chat thread from its sidebar row", async () => {
    const previousState = appStore.getState();
    restoreAppStore = () => appStore.setState(previousState, true);
    await appStore.getState().hydrate().catch(() => undefined);
    appStore.setState({
      projects: [{ id: "kodade", name: "Kodade", path: "/repos/kodade" }],
      sessions: [],
      activeProjectId: "kodade",
      activeSessionByProject: {},
      expandedProjects: { kodade: true },
      sidebarMode: "full",
    });
    const threadId = appStore.getState().addChatThread("kodade", "claude");
    expect(threadId).not.toBeNull();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<ProjectsSidebar />));

    const close = container?.querySelector<HTMLButtonElement>(
      // An empty thread is labelled "New chat", never "claude 1" (issue #6).
      'button[aria-label="Close chat New chat"]',
    );
    expect(close).not.toBeNull();
    await act(async () => close?.click());
    expect(
      appStore.getState().sessions.some((session) => session.id === threadId),
    ).toBe(false);
  });

  it("uses a zero-session project disclosure with natural traversal and Escape focus return", async () => {
    const previousState = appStore.getState();
    restoreAppStore = () => appStore.setState(previousState, true);
    appStore.setState({
      projects: [{ id: "archive", name: "Archive", path: "/repos/archive" }],
      sessions: [],
      activeProjectId: null,
      activeSessionByProject: {},
      sidebarMode: "full",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<ProjectsSidebar />));
    const user = userEvent.setup({ document });
    const search = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Search workspaces"]',
    );
    const projectTrigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Archive project"]',
    );

    expect(search).not.toBeNull();
    expect(projectTrigger).not.toBeNull();
    expect(
      container?.querySelector("#workspace-project-actions-archive"),
    ).toBeNull();

    await act(async () => user.type(search!, "archive"));
    projectTrigger?.focus();
    await act(async () =>
      projectTrigger?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true }),
      ),
    );
    expect(
      container?.querySelector("#workspace-project-actions-archive"),
    ).not.toBeNull();

    const colorTrigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Project color for Archive"]',
    );
    expect(colorTrigger).not.toBeNull();
    expect(colorTrigger?.getAttribute("aria-controls")).toBe(
      "workspace-project-colors-archive",
    );

    await act(async () => user.click(colorTrigger!));
    expect(
      container?.querySelector("#workspace-project-colors-archive"),
    ).not.toBeNull();

    await user.tab();
    expect(document.activeElement).toBe(
      container?.querySelector('button[aria-label="Red"]'),
    );

    await act(async () => user.keyboard("{Escape}"));
    expect(search?.value).toBe("archive");
    expect(
      container?.querySelector("#workspace-project-colors-archive"),
    ).toBeNull();
    expect(
      container?.querySelector("#workspace-project-actions-archive"),
    ).toBeNull();
    expect(document.activeElement).toBe(projectTrigger);
  });

  it("renders theme-aware full-mode swatches and returns focus after color selection", async () => {
    const actions = await renderSidebar();
    const sessionTrigger = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="working"]',
    );

    await act(async () =>
      sessionTrigger?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true }),
      ),
    );
    const sessionColorTrigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Project color for Website"]',
    );
    expect(sessionColorTrigger?.getAttribute("aria-controls")).toBe(
      "workspace-session-colors-working",
    );
    await act(async () => sessionColorTrigger?.click());
    expect(
      container?.querySelector("#workspace-session-colors-working"),
    ).not.toBeNull();
    const darkRedSwatch = container?.querySelector<HTMLElement>(
      '#workspace-session-colors-working button[aria-label="Red"] [data-project-color-swatch]',
    );
    expect(darkRedSwatch?.style.backgroundColor).toBe("#D96C75");

    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>(
          '#workspace-session-colors-working button[aria-label="Teal"]',
        )
        ?.click(),
    );
    expect(actions.setProjectColor).toHaveBeenCalledWith("website", "teal");
    expect(
      container?.querySelector("#workspace-session-colors-working"),
    ).toBeNull();
    expect(document.activeElement).toBe(sessionColorTrigger);

    await act(async () =>
      root?.render(
        <FullWorkspaceSidebar
          view={workspaceView}
          projects={[
            { id: "kodade", name: "Kodade", path: "/repos/kodade" },
            { id: "website", name: "Website", path: "/repos/website" },
            { id: "archive", name: "Archive", path: "/repos/archive" },
          ]}
          activeProjectId="website"
          appearance="light"
          actions={actions}
        />,
      ),
    );
    // Light appearance re-skins the same shared swatches (session card path —
    // the zero-session project rows now live in the KödChat section).
    const lightSessionTrigger = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="working"]',
    );
    await act(async () =>
      lightSessionTrigger?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true }),
      ),
    );
    const lightColorTrigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Project color for Website"]',
    );
    await act(async () => lightColorTrigger?.click());
    const lightRedSwatch = container?.querySelector<HTMLElement>(
      '#workspace-session-colors-working button[aria-label="Red"] [data-project-color-swatch]',
    );
    expect(lightRedSwatch?.style.backgroundColor).toBe("#C53645");

    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>(
          '#workspace-session-colors-working button[aria-label="Auto color"]',
        )
        ?.click(),
    );
    expect(actions.setProjectColor).toHaveBeenCalledWith("website", null);
    expect(
      container?.querySelector("#workspace-session-colors-working"),
    ).toBeNull();
    expect(document.activeElement).toBe(lightColorTrigger);
  });

  it("retains the compact project rail, running state, and an icon-only settings entry", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <ProjectRail
          projects={[{ id: "rail", name: "Rail project", path: "/repos/rail" }]}
          sessions={[
            {
              id: "rail-session",
              projectId: "rail",
              name: "zsh 1",
              autoName: "codex",
            },
          ]}
          activeProjectId="rail"
          appearance="dark"
          onAddProject={async () => undefined}
          onOpenColorMenu={vi.fn()}
        />,
      ),
    );

    expect(container.querySelector('nav[aria-label="Projects"]')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Rail project (active)"] .kd-dot-pulse'),
    ).not.toBeNull();
    expect(container.querySelector('button[aria-label="Add project"]')).not.toBeNull();
    const railSettings = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Settings"]',
    );
    expect(railSettings).not.toBeNull();
    expect(railSettings?.textContent).toBe("");
  });

  it("opens the rail color menu from a context event and returns focus on Escape", async () => {
    const { railContainer, opener } = await renderStoreBackedRail();

    expect(opener?.getAttribute("aria-haspopup")).toBe("menu");
    expect(opener?.getAttribute("aria-controls")).toBe(
      "project-color-menu-rail",
    );
    expect(opener?.getAttribute("aria-expanded")).toBe("false");

    await openRailColorMenu(opener);
    const menu = railContainer.querySelector<HTMLElement>(
      '#project-color-menu-rail[role="menu"]',
    );
    const selected = menu?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    expect(opener?.getAttribute("aria-expanded")).toBe("true");
    expect(menu).not.toBeNull();
    expect(selected?.getAttribute("aria-label")).toBe("Teal");
    expect(document.activeElement).toBe(selected);

    const user = userEvent.setup({ document });
    const globalKeydown = vi.fn();
    window.addEventListener("keydown", globalKeydown);
    await act(async () => user.keyboard("{Escape}"));
    window.removeEventListener("keydown", globalKeydown);
    expect(railContainer.querySelector('[role="menu"]')).toBeNull();
    expect(opener?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(opener);
    expect(globalKeydown).not.toHaveBeenCalled();
  });

  it("moves through the rail color menu with arrows, Home, and End", async () => {
    const { opener } = await renderStoreBackedRail();
    await openRailColorMenu(opener);
    const user = userEvent.setup({ document });

    await act(async () => user.keyboard("{ArrowDown}"));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(
      "Blue",
    );
    await act(async () => user.keyboard("{ArrowUp}"));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(
      "Teal",
    );
    await act(async () => user.keyboard("{Home}"));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(
      "Red",
    );
    await act(async () => user.keyboard("{End}"));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(
      "Auto color",
    );
  });

  it("returns focus to the rail project after a keyboard color selection", async () => {
    const { railContainer, opener } = await renderStoreBackedRail();
    await openRailColorMenu(opener);
    const user = userEvent.setup({ document });

    await act(async () => user.keyboard("{ArrowDown}"));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(
      "Blue",
    );
    await act(async () => user.keyboard("{Enter}"));

    expect(railContainer.querySelector('[role="menu"]')).toBeNull();
    expect(appStore.getState().projects[0]?.color).toBe("blue");
    expect(document.activeElement).toBe(opener);
  });

  it("opens the rail color menu from the keyboard and preserves click-away focus", async () => {
    const { railContainer, opener } = await renderStoreBackedRail();
    const outside = document.createElement("button");
    outside.type = "button";
    outside.textContent = "Outside action";
    outside.dataset.testRailOutside = "";
    document.body.appendChild(outside);
    const user = userEvent.setup({ document });

    opener?.focus();
    await act(async () => user.keyboard("{Shift>}{F10}{/Shift}"));
    expect(railContainer.querySelector('[role="menu"]')).not.toBeNull();
    expect(
      (document.activeElement as HTMLElement).getAttribute("aria-label"),
    ).toBe("Teal");

    await act(async () => user.click(outside));
    expect(railContainer.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("renders named projection groups without density-specific card chrome", async () => {
    await renderSidebar();

    expect(container?.querySelector('nav[aria-label="Köd workspace"]')).not.toBeNull();
    expect(
      [...(container?.querySelectorAll("[data-workspace-group]") ?? [])].map(
        (group) => group.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Needs You, 1 session",
      "Working, 1 session",
      "Settled, 1 session",
    ]);
    expect(container?.querySelector('[data-density="expanded"]')).not.toBeNull();
    expect(container?.querySelector('[data-density="standard"]')).not.toBeNull();
    expect(container?.querySelector('[data-density="compact"]')).not.toBeNull();
    expect(container?.querySelector('[data-card-renderer]')).toBeNull();
  });

  it("keeps project and routine status metadata out of card copy", async () => {
    await renderSidebar();

    const occurrences = (card: Element | null | undefined, text: string) =>
      (card?.textContent ?? "").split(text).length - 1;
    const expanded = container?.querySelector('[data-density="expanded"]');
    const standard = container?.querySelector('[data-density="standard"]');
    const compact = container?.querySelector('[data-density="compact"]');

    expect(occurrences(expanded, "Kodade")).toBe(0);
    expect(occurrences(expanded, "Choose the card layout")).toBe(1);
    expect(occurrences(standard, "Website")).toBe(0);
    expect(occurrences(standard, "Working in codex")).toBe(0);
    expect(occurrences(compact, "Website")).toBe(0);
    expect(occurrences(compact, "Exited with code 0")).toBe(0);
  });

  it("keeps workspace cards quiet except for a real attention alert", async () => {
    await renderSidebar();

    const attention = container?.querySelector<HTMLElement>(
      '[data-workspace-session="attention"]',
    );
    const working = container?.querySelector<HTMLElement>(
      '[data-workspace-session="working"]',
    );
    const settled = container?.querySelector<HTMLElement>(
      '[data-workspace-session="settled"]',
    );

    expect(attention?.textContent).toContain("Fix the sidebar");
    expect(attention?.textContent).toContain("Choose the card layout");
    expect(working?.textContent).toBe("Codex implementation");
    expect(settled?.textContent).toBe("Release plan");
    expect(container?.querySelector("[data-session-indicator]")).toBeNull();
    expect(working?.textContent).not.toContain("Website");
    expect(working?.textContent).not.toContain("Working in codex");
  });

  it("derives unlocked workspace names by agent, foreground process, project, then counter", async () => {
    const activity = createActivityModule({ now: () => 0 });
    activity.observe({ type: "project-added", at: 0, projectId: "p", projectName: "kodade" });
    activity.observe({ type: "project-added", at: 0, projectId: "blank", projectName: "" });
    for (const [projectId, sessionId, name] of [
      ["p", "agent", "claude 1"],
      ["p", "process", "zsh 1"],
      ["p", "project", "zsh 2"],
      ["p", "locked", "Planning"],
      ["blank", "fallback", "zsh 1"],
    ] as const) {
      activity.observe({
        type: "session-created",
        at: 0,
        projectId,
        sessionId,
        name,
      });
    }
    activity.observe({
      type: "terminal-foreground",
      at: 1,
      projectId: "p",
      sessionId: "agent",
      process: "vite",
    });
    activity.observe({
      type: "terminal-foreground",
      at: 1,
      projectId: "p",
      sessionId: "process",
      process: "vitest",
    });

    const cards = projectWorkspaceView(
      activity,
      [
        { id: "agent", projectId: "p", name: "claude 1" },
        { id: "process", projectId: "p", name: "zsh 1" },
        { id: "project", projectId: "p", name: "zsh 2" },
        {
          id: "locked",
          projectId: "p",
          name: "Planning",
          nameLocked: true,
        },
        { id: "fallback", projectId: "blank", name: "zsh 1" },
      ],
      1,
    ).groups.flatMap((group) => group.sessions);

    expect(Object.fromEntries(cards.map((card) => [card.sessionId, card.name]))).toEqual({
      agent: "claude · kodade",
      process: "vitest · kodade",
      project: "kodade",
      locked: "Planning",
      fallback: "Workspace 1",
    });
  });

  it("projects split terminals as one selected workspace card", () => {
    const activity = createActivityModule({ now: () => 0 });
    activity.observe({ type: "project-added", at: 0, projectId: "p", projectName: "Project" });
    activity.observe({ type: "session-created", at: 0, projectId: "p", sessionId: "root", name: "zsh 1" });
    activity.observe({ type: "session-created", at: 0, projectId: "p", sessionId: "split", name: "zsh 2" });
    activity.observe({ type: "terminal-foreground", at: 1, projectId: "p", sessionId: "split", process: "codex" });
    activity.observe({ type: "session-selected", at: 2, projectId: "p", sessionId: "split" });

    const view = projectWorkspaceView(
      activity,
      [
        { id: "root", projectId: "p", name: "zsh 1" },
        { id: "split", projectId: "p", workspaceId: "root", name: "zsh 2" },
      ],
      2,
    );
    const cards = view.groups.flatMap((group) => group.sessions);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      sessionId: "root",
      name: "codex · Project",
      status: "working",
      selected: true,
    });
  });

  it("keeps remote-project terminals nested in Remote instead of workspace cards", () => {
    const activity = createActivityModule({ now: () => 0 });
    const projectId = "remote:box:%2Fsrv%2Fapp";
    activity.observe({
      type: "session-created",
      at: 0,
      projectId,
      sessionId: "remote-terminal",
      name: "ssh box 1",
    });

    const cards = projectWorkspaceView(
      activity,
      [
        {
          id: "remote-terminal",
          projectId,
          name: "ssh box 1",
          remote: true,
        },
      ],
      0,
    ).groups.flatMap((group) => group.sessions);

    expect(cards).toEqual([]);
  });

  it("shows workspace origin and creation time in the card tooltip", async () => {
    const activity = createActivityModule({ now: () => 0 });
    activity.observe({
      type: "project-added",
      at: 0,
      projectId: "p",
      projectName: "kodade",
    });
    activity.observe({
      type: "session-created",
      at: Date.UTC(2026, 6, 27, 13, 30),
      projectId: "p",
      sessionId: "origin",
      name: "zsh 1",
    });
    const view = projectWorkspaceView(
      activity,
      [{ id: "origin", projectId: "p", name: "zsh 1" }],
      Date.UTC(2026, 6, 27, 13, 30),
    );

    await renderSidebar({
      view,
      projects: [{ id: "p", name: "kodade", path: "studio:/repos/kodade" }],
    });

    expect(
      container
        ?.querySelector('[data-workspace-session="origin"]')
        ?.closest("article")
        ?.getAttribute("title"),
    ).toBe(
      `Terminal opened from studio:/repos/kodade · ${new Date(
        Date.UTC(2026, 6, 27, 13, 30),
      ).toLocaleString()}`,
    );
  });

  it("offers one action that clears every settled workspace", async () => {
    const actions = await renderSidebar();
    const clear = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear 1 settled workspace"]',
    );

    expect(clear).not.toBeNull();
    await act(async () => clear?.click());
    expect(actions.clearSettledWorkspaces).toHaveBeenCalledWith(["settled"]);
  });

  it("clears the settled group through the store-backed sidebar", async () => {
    const previousState = appStore.getState();
    restoreAppStore = () => appStore.setState(previousState, true);
    vi.useFakeTimers();
    const project = {
      id: "clear-settled",
      name: "Clear settled",
      path: "/repos/clear-settled",
    };
    vi.spyOn(registry, "open").mockResolvedValue(undefined);
    vi.spyOn(registry, "close").mockResolvedValue(undefined);
    activityModule.observe({
      type: "project-added",
      at: Date.now(),
      projectId: project.id,
      projectName: project.name,
    });
    restoreActivityModule = () =>
      activityModule.observe({
        type: "project-removed",
        at: Date.now(),
        projectId: project.id,
      });
    appStore.setState({
      projects: [project],
      sessions: [],
      activeProjectId: project.id,
      activeSessionByProject: {},
      sidebarMode: "full",
    });
    appStore.getState().addSession(project.id);
    appStore.getState().addSession(project.id);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<ProjectsSidebar />));

    const clear = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear 2 settled workspaces"]',
    );
    expect(clear).not.toBeNull();
    await act(async () => {
      clear?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      appStore
        .getState()
        .sessions.filter((session) => session.projectId === project.id),
    ).toEqual([]);
    expect(
      container.querySelector('[data-workspace-group="settled"]'),
    ).toBeNull();
  });

  it("refreshes the full projection for live activity and recency boundaries without unchanged commits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const activity = createActivityModule({ now: () => Date.now() });
    activity.observe({ type: "project-added", at: 0, projectId: "p", projectName: "Project" });
    activity.observe({ type: "session-created", at: 0, projectId: "p", sessionId: "s", name: "zsh 1" });
    let footerRenders = 0;
    const Footer = () => {
      footerRenders += 1;
      return <span data-testid="projection-render-count">{footerRenders}</span>;
    };
    const actions = {
      activateSession: vi.fn(),
      setActiveProject: vi.fn(),
      addProject: vi.fn(),
      addSession: vi.fn(),
      renameSession: vi.fn(),
      closeSession: vi.fn(),
      closeWorkspace: vi.fn(),
      clearSettledWorkspaces: vi.fn(),
      setProjectColor: vi.fn(),
      removeProject: vi.fn(),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <FullWorkspaceProjection
          activity={activity}
          sessions={[{ id: "s", projectId: "p", name: "zsh 1" }]}
          projects={[{ id: "p", name: "Project", path: "/repos/project" }]}
          activeProjectId="p"
          appearance="dark"
          actions={actions}
          footer={<Footer />}
        />,
      ),
    );

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(footerRenders).toBe(1);

    activity.observe({
      type: "terminal-foreground",
      at: Date.now(),
      projectId: "p",
      sessionId: "s",
      process: "codex",
    });
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.textContent).toContain("codex · Project");
    expect(container.textContent).not.toContain("Working in codex");

    activity.observe({
      type: "terminal-foreground",
      at: Date.now(),
      projectId: "p",
      sessionId: "s",
      process: null,
    });
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.textContent).not.toContain("Shell idle");
    await act(async () =>
      vi.advanceTimersByTime(RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS - 2_000),
    );
    expect(container.querySelector("[data-density=standard]")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.querySelector("[data-density=compact]")).not.toBeNull();

    await act(async () => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not mount a projection refresh in rail mode", async () => {
    vi.useFakeTimers();
    const { activityModule } = await import("../store/appStore");
    const view = vi.spyOn(activityModule, "workspaceView");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <ProjectRail
          projects={[{ id: "rail", name: "Rail", path: "/repos/rail" }]}
          sessions={[]}
          activeProjectId="rail"
          appearance="dark"
          onAddProject={async () => undefined}
          onOpenColorMenu={vi.fn()}
        />,
      ),
    );

    await act(async () => vi.advanceTimersByTime(5_000));
    expect(view).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("searches projected work by session, project, provider, and reliable status", async () => {
    await renderSidebar();
    const search = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Search workspaces"]',
    );
    expect(search).not.toBeNull();

    const searches: Array<[string, string[]]> = [
      ["release", ["settled"]],
      ["website", ["working", "settled"]],
      ["codex", ["working"]],
      ["exited with code 0", ["settled"]],
    ];
    for (const [query, sessionIds] of searches) {
      await act(async () => {
        if (!search) return;
        setInputValue(search, query);
      });
      expect(
        [...(container?.querySelectorAll("[data-workspace-session]") ?? [])].map(
          (card) => card.getAttribute("data-workspace-session"),
        ),
      ).toEqual(sessionIds);
    }
  });

  it("searches each raw M8a session status", async () => {
    const activity = createActivityModule({ now: () => 0 });
    for (const [index, status] of ["working", "idle", "exited", "failed"].entries()) {
      activity.observe({
        type: "project-added",
        at: 0,
        projectId: status,
        projectName: `Project ${index + 1}`,
      });
      activity.observe({
        type: "session-created",
        at: 0,
        projectId: status,
        sessionId: status,
        name: `Session ${index + 1}`,
      });
    }
    activity.observe({
      type: "terminal-foreground",
      at: 1,
      projectId: "working",
      sessionId: "working",
      process: "codex",
    });
    activity.observe({
      type: "terminal-exited",
      at: 1,
      projectId: "exited",
      sessionId: "exited",
      code: 0,
    });
    activity.observe({
      type: "terminal-exited",
      at: 1,
      projectId: "failed",
      sessionId: "failed",
      code: 1,
    });
    await renderSidebar({
      view: activity.workspaceView(RECENT_ACTIVITY_MS + STABILITY_WINDOW_MS + 1),
      projects: ["working", "idle", "exited", "failed"].map((id) => ({
        id,
        name: `Project ${id.length}`,
        path: `/repos/${id}`,
      })),
    });
    const search = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Search workspaces"]',
    );

    for (const status of ["working", "idle", "exited", "failed"]) {
      await act(async () => {
        if (search) setInputValue(search, status);
      });
      expect(
        [...(container?.querySelectorAll("[data-workspace-session]") ?? [])].map(
          (session) => session.getAttribute("data-workspace-session"),
        ),
      ).toContain(status);
    }
  });

  it("activates cards with Enter or Space and exposes selected and attention state", async () => {
    const actions = await renderSidebar({ view: replayWorkspace(false, "working") });
    const user = userEvent.setup({ document });
    const attention = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="attention"]',
    );
    const working = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="working"]',
    );
    const settled = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="settled"]',
    );
    expect(attention?.getAttribute("aria-label")).toContain("Needs your attention");
    expect(working?.getAttribute("aria-current")).toBe("true");

    attention?.focus();
    await user.keyboard("{Enter}");
    working?.focus();
    await user.keyboard(" ");
    settled?.focus();
    await user.keyboard("{Enter}");
    expect(actions.activateSession).toHaveBeenNthCalledWith(1, "kodade", "attention");
    expect(actions.activateSession).toHaveBeenNthCalledWith(2, "website", "working");
    expect(actions.activateSession).toHaveBeenNthCalledWith(3, "website", "settled");
  });

  it("keeps projected cards and their close controls focusable in a constrained DOM surface", async () => {
    await renderSidebar();
    if (container) container.style.width = "160px";
    expect(
      [...(container?.querySelectorAll("[data-workspace-session]") ?? [])].map(
        (card) => card.getAttribute("data-workspace-session"),
      ),
    ).toEqual(["attention", "working", "settled"]);

    const closeWorkspace = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Close workspace Release plan"]',
    );
    expect(closeWorkspace).not.toBeNull();
    closeWorkspace?.focus();
    expect(document.activeElement).toBe(closeWorkspace);
  });

  it("adds projects directly and Escape clears workspace search", async () => {
    const actions = await renderSidebar();
    const search = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Search workspaces"]',
    );
    const add = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Add project"]',
    );
    expect(add).not.toBeNull();

    await act(async () => add?.click());
    expect(actions.addProject).toHaveBeenCalledOnce();
    expect(container?.querySelector('[aria-label^="New session"]')).toBeNull();

    await act(async () => {
      if (!search) return;
      setInputValue(search, "codex");
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(search?.value).toBe("");
    expect(container?.querySelector("#workspace-add-actions")).toBeNull();
    expect(container?.querySelectorAll("[data-workspace-session]")).toHaveLength(3);
  });

  it("returns focus to the add trigger after keyboard-opening the project picker", async () => {
    const actions = await renderSidebar();
    const user = userEvent.setup({ document });
    const add = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Add project"]',
    );

    add?.focus();
    await act(async () => user.keyboard("{Enter}"));
    expect(actions.addProject).toHaveBeenCalledOnce();
    expect(actions.addSession).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(add);
  });

  it("returns focus to the add trigger after the native project picker settles", async () => {
    const actions = await renderSidebar();
    const user = userEvent.setup({ document });
    let settlePicker: (() => void) | null = null;
    const picker = new Promise<void>((resolve) => {
      settlePicker = resolve;
    });
    actions.addProject.mockReturnValueOnce(picker);
    const add = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Add project"]',
    );

    add?.focus();
    await act(async () => user.keyboard("{Enter}"));
    expect(actions.addProject).toHaveBeenCalledOnce();

    await act(async () => settlePicker?.());
    expect(document.activeElement).toBe(add);
  });

  it("shows the remote section only while remote work is in play", async () => {
    const previousState = appStore.getState();
    restoreAppStore = () => appStore.setState(previousState, true);
    appStore.setState({
      projects: [],
      sessions: [],
      activeProjectId: null,
      activeSessionByProject: {},
      sidebarMode: "full",
      remoteTargets: [],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<ProjectsSidebar />));

    const remoteHeading = () =>
      container?.querySelector<HTMLElement>(
        '[aria-label="Remote projects"] h2',
      );
    // Hosts are managed in Settings → SSH; a local-only workspace carries no
    // Remote section in the sidebar.
    expect(remoteHeading()).toBeNull();

    // A plain/ad-hoc SSH terminal remains an ordinary workspace. Remote is
    // reserved for saved remote projects, matching the local project tree.
    await act(async () => {
      appStore.setState({
        sessions: [
          {
            id: "ad-hoc",
            projectId: "local",
            name: "ssh studio 1",
            remote: true,
          },
        ],
      });
    });
    expect(remoteHeading()).toBeNull();

    // A pinned remote project brings the section (and its scroller slot) back.
    await act(async () => {
      appStore.setState({
        sessions: [],
        remoteTargets: [{ host: "buildbox", path: "~/code/kodade" }],
      });
    });
    expect(remoteHeading()).not.toBeNull();
    expect(remoteHeading()?.closest("[data-workspace-scroll]")).not.toBeNull();

    // Settings is the sidebar's footer entry — outside the scroller, labelled.
    const settings = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Settings"]',
    );
    expect(settings?.textContent).toContain("settings");
    expect(settings?.closest("[data-workspace-scroll]")).toBeNull();
    expect(container.querySelector('button[title="about ködade"]')).toBeNull();
  });

  it("opens workspace actions by context menu and returns focus on Escape", async () => {
    await renderSidebar();
    const user = userEvent.setup({ document });
    const workspace = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="working"]',
    );
    const add = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Add project"]',
    );

    expect(workspace).not.toBeNull();
    expect(add).not.toBeNull();

    workspace?.focus();
    await act(async () =>
      workspace?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(
      container?.querySelector('button[aria-label="Rename Codex implementation"]'),
    ).not.toBeNull();
    await act(async () => user.keyboard("{Escape}"));
    expect(document.activeElement).toBe(workspace);
    expect(
      container?.querySelector('button[aria-label="Rename Codex implementation"]'),
    ).toBeNull();

    add?.focus();
    await act(async () => user.click(add!));
    expect(document.activeElement).toBe(add);
  });

  it("keeps rename, color, and close-workspace actions reachable", async () => {
    const actions = await renderSidebar();
    const workspace = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="working"]',
    );
    await act(async () =>
      workspace?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );

    const rename = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename Codex implementation"]',
    );
    await act(async () => rename?.click());
    const renameInput = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Rename session"]',
    );
    await act(async () => {
      if (!renameInput) return;
      setInputValue(renameInput, "Implement M8b");
      renameInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(actions.renameSession).toHaveBeenCalledWith("working", "Implement M8b");
    expect(actions.renameSession).toHaveBeenCalledOnce();

    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>('[data-workspace-session="working"]')
        ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    const color = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Project color for Website"]',
    );
    const close = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Close workspace Codex implementation"]',
    );
    await act(async () => color?.click());
    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>('button[aria-label="Teal"]')
        ?.click(),
    );
    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Project color for Website"]',
        )
        ?.click(),
    );
    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>('button[aria-label="Auto color"]')
        ?.click(),
    );
    await act(async () => close?.click());

    expect(actions.addSession).not.toHaveBeenCalled();
    expect(actions.setProjectColor).toHaveBeenCalledWith("website", "teal");
    expect(actions.setProjectColor).toHaveBeenCalledWith("website", null);
    expect(actions.closeWorkspace).toHaveBeenCalledWith("working");
  });

  it("uses the workspace itself as the only project/session activation target", async () => {
    const actions = await renderSidebar();
    const openProject = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Website project"]',
    );
    expect(openProject).toBeNull();

    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>('[data-workspace-session="working"]')
        ?.click(),
    );
    expect(actions.activateSession).toHaveBeenCalledWith("website", "working");
    expect(actions.setActiveProject).not.toHaveBeenCalled();
  });

  it("returns focus after Enter rename but preserves the blur destination", async () => {
    const actions = await renderSidebar();
    const user = userEvent.setup({ document });
    const search = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Search workspaces"]',
    );
    const sessionTrigger = () =>
      container?.querySelector<HTMLButtonElement>(
        '[data-workspace-session="working"]',
      );

    await act(async () => user.dblClick(sessionTrigger()!));
    const enterInput = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Rename session"]',
    );
    await act(async () => user.clear(enterInput!));
    await act(async () => user.type(enterInput!, "Enter rename"));
    await act(async () => user.keyboard("{Enter}"));

    expect(actions.renameSession).toHaveBeenLastCalledWith(
      "working",
      "Enter rename",
    );
    expect(document.activeElement).toBe(sessionTrigger());

    await act(async () => user.dblClick(sessionTrigger()!));
    const blurInput = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Rename session"]',
    );
    await act(async () => user.clear(blurInput!));
    await act(async () => user.type(blurInput!, "Blur rename"));
    await act(async () => user.click(search!));

    expect(actions.renameSession).toHaveBeenLastCalledWith(
      "working",
      "Blur rename",
    );
    expect(document.activeElement).toBe(search);
  });

  it("cancels a direct session rename without clearing search and restores session focus", async () => {
    const actions = await renderSidebar();
    const user = userEvent.setup({ document });
    const search = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Search workspaces"]',
    );

    await act(async () => user.type(search!, "codex"));
    const sessionTrigger = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="working"]',
    );
    await act(async () => user.dblClick(sessionTrigger!));
    expect(document.activeElement).toBe(
      container?.querySelector('input[aria-label="Rename session"]'),
    );

    await act(async () => user.keyboard("{Escape}"));

    expect(actions.renameSession).not.toHaveBeenCalled();
    expect(search?.value).toBe("codex");
    expect(container?.querySelector('input[aria-label="Rename session"]')).toBeNull();
    expect(document.activeElement).toBe(
      container?.querySelector('[data-workspace-session="working"]'),
    );
  });

  it("cancels an inline rename with Escape without writing a session name", async () => {
    const actions = await renderSidebar();
    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>(
          '[data-workspace-session="working"]',
        )
        ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Rename Codex implementation"]',
        )
        ?.click(),
    );
    await act(async () =>
      container
        ?.querySelector<HTMLInputElement>('input[aria-label="Rename session"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );

    expect(actions.renameSession).not.toHaveBeenCalled();
    expect(container?.querySelector('input[aria-label="Rename session"]')).toBeNull();
  });

  it("closes an open card action menu with Escape", async () => {
    await renderSidebar();
    const trigger = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="working"]',
    );
    trigger?.focus();
    await act(async () =>
      trigger?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(
      container?.querySelector("#workspace-actions-working"),
    ).not.toBeNull();

    await act(async () =>
      trigger?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(
      container?.querySelector("#workspace-actions-working"),
    ).toBeNull();
  });

  it("keeps the search query when Escape closes card color actions", async () => {
    await renderSidebar();
    const user = userEvent.setup({ document });
    const search = container?.querySelector<HTMLInputElement>(
      'input[aria-label="Search workspaces"]',
    );
    const trigger = container?.querySelector<HTMLButtonElement>(
      '[data-workspace-session="working"]',
    );

    expect(search).not.toBeNull();
    expect(trigger).not.toBeNull();

    await act(async () => user.type(search!, "codex"));
    trigger?.focus();
    await act(async () =>
      trigger?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    await act(async () =>
      user.click(
        container!.querySelector<HTMLButtonElement>(
          'button[aria-label="Project color for Website"]',
        )!,
      ),
    );
    const red = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Red"]',
    );
    red?.focus();
    await act(async () => user.keyboard("{Escape}"));

    expect(search?.value).toBe("codex");
    expect(container?.querySelector("#workspace-actions-working")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("projects a live shared activity update through the store-backed full sidebar", async () => {
    const previousState = appStore.getState();
    restoreAppStore = () => appStore.setState(previousState, true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const project = {
      id: "store-backed-workspace",
      name: "Store-backed workspace",
      path: "/repos/store-backed-workspace",
    };
    vi.spyOn(registry, "open").mockResolvedValue(undefined);
    vi.spyOn(registry, "close").mockResolvedValue(undefined);
    vi.spyOn(tauriMemory, "resolveWorkspace").mockResolvedValue(null);
    activityModule.observe({
      type: "project-added",
      at: Date.now(),
      projectId: project.id,
      projectName: project.name,
    });
    restoreActivityModule = () =>
      activityModule.observe({
        type: "project-removed",
        at: Date.now(),
        projectId: project.id,
      });
    appStore.setState({
      projects: [project],
      sessions: [],
      activeProjectId: null,
      activeSessionByProject: {},
      sidebarMode: "full",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<ProjectsSidebar />));

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = appStore.getState().addSession(project.id, "Live activity");
    });
    expect(sessionId).not.toBeNull();
    expect(registry.open).toHaveBeenCalledWith(sessionId, project.path);
    expect(
      container.querySelector('section[aria-label^="Settled"]')?.textContent,
    ).toContain("Store-backed workspace");

    await act(async () => {
      activityModule.observe({
        type: "terminal-foreground",
        at: Date.now(),
        projectId: project.id,
        sessionId: sessionId!,
        process: "codex",
      });
      vi.advanceTimersByTime(1_000);
    });
    expect(
      container.querySelector('section[aria-label^="Working"]')?.textContent,
    ).toContain("codex · Store-backed workspace");
  });

  it("does not expose a new-session button for a zero-session project", async () => {
    const previousState = appStore.getState();
    restoreAppStore = () => appStore.setState(previousState, true);
    const project = {
      id: "first-session-workspace",
      name: "First session workspace",
      path: "/repos/first-session-workspace",
    };
    vi.spyOn(registry, "open").mockResolvedValue(undefined);
    vi.spyOn(tauriMemory, "resolveWorkspace").mockResolvedValue(null);
    activityModule.observe({
      type: "project-added",
      at: Date.now(),
      projectId: project.id,
      projectName: project.name,
    });
    restoreActivityModule = () =>
      activityModule.observe({
        type: "project-removed",
        at: Date.now(),
        projectId: project.id,
      });
    appStore.setState({
      projects: [project],
      sessions: [],
      activeProjectId: null,
      activeSessionByProject: {},
      sidebarMode: "full",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<ProjectsSidebar />));
    const openProject = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open First session workspace project"]',
    );
    const user = userEvent.setup({ document });

    expect(container.querySelector('[aria-label^="New session"]')).toBeNull();
    expect(openProject).not.toBeNull();
    openProject?.focus();
    await act(async () => user.keyboard("{Enter}"));
    expect(document.activeElement).toBe(openProject);
  });
});
