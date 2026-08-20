// Full-page settings: section nav, Back/Esc, restore defaults, and KödChat's
// provider availability and sign-in controls.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appStore,
  chatStore,
  filesStore,
  memoryStore,
  providersStore,
  sshStore,
  themeStore,
  voiceStore,
} from "../../store/appStore";
import { settingsViewStore } from "../../store/settingsView";
import { DEFAULT_LOCAL_MODEL_PREFERENCES } from "../../local/models";
import { DEFAULT_VOICE_PREFERENCES } from "../../voice/models";
import { PROVIDERS, supportsChat } from "../../providers/catalog";
import { TerminalPane } from "../TerminalPane";
import { releaseManifestFor } from "../../release/manifest";
import { AdvancedSection } from "./AdvancedSection";
import { ChatSection } from "./ChatSection";
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
      activeSessionByProject: {},
      localModelPreferences: DEFAULT_LOCAL_MODEL_PREFERENCES,
      sessions: [],
    });
    chatStore.setState({
      ollama: { status: "idle", models: [], message: null },
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

  it("lists exactly the four sections and opens on general", async () => {
    await render(<SettingsPage />);

    const links = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(
        "[data-settings-nav-link]",
      ) ?? [],
    );
    expect(links.map((link) => link.dataset.settingsNavLink)).toEqual([
      "general",
      "providers",
      "memory",
      "advanced",
    ]);
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "general",
      "providers",
      "ködmem",
      "advanced",
    ]);
    expect(navLink("general")?.getAttribute("aria-current")).toBe("page");
    expect(container?.textContent).toContain("appearance");
    expect(container?.textContent).toContain("theme");
  });

  it("keeps keybindings on the general page", async () => {
    await render(<SettingsPage />);

    expect(container?.textContent).toContain("keybindings");
    expect(container?.textContent).toContain("shortcuts");
  });

  it("falls back from a stale deep link", async () => {
    settingsViewStore.setState({ section: "removed" as never });

    await render(<SettingsPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(settingsViewStore.getState().section).toBe("general");
    expect(container?.textContent).toContain(
      "Appearance, workspace chrome, and keyboard shortcuts.",
    );
  });

  it("redirects the retired KödChat deep link to providers", async () => {
    settingsViewStore.setState({ section: "chat" as never });

    await render(<SettingsPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(settingsViewStore.getState().section).toBe("providers");
    expect(navLink("providers")?.getAttribute("aria-current")).toBe("page");
    expect(navLink("ködchat")).toBeUndefined();
    expect(container?.textContent).toContain("agents that can chat");
  });

  it("redirects the retired keybindings deep link to general", async () => {
    settingsViewStore.setState({ section: "keybindings" as never });

    await render(<SettingsPage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(settingsViewStore.getState().section).toBe("general");
    expect(container?.textContent).toContain("shortcuts");
  });

  it("switches the content pane from the left nav", async () => {
    await render(<SettingsPage />);

    await act(async () => navLink("advanced")?.click());

    expect(settingsViewStore.getState().section).toBe("advanced");
    expect(navLink("advanced")?.getAttribute("aria-current")).toBe("page");
    expect(navLink("general")?.getAttribute("aria-current")).toBeNull();
    expect(container?.textContent).toContain("ködharness");
  });

  it("stacks every development block under advanced in a dev build", async () => {
    settingsViewStore.setState({ section: "advanced" });
    await render(<SettingsPage />);

    for (const heading of ["ködharness", "ködlocal", "ködwhisper", "ködssh"]) {
      expect(container?.textContent).toContain(heading);
    }
    // Harness is the open block; the development ones start collapsed.
    expect(
      Array.from(
        container?.querySelectorAll<HTMLButtonElement>("[aria-expanded]") ?? [],
      ).map((button) => button.getAttribute("aria-expanded")),
    ).toEqual(["false", "false", "false"]);
  });

  it("mounts a development block only when it is expanded", async () => {
    const original = {
      refreshInputDevices: voiceStore.getState().refreshInputDevices,
      init: sshStore.getState().init,
    };
    const refreshInputDevices = vi.fn(async () => undefined);
    const init = vi.fn(async () => undefined);
    voiceStore.setState({ refreshInputDevices });
    sshStore.setState({ init });
    settingsViewStore.setState({ section: "advanced" });

    try {
      await render(<SettingsPage />);
      // Visiting Advanced probes no microphones and no SSH hosts.
      expect(refreshInputDevices).not.toHaveBeenCalled();
      expect(init).not.toHaveBeenCalled();

      const disclosure = (title: string) =>
        Array.from(
          container?.querySelectorAll<HTMLButtonElement>("[aria-expanded]") ??
            [],
        ).find((button) => button.textContent?.includes(title));

      await act(async () => {
        disclosure("ködwhisper")?.click();
        await Promise.resolve();
      });
      expect(refreshInputDevices).toHaveBeenCalled();
      expect(init).not.toHaveBeenCalled();

      await act(async () => {
        disclosure("ködssh")?.click();
        await Promise.resolve();
      });
      expect(init).toHaveBeenCalled();
    } finally {
      voiceStore.setState({ refreshInputDevices: original.refreshInputDevices });
      sshStore.setState({ init: original.init });
    }
  });

  it("shows only the harness block under advanced in a public build", async () => {
    await render(<AdvancedSection manifest={releaseManifestFor("public")} />);

    expect(container?.textContent).toContain("What your agents read");
    expect(container?.textContent).not.toContain("ködlocal");
    expect(container?.textContent).not.toContain("ködwhisper");
    expect(container?.textContent).not.toContain("ködssh");
  });

  it("renders the KödHarness inventory inside settings", async () => {
    filesStore.setState({ rootPath: "/repo" });
    appStore.setState({
      activeProjectId: "project",
      projects: [{ id: "project", name: "kodade", path: "/repo" }],
    });
    settingsViewStore.setState({ section: "advanced" });

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
    settingsViewStore.setState({ section: "advanced" });

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
    appStore.setState({ activeProjectId: null, projects: [] });
    settingsViewStore.setState({ section: "memory" });
    await render(<SettingsPage />);

    const restore = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent === "Restore defaults");
    expect(restore).toBeUndefined();
    expect(container?.textContent).toContain("KödMem");
  });

  it("keeps a restore for the development blocks stacked under advanced", async () => {
    appStore.getState().setLocalModelPreferences({
      ...DEFAULT_LOCAL_MODEL_PREFERENCES,
      contextLength: 8192,
    });
    appStore.getState().setVoicePreferences({
      ...DEFAULT_VOICE_PREFERENCES,
      modelId: "small.en",
    });
    settingsViewStore.setState({ section: "advanced" });
    await render(<SettingsPage />);

    const restore = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent === "Restore defaults");
    await act(async () => restore?.click());
    // The confirm step names what actually resets, not the page.
    expect(container?.textContent).toContain(
      "Reset KödLocal and KödWhisper preferences?",
    );
    const confirm = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent === "Reset");
    await act(async () => confirm?.click());

    expect(appStore.getState().localModelPreferences).toEqual(
      DEFAULT_LOCAL_MODEL_PREFERENCES,
    );
    expect(appStore.getState().voicePreferences).toEqual(
      DEFAULT_VOICE_PREFERENCES,
    );
  });

  it("does not put provider status controls above the terminal", () => {
    const markup = renderToStaticMarkup(<TerminalPane />);

    expect(markup).not.toContain("Claude Code");
    expect(markup).not.toContain("agent CLIs");
  });

  // --- KödChat section (issue #163) ---

  it("refreshes agent CLI status from the unified KödChat section", async () => {
    const onRefresh = vi.fn();
    await render(<ChatSection onRefresh={onRefresh} />);

    const refresh = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent?.trim() === "refresh agents");
    expect(refresh).not.toBeUndefined();
    await act(async () => refresh?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
  });

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
    appStore.setState({
      sessions: [
        {
          id: "chat-project",
          projectId: "project",
          kind: "chat",
          name: "claude 1",
        },
      ],
      activeSessionByProject: { project: "chat-project" },
    });
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

  it("requires an active KödChat thread before offering a login terminal", async () => {
    const onLogin = vi.fn();
    await render(<ChatSection onLogin={onLogin} />);

    const button = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find(
      (candidate) =>
        candidate.textContent?.trim() === "open a terminal to log in",
    );
    expect(button?.disabled).toBe(true);
    expect(container?.textContent).toContain(
      "Select a KödChat thread before opening a login terminal.",
    );
    await act(async () => button?.click());
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("refreshes Ollama explicitly and after opening its start terminal", async () => {
    const onLogin = vi.fn(async () => undefined);
    const refresh = vi
      .spyOn(chatStore.getState(), "refreshOllama")
      .mockResolvedValue(undefined);
    appStore.setState({
      sessions: [
        {
          id: "chat-project",
          projectId: "project",
          kind: "chat",
          name: "ollama 1",
        },
      ],
      activeSessionByProject: { project: "chat-project" },
    });
    await render(<ChatSection onLogin={onLogin} />);

    const button = (label: string) =>
      [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
    await act(async () => button("refresh models")?.click());
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      button("start Ollama")?.click();
      await Promise.resolve();
    });
    expect(onLogin).toHaveBeenCalledWith("ollama serve", "ollama");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not offer to start a second Ollama server when it is ready", async () => {
    chatStore.setState({
      ollama: {
        status: "ready",
        models: [{ id: "qwen3:8b", label: "qwen3:8b" }],
        message: null,
      },
    });
    await render(<ChatSection />);
    expect(container?.textContent).not.toContain("start Ollama");
    expect(container?.textContent).toContain("refresh models");
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

  it("accepts Ollama as a chat-capable default provider", async () => {
    appStore.setState({ chatProvider: "claude" });
    appStore.getState().setChatProvider("ollama");
    expect(appStore.getState().chatProvider).toBe("ollama");
  });
});
