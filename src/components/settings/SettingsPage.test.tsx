// Full-page settings: section nav, Back/Esc, restore defaults, and the
// provider launch flows ported from the old title-bar popover.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appStore,
  filesStore,
  memoryStore,
  providersStore,
  themeStore,
} from "../../store/appStore";
import { settingsViewStore } from "../../store/settingsView";
import { DEFAULT_LOCAL_MODEL_PREFERENCES } from "../../local/models";
import { PROVIDERS, supportsChat } from "../../providers/catalog";
import { TerminalPane } from "../TerminalPane";
import { ChatSection } from "./ChatSection";
import { ProvidersSection } from "./ProvidersSection";
import { SettingsEntry } from "./SettingsEntry";
import { SettingsPage } from "./SettingsPage";

describe("settings page", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  const render = async (element: React.ReactElement) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(element));
    return container;
  };

  const navLink = (label: string) =>
    Array.from(
      container?.querySelectorAll<HTMLButtonElement>(
        'nav[aria-label="Settings sections"] button',
      ) ?? [],
    ).find((button) => button.textContent?.trim() === label);

  beforeEach(() => {
    settingsViewStore.setState({ section: "general" });
    appStore.setState({
      activeProjectId: "project",
      localModelPreferences: DEFAULT_LOCAL_MODEL_PREFERENCES,
    });
    providersStore.setState((state) => ({
      launchingProviderId: null,
      launchError: null,
      statuses: Object.fromEntries(
        state.providers.map((provider) => [
          provider.id,
          provider.id === "claude"
            ? { status: "installed" as const, version: "2.1.197" }
            : { status: "missing" as const, version: null },
        ]),
      ),
    }));
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    settingsViewStore.getState().close();
    filesStore.setState({ rootPath: null });
    appStore.setState({ activeProjectId: null, projects: [] });
  });

  it("opens settings on general from the sidebar entry", async () => {
    settingsViewStore.setState({ section: null });
    await render(<SettingsEntry />);

    const entry = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Settings"]',
    );
    expect(entry?.textContent).toContain("settings");
    await act(async () => entry?.click());
    expect(settingsViewStore.getState().section).toBe("general");
  });

  it("lists every section and opens on general", async () => {
    await render(<SettingsPage />);

    for (const label of [
      "general",
      "providers",
      "ködchat",
      "ködharness",
      "ködmem",
      "ködlocal",
      "ködwhisper",
      "ködssh",
      "keybindings",
    ]) {
      expect(navLink(label)).not.toBeUndefined();
    }
    expect(navLink("general")?.getAttribute("aria-current")).toBe("page");
    expect(container?.textContent).toContain("appearance");
    expect(container?.textContent).toContain("theme");
  });

  it("falls back from a stale deep link", async () => {
    settingsViewStore.setState({ section: "removed" as never });

    await render(<SettingsPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(settingsViewStore.getState().section).toBe("general");
    expect(container?.textContent).toContain("Appearance and workspace chrome.");
  });

  it("switches the content pane from the left nav", async () => {
    await render(<SettingsPage />);

    await act(async () => navLink("keybindings")?.click());

    expect(settingsViewStore.getState().section).toBe("keybindings");
    expect(navLink("keybindings")?.getAttribute("aria-current")).toBe("page");
    expect(navLink("general")?.getAttribute("aria-current")).toBeNull();
    expect(container?.textContent).toContain("shortcuts");
  });

  it("renders the KödHarness inventory inside settings", async () => {
    filesStore.setState({ rootPath: "/repo" });
    appStore.setState({
      activeProjectId: "project",
      projects: [{ id: "project", name: "kodade", path: "/repo" }],
    });
    settingsViewStore.setState({ section: "harness" });

    await render(<SettingsPage />);

    expect(container?.textContent).toContain("instructions");
    expect(container?.textContent).toContain("skills");
    expect(container?.textContent).toContain("mcp servers");
    expect(container?.textContent).not.toContain("open KödHarness…");
    expect(
      container?.querySelector('[data-settings-harness="true"]'),
    ).not.toBeNull();
  });

  it("keeps the KödHarness empty state bounded to settings", async () => {
    appStore.setState({ activeProjectId: null, projects: [] });
    settingsViewStore.setState({ section: "harness" });

    await render(<SettingsPage />);

    const harness = container?.querySelector('[data-settings-harness="true"]');
    expect(harness?.textContent).toContain("select a project");
    expect(harness?.classList.contains("absolute")).toBe(false);
  });

  it("puts KödMem setup in settings for the active project", async () => {
    const openWorkspace = memoryStore.getState().openWorkspace;
    const createWorkspace = memoryStore.getState().createWorkspace;
    const startPolling = memoryStore.getState().startPolling;
    const stopPolling = memoryStore.getState().stopPolling;
    const enabledWorkspace = {
      id: "ws_project",
      canonicalRoot: "/repo",
      displayName: "kodade",
      color: null,
      capturePaused: false,
      activityRetentionDays: 30,
      auditRetentionDays: 30,
      tombstoneRetentionDays: 30,
      createdAt: 1,
      updatedAt: 1,
    };
    const enable = vi.fn().mockImplementation(async () => {
      memoryStore.setState({
        workspace: enabledWorkspace,
        context: {
          workspace: enabledWorkspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        },
        audit: [],
        auditTotal: 0,
        deleted: [],
        deletedTotal: 0,
      });
      return enabledWorkspace;
    });
    memoryStore.setState({
      workspace: null,
      openWorkspace: vi.fn().mockResolvedValue(null),
      createWorkspace: enable,
      startPolling: vi.fn(),
      stopPolling: vi.fn(),
    });
    appStore.setState({
      activeProjectId: "project",
      projects: [{ id: "project", name: "kodade", path: "/repo" }],
    });
    settingsViewStore.setState({ section: "memory" });

    await render(<SettingsPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const memory = container?.querySelector('[data-settings-memory="true"]');
    expect(memory).not.toBeNull();
    expect(memory?.textContent).toContain("Enable KödMem");
    expect(memory?.textContent).toContain("kodade-memory.sqlite3");
    expect(memory?.textContent).toContain("outside the repo");
    expect(memory?.textContent).not.toContain(
      "Project context that survives agent sessions.",
    );
    const activate = Array.from(
      memory?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent === "Enable KödMem");
    await act(async () => {
      activate?.click();
      await Promise.resolve();
    });
    expect(enable).toHaveBeenCalledWith("/repo", "kodade", null);
    expect(
      container?.querySelector('input[aria-label="search KödMem"]'),
    ).not.toBeNull();
    memoryStore.setState({
      workspace: null,
      openWorkspace,
      createWorkspace,
      startPolling,
      stopPolling,
    });
  });

  it("relinks moved project memory by stored identity after its old folder disappears", async () => {
    const original = {
      openWorkspace: memoryStore.getState().openWorkspace,
      listWorkspaces: memoryStore.getState().listWorkspaces,
      load: memoryStore.getState().load,
      relinkWorkspace: memoryStore.getState().relinkWorkspace,
      startPolling: memoryStore.getState().startPolling,
      stopPolling: memoryStore.getState().stopPolling,
    };
    const oldWorkspace = {
      id: "ws_moved",
      canonicalRoot: "/old/repo",
      displayName: "kodade",
      color: null,
      capturePaused: false,
      activityRetentionDays: 30,
      auditRetentionDays: 30,
      tombstoneRetentionDays: 30,
      createdAt: 1,
      updatedAt: 1,
    };
    const movedWorkspace = { ...oldWorkspace, canonicalRoot: "/repo" };
    const openWorkspace = vi.fn().mockImplementation(async () => {
      memoryStore.setState({ workspace: null });
      return null;
    });
    const listWorkspaces = vi.fn().mockResolvedValue([oldWorkspace]);
    const load = vi.fn().mockImplementation(async (workspaceId: string) => {
      expect(workspaceId).toBe(oldWorkspace.id);
      memoryStore.setState({
        workspace: oldWorkspace,
        context: {
          workspace: oldWorkspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        },
      });
    });
    const relinkWorkspace = vi.fn().mockImplementation(async () => {
      memoryStore.setState({
        workspace: movedWorkspace,
        context: {
          workspace: movedWorkspace,
          latestCheckpoint: null,
          pinnedDecisions: [],
          openTasks: [],
          recentMemories: [],
        },
      });
      return movedWorkspace;
    });
    memoryStore.setState({
      workspace: null,
      openWorkspace,
      listWorkspaces,
      load,
      relinkWorkspace,
      startPolling: vi.fn(),
      stopPolling: vi.fn(),
    });
    appStore.setState({
      activeProjectId: "project",
      projects: [{ id: "project", name: "kodade", path: "/repo" }],
    });
    settingsViewStore.setState({ section: "memory" });
    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);

    await render(<SettingsPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const relink = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent === "Relink existing…");
    await act(async () => {
      relink?.click();
      await Promise.resolve();
    });
    const candidate = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent?.includes("/old/repo"));
    await act(async () => {
      candidate?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(openWorkspace).toHaveBeenCalledWith("/repo");
    expect(listWorkspaces).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(oldWorkspace.id);
    expect(relinkWorkspace).toHaveBeenCalledWith("/repo");
    expect(
      container?.querySelector('input[aria-label="search KödMem"]'),
    ).not.toBeNull();

    window.confirm = originalConfirm;
    memoryStore.setState({ workspace: null, ...original });
  });

  it("returns to the workspace from Back and from Escape", async () => {
    await render(<SettingsPage />);

    const back = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent?.includes("Back"));
    await act(async () => back?.click());
    expect(settingsViewStore.getState().section).toBeNull();

    await act(async () => settingsViewStore.getState().open("providers"));
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(settingsViewStore.getState().section).toBeNull();
  });

  it("restores the active section's defaults only after confirming", async () => {
    const theme = themeStore.getState().themes[0]!.id;
    themeStore.getState().setSelection(theme);
    appStore.getState().setSidebarMode("rail");
    await render(<SettingsPage />);

    const restore = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent === "Restore defaults");
    await act(async () => restore?.click());
    // Confirm step: nothing has changed yet.
    expect(themeStore.getState().selection).toBe(theme);
    expect(appStore.getState().sidebarMode).toBe("rail");

    const confirm = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent === "Reset");
    await act(async () => confirm?.click());

    expect(themeStore.getState().selection).toBe("system");
    expect(appStore.getState().sidebarMode).toBe("full");
  });

  it("hides restore defaults for sections with nothing to reset", async () => {
    settingsViewStore.setState({ section: "keybindings" });
    await render(<SettingsPage />);

    const restore = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent === "Restore defaults");
    expect(restore).toBeUndefined();
    expect(container?.textContent).toContain("shortcut");
  });

  it("keeps launchable agent status in the providers section", async () => {
    await render(<ProvidersSection />);

    expect(container?.textContent).toContain("agent CLIs");
    expect(container?.textContent).toContain("Claude Code");
    expect(
      container?.querySelector(
        'button[title="Start Claude Code in a new terminal"]',
      ),
    ).not.toBeNull();
  });

  it("does not put provider status controls above the terminal", () => {
    const markup = renderToStaticMarkup(<TerminalPane />);

    expect(markup).not.toContain("Claude Code");
    expect(markup).not.toContain("agent CLIs");
  });

  it("launches an installed provider from settings", async () => {
    const onLaunch = vi.fn();
    await render(<ProvidersSection onLaunch={onLaunch} />);

    const launch = container?.querySelector<HTMLButtonElement>(
      'button[title="Start Claude Code in a new terminal"]',
    );
    expect(launch).not.toBeNull();
    await act(async () => launch?.click());
    expect(onLaunch).toHaveBeenCalledWith("claude");
  });

  it("keeps saved KödLocal backends gated while passing the implicit local backend per session", async () => {
    const onLaunch = vi.fn();
    appStore.setState({
      localModelPreferences: {
        ...DEFAULT_LOCAL_MODEL_PREFERENCES,
        savedEndpoints: [
          {
            id: "studio",
            label: "Studio GPU",
            baseURL: "https://gpu.example.test/v1",
          },
        ],
      },
    });
    providersStore.setState((state) => ({
      statuses: Object.fromEntries(
        state.providers.map((provider) => [
          provider.id,
          provider.id === "kodade-local"
            ? { status: "installed" as const, version: "node 22.0" }
            : { status: "missing" as const, version: null },
        ]),
      ),
    }));
    await render(<ProvidersSection onLaunch={onLaunch} />);

    const picker = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="KödLocal backend for this session"]',
    );
    expect(Array.from(picker!.options).map((option) => option.text)).toEqual([
      "This Mac",
    ]);
    expect(container?.textContent).toContain(
      "Saved LAN/remote backends require KödLocal Pro.",
    );

    const launch = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "start KödLocal",
    );
    await act(async () => launch?.click());
    expect(onLaunch).toHaveBeenCalledWith("kodade-local", {
      localBackend: {
        id: "local",
        label: "This Mac",
        baseURL: "http://127.0.0.1:4470",
        local: true,
      },
    });
  });

  it("disables installed provider launches until a project is open", async () => {
    appStore.setState({ activeProjectId: null });
    await render(<ProvidersSection />);

    const launch = container?.querySelector<HTMLButtonElement>(
      'button[title="Open a project first"]',
    );
    expect(launch?.disabled).toBe(true);
  });

  it("renders provider launch failures inline", async () => {
    providersStore.setState({ launchError: "Could not start Claude Code." });
    await render(<ProvidersSection />);

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not start Claude Code.",
    );
  });

  it("opens the harness from the providers section", async () => {
    const onManageHarness = vi.fn();
    await render(<ProvidersSection onManageHarness={onManageHarness} />);

    const manage = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "manage harness…",
    );
    await act(async () => manage?.click());
    expect(onManageHarness).toHaveBeenCalled();
  });

  // --- KödChat section (issue #163) ---

  it("marks providers without a stream recipe as terminal only", async () => {
    await render(<ChatSection />);

    // Only the two verified dialects can answer a chat thread; the rest are
    // labelled rather than silently missing.
    const unsupported = container?.querySelectorAll(
      '[data-testid="chat-unsupported"]',
    );
    expect(unsupported?.length).toBe(
      PROVIDERS.filter((provider) => !supportsChat(provider)).length,
    );
    expect(container?.textContent).toContain(
      "Not yet supported in KödChat",
    );
  });

  it("offers a login terminal only for an installed chat-capable provider", async () => {
    const onLogin = vi.fn();
    await render(<ChatSection onLogin={onLogin} />);

    const buttons = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).filter(
      (button) => button.textContent?.trim() === "open a terminal to log in",
    );
    // beforeEach installs claude only, so codex (capable but missing) has none.
    expect(buttons).toHaveLength(1);

    await act(async () => buttons[0].click());
    // The provider's own interactive command, in a real terminal — Kodade
    // never proxies the credential.
    expect(onLogin).toHaveBeenCalledWith("claude", "claude");
  });

  it("persists the default provider for new chats", async () => {
    appStore.setState({ chatProvider: "claude" });
    await render(<ChatSection />);

    const select = container?.querySelector<HTMLSelectElement>(
      'select[aria-label="Default provider for new chats"]',
    );
    // Only chat-capable providers are offered.
    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual(
      PROVIDERS.filter(supportsChat).map((provider) => provider.id),
    );

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(select, "codex");
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(appStore.getState().chatProvider).toBe("codex");
  });

  it("ignores a provider KödChat cannot drive", async () => {
    appStore.setState({ chatProvider: "claude" });
    appStore.getState().setChatProvider("ollama");
    // Rejected: the preference can never leave the composer unusable.
    expect(appStore.getState().chatProvider).toBe("claude");
  });
});
