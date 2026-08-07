// Real app wiring: one registry + one store built on the Tauri IPC seam.
// Components import from here; tests build their own store with mocks instead.

// Feature wiring stays on the typed desktop transport boundary.
import {
  agent as tauriAgent,
  browser as tauriBrowser,
  config as tauriConfig,
  externalUrls as tauriExternalUrls,
  files as tauriFiles,
  foreground as tauriForeground,
  git as tauriGit,
  github as tauriGithub,
  local as tauriLocal,
  ipc as tauriIpc,
  memory as tauriMemory,
  platform as tauriPlatform,
  provider as tauriProvider,
  ssh as tauriSsh,
  storage as tauriStorage,
  vox as tauriVox,
  isTauriRuntime,
} from "../ipc/transport";
import { createActivityAdapters } from "../activity/adapters";
import { createActivityModule } from "../activity/activity";
import { createMemoryStore } from "../memory/store";
import { rootsWithGitCheckpointEvents } from "../memory/commit-observer";
import { createChatStore } from "../chat/store";
import { createProvidersStore } from "../providers/store";
import { ensureBrowserAgentSetup } from "../browser/agent-setup";
import { activateBrowserForAgent } from "../browser/agent-activation";
import { createGithubStore } from "../github/store";
import { createClaudeAdapter } from "../harness/adapters/claude";
import { createCodexAdapter } from "../harness/adapters/codex";
import { createGrokAdapter } from "../harness/adapters/grok";
import { createOpencodeAdapter } from "../harness/adapters/opencode";
import { createKodadeLocalAdapter } from "../harness/adapters/kodade-local";
import { SessionRegistry } from "../terminal/registry";
import { createXtermFactory } from "../terminal/xterm-factory";
import { applyCssVars, toXtermTheme } from "../themes/applier";
import { installShortcuts } from "../shortcuts/dispatcher";
import { setComboOverrides } from "../shortcuts/bindings";
import { createFilesStore } from "./files";
import { createHarnessStore } from "./harness";
import { createReviewStore } from "./review";
import { createSshStore } from "./ssh";
import { createRemoteFilesStore } from "./remoteFiles";
import { routeFileDrop } from "./drop-routing";
import { createProjectsStore } from "./projects";
import { remoteTargetForProjectId } from "../ssh/model";
import { createThemeStore } from "./theme";
import { EDITOR_BROWSER_ID } from "../browser/constants";
import { entitlements } from "../app/entitlements";
import {
  insertAtCaret,
  isTextInsertionTarget,
  terminalTextForInsertion,
} from "../voice/insertion";
import { VoiceModelManager, type VoicePreferences } from "../voice/models";
import { createVoiceStore, type VoiceContext } from "../voice/store";
import type { VoiceTarget } from "../voice/reducer";
import type { CleanupProvider } from "../voice/cleanup/pipeline";
import { harvestVocabulary } from "../voice/vocabulary/harvest";
import { hasFeature as licenseHasFeature } from "../license";
import { FEATURES } from "../license/features";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createActivityPersistenceBridge,
  installTauriCloseCapture,
  installWebCloseCapture,
  rememberWorkspaceRegistration,
} from "../memory/capture";
import { nativeEquals, nativeRelativePath } from "../platform/native-path";
import { RELEASE_MANIFEST } from "../release/manifest";
import { AVAILABLE_PROVIDERS } from "../providers/catalog";

// M8a is deliberately headless: UI work in #77 reads this projection later.
// Activity receives only metadata and derives density at view time.
export const activityModule = createActivityModule({
  reducedMotion: () =>
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches,
});
const activityAdapters = createActivityAdapters(activityModule);
const activityPersistence = createActivityPersistenceBridge();

function terminalActivityContext(sessionId: string) {
  const session = appStore
    .getState()
    .sessions.find((item) => item.id === sessionId);
  return session
    ? { projectId: session.projectId, sessionId: session.id }
    : null;
}

export const registry = new SessionRegistry(
  createXtermFactory(tauriIpc, {
    // Dead shells (natural exit or failed spawn) get dimmed in the sidebar.
    onSessionDead: (id, code) => {
      const context = terminalActivityContext(id);
      appStore.getState().markSessionExited(id);
      if (context) {
        activityAdapters.terminalExited(
          context.projectId,
          context.sessionId,
          code,
        );
      }
    },
    onSessionOutput: (id) => {
      const context = terminalActivityContext(id);
      if (context)
        activityAdapters.terminalOutput(context.projectId, context.sessionId);
    },
  }),
);
export const appStore = createProjectsStore({
  storage: tauriStorage,
  registry,
  canUseRemote: () =>
    RELEASE_MANIFEST.features.ssh &&
    entitlements.hasFeature(FEATURES.sshPro),
  canonicalize: (path) => tauriPlatform.canonicalize(path),
  // Removing a project prunes the files store's per-root tab closure so a
  // removed-then-re-added folder starts with no stale tabs (v1.1). filesStore is
  // declared below; this closure only reads it at call time, so the order is fine.
  onProjectRemoved: (path) => filesStore.getState().dropTabsForRoot(path),
  onSessionStarted: (project, session, provider) => {
    void activityPersistence.recordActivity(project, "sessionStarted", {
      sessionId: session.id,
      provider,
    });
    if (provider) {
      void activityPersistence.recordActivity(project, "providerLaunched", {
        sessionId: session.id,
        provider,
      });
    }
  },
  onSessionExited: (project, session) => {
    void activityPersistence.recordActivity(project, "sessionExited", {
      sessionId: session.id,
    });
  },
  // A closed KödChat thread takes its transcript document with it. Declared
  // below; read at call time, so the declaration order is fine.
  onSessionRemoved: (session) => {
    if (session.kind !== "chat") return;
    void chatStore.getState().removeThread(session.id);
  },
  // Foreground-process auto-naming: the store polls this for visible sessions.
  foreground: tauriForeground,
  onActivity: (fact) => {
    activityAdapters.workspace(fact);
    if (fact.type !== "terminal-foreground") return;
    const project = appStore
      .getState()
      .projects.find((candidate) => candidate.id === fact.projectId);
    if (project) void activityPersistence.workspaceFact(project, fact);
  },
});

export function resolveVoiceTarget(): VoiceTarget | null {
  const focused = document.activeElement;
  const state = appStore.getState();
  const projectId = state.activeProjectId;
  const sessionId = projectId
    ? state.activeSessionByProject[projectId]
    : undefined;
  const session = state.sessions.find(
    (candidate) => candidate.id === sessionId,
  );
  const activeSession =
    session && session.projectId === projectId && !session.exited
      ? session
      : null;
  const micButtonFocused =
    focused instanceof Element &&
    !!focused.closest("[data-voice-terminal-control]");
  if ((registry.containsNode(focused) || micButtonFocused) && activeSession) {
    return {
      kind: "terminal",
      sessionId: activeSession.id,
      anchor:
        focused instanceof HTMLElement
          ? focused.getBoundingClientRect()
          : undefined,
    };
  }
  if (isTextInsertionTarget(focused)) {
    return {
      kind: "text-input",
      element: focused,
      anchor: focused.getBoundingClientRect(),
    };
  }
  if (activeSession) {
    return { kind: "terminal", sessionId: activeSession.id };
  }
  return null;
}

async function insertVoiceText(
  target: VoiceTarget,
  text: string,
): Promise<void> {
  if (target.kind === "terminal") {
    await registry.write(
      target.sessionId,
      terminalTextForInsertion(target.sessionId, text, (sessionId) =>
        registry.bracketedPasteMode(sessionId),
      ),
    );
    return;
  }
  insertAtCaret(target.element, text);
}

// Which agent CLI the active terminal is running, so KödWhisper Pro can pick the
// right per-provider cleanup preset. Derived from the session's auto/base name
// (the foreground-process poller names it "claude"/"codex"/"grok").
function providerForActiveSession(): CleanupProvider {
  const state = appStore.getState();
  const projectId = state.activeProjectId;
  const sessionId = projectId
    ? state.activeSessionByProject[projectId]
    : undefined;
  const session = state.sessions.find((s) => s.id === sessionId);
  const label =
    `${session?.autoName ?? ""} ${session?.name ?? ""}`.toLowerCase();
  if (label.includes("claude")) return "claude";
  if (label.includes("codex")) return "codex";
  if (label.includes("grok")) return "grok";
  return "generic";
}

// Repo-relative file paths the user has already browsed (the lazily-loaded tree
// listings) — a cheap, bounded source to harvest identifiers from. No extra
// filesystem walk; vocabulary grows as the tree is explored.
function harvestFilesForRoot(root: string): string[] {
  const children = filesStore.getState().children;
  const paths: string[] = [];
  for (const entries of Object.values(children)) {
    for (const entry of entries) {
      if (!entry.isDir)
        paths.push(nativeRelativePath(entry.path, root) ?? entry.path);
    }
  }
  return paths;
}

// Terminals of the active project, in sidebar order — the list "switch to
// terminal N" indexes into (M9f).
function activeProjectSessions() {
  const state = appStore.getState();
  const projectId = state.activeProjectId;
  if (!projectId) return { projectId: null as string | null, sessions: [] };
  return {
    projectId,
    sessions: state.sessions.filter((s) => s.projectId === projectId),
  };
}

// KödWhisper Pro voice-command actions (M9f). Each maps onto an EXISTING app
// action, so voice commands inherit the same guards as the keyboard/sidebar
// paths and never open a parallel, unguarded route. Exported for direct unit
// testing — this wiring layer otherwise has no app-level test coverage.
export const voiceCommandActions = {
  sessionCount: () => activeProjectSessions().sessions.length,
  newSession: () => {
    const projectId = appStore.getState().activeProjectId;
    if (projectId) appStore.getState().addSession(projectId);
  },
  switchTerminal: (index: number): boolean => {
    const { projectId, sessions } = activeProjectSessions();
    const target = sessions[index - 1];
    if (!projectId || !target) return false; // out of range → graceful no-op
    appStore.getState().setActiveSession(projectId, target.id);
    return true;
  },
  nextTerminal: () => appStore.getState().cycleSession(1),
  prevTerminal: () => appStore.getState().cycleSession(-1),
  submit: async () => {
    // "send" submits the focused terminal by writing a lone carriage return
    // through the same PTY write path dictation uses — no synthesized keys.
    const state = appStore.getState();
    const projectId = state.activeProjectId;
    const sessionId = projectId
      ? state.activeSessionByProject[projectId]
      : undefined;
    if (!sessionId) return;
    // registry.write() rejects for a dead/closed session — catch it here so a
    // stale "send" can never surface as an unhandled promise rejection; it
    // must no-op gracefully like every other out-of-range voice command.
    await registry.write(sessionId, "\r").catch(() => undefined);
  },
};

// The KödWhisper Pro intelligence context for the active project (M9e): its
// harvested + user-defined vocabulary and the focused CLI's cleanup preset.
function resolveVoiceContext(): VoiceContext | null {
  const state = appStore.getState();
  const project = state.projects.find((p) => p.id === state.activeProjectId);
  if (!project) return null;
  const userTerms = state.voiceVocabulary[project.path] ?? [];
  const vocabulary = harvestVocabulary({
    files: harvestFilesForRoot(project.path),
    userTerms,
  });
  return { vocabulary, provider: providerForActiveSession() };
}

// KödWhisper is a separate product store, but its compact preferences use the
// existing app-data document so model choice and review behavior survive restarts.
export const voiceStore = createVoiceStore(
  {
    vox: tauriVox,
    models: new VoiceModelManager(tauriVox),
    resolveTarget: resolveVoiceTarget,
    insert: insertVoiceText,
    savePreferences: (preferences) =>
      appStore.getState().setVoicePreferences(preferences),
    openMicrophonePrivacySettings: () =>
      tauriExternalUrls.openMicrophonePrivacySettings(),
    // Pro gating (M9e): the real offline license gate fronts every Pro feature.
    hasFeature: (feature) => licenseHasFeature(feature),
    resolveContext: resolveVoiceContext,
    // Voice-command app actions (M9f, Pro).
    commands: voiceCommandActions,
  },
  appStore.getState().voicePreferences,
);

function syncVoiceShortcutOverrides(preferences: VoicePreferences): void {
  setComboOverrides({
    ...(preferences.pushToTalkCombo
      ? { "push-to-talk": preferences.pushToTalkCombo }
      : {}),
    ...(preferences.pushToTalkCommandCombo
      ? { "push-to-talk-command": preferences.pushToTalkCommandCombo }
      : {}),
  });
}

syncVoiceShortcutOverrides(appStore.getState().voicePreferences);

appStore.subscribe((state, previous) => {
  if (state.voicePreferences !== previous.voicePreferences) {
    voiceStore.setState({ preferences: state.voicePreferences });
    syncVoiceShortcutOverrides(state.voicePreferences);
  }
});
export const filesStore = createFilesStore({
  files: tauriFiles,
  // Persist open editor tabs per project (v1.1): map the files store's root
  // path back to its project id and record the tab list on the projects doc.
  onTabsChanged: (root, tabs) => {
    const state = appStore.getState();
    const project = state.projects.find((p) => p.path === root);
    const projectId =
      project?.id ??
      (remoteTargetForProjectId(state.remoteTargets, root) ? root : null);
    if (projectId) state.setOpenTabs(projectId, tabs);
  },
  onActivity: (fact) => {
    const state = appStore.getState();
    const project = state.projects.find((item) => item.path === fact.root);
    if (!project) return;
    activityAdapters.file(
      fact,
      project.id,
      state.activeSessionByProject[project.id] ?? null,
    );
  },
  onBrowserTabClosed: () => {
    void tauriBrowser.destroy(EDITOR_BROWSER_ID).catch(() => undefined);
  },
  onFileOpened: (root, path) => captureFileActivity(root, path, "fileOpened"),
  onFileSaved: (root, path) => captureFileActivity(root, path, "fileSaved"),
  // KödSSH (M11d): drop a closed remote tab's cached content so a later
  // reopen re-fetches/re-lists rather than showing stale state.
  onRemotePreviewClosed: (host, path) =>
    remoteFilesStore.getState().clearPreview(host, path),
  onRemoteFilesClosed: (host, path) =>
    remoteFilesStore.getState().clearListing({ host, path }),
});
export const githubStore = createGithubStore(tauriGithub);
// KödHarness (M10c): the full roster of CLIs kodade knows how to inspect.
// Every adapter always scans (so the free-tier lock row can honestly name
// "codex and grok also detected") — entitlements gate what the pane RENDERS,
// never what it scans.
export const harnessStore = createHarnessStore({
  config: tauriConfig,
  adapters: [
    createClaudeAdapter(tauriConfig),
    createCodexAdapter(tauriConfig),
    createGrokAdapter(tauriConfig),
    createOpencodeAdapter(tauriConfig),
    ...(RELEASE_MANIFEST.features.local
      ? [createKodadeLocalAdapter(tauriConfig)]
      : []),
  ],
});
// KödPR review store (M12c/M12d): the working-tree/branch diff surface. Runs
// the allowlisted read-only GitIpc shapes and refreshes off the same fs-watch
// seam the file tree uses (tauriFiles.onChanged), debounced. Reviewed
// checkmarks (Pro, M12d) persist through the projects document, keyed by
// project path — read/write goes through appStore so the schema/pruning rule
// lives in one place (store/projects.ts), not duplicated here.
export const reviewStore = createReviewStore({
  git: tauriGit,
  // PR scope (M12e) runs the same allowlisted `gh` surface the GitHub pane uses.
  github: tauriGithub,
  // send-to-agent writes the compiled fix prompt into a live session's PTY via
  // the terminal registry (registry.write → session.command → base64 → Rust).
  terminal: registry,
  watch: tauriFiles,
  reviewChecks: {
    load: (projectRoot, scopeKey) =>
      appStore.getState().reviewChecks[projectRoot]?.[scopeKey]?.paths ?? [],
    save: (projectRoot, scopeKey, paths) =>
      appStore.getState().setReviewChecks(projectRoot, scopeKey, paths),
  },
});
export const memoryStore = createMemoryStore({
  ipc: tauriMemory,
  onWorkspaceLinked: (workspace, previousRoot) => {
    rememberWorkspaceRegistration(workspace, previousRoot);
    const state = appStore.getState();
    const active = state.projects.find(
      (project) => project.id === state.activeProjectId,
    );
    if (active && nativeEquals(active.path, workspace.canonicalRoot)) {
      void activityPersistence.ensureInitialProjectOpened(active);
    }
  },
});

// KödSSH foundations (M11a): host list parsed from ~/.ssh/config, no UI yet.
// M11b's sidebar section calls init() (and any manual refresh) — nothing in
// this milestone triggers it automatically, same as harnessStore's rescan.
export const sshStore = createSshStore({ ssh: tauriSsh });

// KödSSH remote file tree (M11d, Pro): tree listing + read-only file preview
// over the same ssh_exec IPC, no dedicated init — RemoteFilesPane triggers
// listTarget()/fetchPreview() on demand (same lazy posture as sshStore.init).
export const remoteFilesStore = createRemoteFilesStore({ ssh: tauriSsh });

// Keep the file tree pointed at the active project: whenever the active
// project changes, re-root the tree (which stops the old watcher and starts
// the new one), then restore that project's persisted open tabs.
appStore.subscribe((state, prev) => {
  if (state.activeProjectId === prev.activeProjectId) return;
  const previousProject = prev.projects.find(
    (p) => p.id === prev.activeProjectId,
  );
  const project = state.projects.find((p) => p.id === state.activeProjectId);
  const remoteProjectId =
    state.activeProjectId &&
    remoteTargetForProjectId(state.remoteTargets, state.activeProjectId)
      ? state.activeProjectId
      : null;
  void activityPersistence.projectSelectionChanged(
    previousProject ?? null,
    project ?? null,
  );
  void synchronizeProjectFiles(
    project?.path ?? null,
    project?.id ?? remoteProjectId,
  ).catch(
    (error) => {
      console.error("kodade: active project file sync failed:", error);
    },
  );
});

let projectFilesSync:
  | {
      root: string | null;
      projectId: string | null;
      promise: Promise<void>;
    }
  | undefined;

function synchronizeProjectFiles(
  root: string | null,
  projectId: string | null,
): Promise<void> {
  if (
    projectFilesSync &&
    projectFilesSync.root === root &&
    projectFilesSync.projectId === projectId
  ) {
    return projectFilesSync.promise;
  }
  const promise = rerootAndRestoreTabs(root, projectId);
  projectFilesSync = { root, projectId, promise };
  void promise.catch(() => {
    if (projectFilesSync?.promise === promise) projectFilesSync = undefined;
  });
  return promise;
}

// Re-root the tree, then restore the project's persisted tabs onto the new
// root. Sequenced so restoreTabs sees the current rootPath (it bails otherwise).
async function rerootAndRestoreTabs(
  root: string | null,
  projectId: string | null,
) {
  if (!root && projectId) {
    await filesStore.getState().setRemoteScope(projectId);
  } else {
    await filesStore.getState().setRoot(root);
  }
  if (!projectId) return;
  const scope = root ?? projectId;
  // Only restore when the files store has nothing open for this root yet, so a
  // return visit within one session keeps its live tabs instead of reverting.
  if (filesStore.getState().getTabsForRoot(scope).length > 0) return;
  const saved = appStore.getState().openTabs[projectId];
  if (saved && saved.length > 0)
    await filesStore.getState().restoreTabs(scope, saved);
}

// Global keyboard shortcuts (M6a). Actions are wired to the two stores; the
// terminal-focus probe checks whether the event target OR the focused element
// sits inside a live terminal host, so bare keys stay with the shell.
export function installAppShortcuts(): () => void {
  return installShortcuts({
    actions: {
      toggleSidebar: () => appStore.getState().toggleSidebarMode(),
      toggleFiles: () => appStore.getState().toggleFilesPanel(),
      newSession: () => {
        const projectId = appStore.getState().activeProjectId;
        if (projectId) appStore.getState().addSession(projectId);
      },
      saveFile: () => void filesStore.getState().saveFile(),
      nextSession: () => appStore.getState().cycleSession(1),
      prevSession: () => appStore.getState().cycleSession(-1),
      nextProject: () => appStore.getState().cycleProject(1),
      prevProject: () => appStore.getState().cycleProject(-1),
      closeTab: () => {
        const active = filesStore.getState().activeTab;
        if (active) filesStore.getState().closeTab(active);
      },
      nextTab: () => filesStore.getState().cycleTab(1),
      prevTab: () => filesStore.getState().cycleTab(-1),
      startVoice: () => void voiceStore.getState().press(),
      startVoiceCommand: () => void voiceStore.getState().pressCommand(),
      stopVoice: () => void voiceStore.getState().release(),
      cancelVoice: () => void voiceStore.getState().cancelCapture(),
    },
    isTerminalFocused: (target) =>
      registry.containsNode(target as Node | null) ||
      registry.containsNode(document.activeElement),
    // Focus inside CodeMirror (the .cm-editor wrapper) means the editor's own
    // Mod-s keymap owns save; the global handler defers so it can't double-fire.
    isEditorFocused: (target) =>
      isInCodeMirror(target as Node | null) ||
      isInCodeMirror(document.activeElement),
  });
}

// True when `node` sits inside a CodeMirror editor instance.
function isInCodeMirror(node: Node | null): boolean {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return !!el?.closest(".cm-editor");
}

// KödChat threads (issue #163). Transcripts live in their own per-thread
// documents; the projects store still owns each thread's identity as a session
// of kind "chat".
//
// The activity hooks below are the privacy boundary in practice: they forward
// ids and a fixed status reason, so the sidebar can show working/needs-you
// without any transcript text ever reaching the Activity module or KödMem.
export const chatStore = createChatStore({
  agent: tauriAgent,
  storage: tauriStorage,
  projectRoot: (projectId) =>
    appStore.getState().projects.find((project) => project.id === projectId)
      ?.path ?? null,
  remoteTarget: (projectId) =>
    RELEASE_MANIFEST.features.ssh &&
    entitlements.hasFeature(FEATURES.sshPro)
      ? remoteTargetForProjectId(appStore.getState().remoteTargets, projectId)
      : null,
  activity: {
    streamed: (projectId, threadId) =>
      activityAdapters.terminalOutput(projectId, threadId),
    attention: (projectId, threadId, reason) =>
      activityModule.observe(
        reason === null
          ? {
              type: "attention-reported",
              projectId,
              sessionId: threadId,
              attention: "none",
              provenance: "provider",
              at: Date.now(),
            }
          : {
              type: "attention-reported",
              projectId,
              sessionId: threadId,
              attention: "needs-user",
              provenance: "provider",
              reason,
              at: Date.now(),
            },
      ),
  },
});

// Provider detection/launch. Launch delegates to the projects store, which owns
// sessions — that's the one-way seam the providers store depends on.
export const providersStore = createProvidersStore({
  ipc: tauriProvider,
  local: tauriLocal,
  providers: AVAILABLE_PROVIDERS,
  launch: (command, base) => appStore.getState().launchInSession(command, base),
  hasFeature: (feature) => licenseHasFeature(feature),
  isDesktop: isTauriRuntime(),
  isRemoteProject: () => {
    const state = appStore.getState();
    return (
      RELEASE_MANIFEST.features.ssh &&
      entitlements.hasFeature(FEATURES.sshPro) &&
      !!state.activeProjectId &&
      !!remoteTargetForProjectId(state.remoteTargets, state.activeProjectId)
    );
  },
});

// Theme store: owns selection + resolution; side effects injected here. `apply`
// drives all three surfaces from one Theme — CSS vars for the UI chrome and the
// xterm palette via the registry (the editor subscribes to the store itself).
// `save` records the choice in the persisted projects doc. `prefersDark` reads
// the OS appearance (default when no matchMedia, e.g. tests → dark).
const darkQuery =
  typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;
export const themeStore = createThemeStore({
  prefersDark: () => darkQuery?.matches ?? true,
  save: (selection) => appStore.getState().setTheme(selection),
  apply: (theme) => {
    applyCssVars(theme);
    registry.setTheme(toXtermTheme(theme));
  },
});

// Live system-following: when the OS flips dark/light, re-resolve (a no-op
// unless the selection is "system"). Registered once at module load.
darkQuery?.addEventListener("change", () => {
  themeStore.getState().systemAppearanceChanged();
});

// One-time bootstrap: shell name, persisted projects, drag-and-drop listener.
// Guarded so StrictMode's double effect can't run it twice.
let initStarted = false;

async function installAutomaticBrowserAgentSetup(): Promise<void> {
  await providersStore.getState().detectAll();
  const installedClis = Object.entries(providersStore.getState().statuses)
    .filter(([, status]) => status.status === "installed")
    .map(([id]) => id);
  const binary = await tauriMemory.mcpBinaryPath();
  if (!binary.exists || !binary.path) {
    throw new Error("the bundled KödBrowser adapter was not found");
  }
  const result = await ensureBrowserAgentSetup({
    config: tauriConfig,
    binaryPath: binary.path,
    installedClis,
  });
  for (const error of result.errors) {
    console.warn(`kodade: browser agent setup: ${error}`);
  }
}

async function routeBrowserForAgent(event: {
  projectRoot: string;
  url: string | null;
}): Promise<void> {
  const routed = await activateBrowserForAgent(event, {
    projects: appStore.getState().projects,
    setActiveProject: (id) => appStore.getState().setActiveProject(id),
    syncProjectFiles: (path, id) => synchronizeProjectFiles(path, id),
    openBrowserTab: () => filesStore.getState().openBrowserTab(),
    setBrowserUrl: (url) => filesStore.getState().setBrowserUrl(url),
  });
  if (!routed) {
    console.warn(
      `kodade: browser agent requested an unopened project: ${event.projectRoot}`,
    );
  }
}

export async function initApp(): Promise<void> {
  if (initStarted) return;
  initStarted = true;

  // Paint the default (system-following) theme immediately so the app never
  // renders unstyled; the persisted choice is applied after hydrate() below.
  themeStore.getState().reapply();

  // Wire global keyboard shortcuts once (lives for the app's lifetime).
  installAppShortcuts();
  if (RELEASE_MANIFEST.features.voice) voiceStore.getState().start();
  // KödChat listens for agent run events for the app's lifetime, so a thread
  // keeps streaming while the user works in another pane or project.
  void chatStore
    .getState()
    .start()
    .catch((error) => {
      console.error("kodade: unable to listen for KödChat run events", error);
    });
  if (isTauriRuntime()) {
    void tauriBrowser
      .onAgentActivate((event) => {
        void routeBrowserForAgent(event);
      })
      .catch((error) => {
        console.error("kodade: unable to install browser agent activation", error);
      });
  }

  // Persist the final active-project close metadata before the app goes away.
  // Desktop uses Tauri's cancellable close request (bounded so shutdown never
  // waits indefinitely on local storage); a browser preview uses lifecycle
  // events because it has no cancellable native close request.
  const activeProjectForClose = () => {
    const state = appStore.getState();
    return (
      state.projects.find((project) => project.id === state.activeProjectId) ??
      null
    );
  };
  if (isTauriRuntime()) {
    void installTauriCloseCapture({
      appWindow: getCurrentWindow(),
      activeProject: activeProjectForClose,
      bridge: activityPersistence,
    }).catch((error) => {
      console.error("kodade: unable to install final activity capture", error);
    });
  } else {
    installWebCloseCapture({
      activeProject: activeProjectForClose,
      bridge: activityPersistence,
    });
  }

  try {
    appStore.getState().setShellBase(await tauriPlatform.shellName());
  } catch (err) {
    console.error("kodade: shell name lookup failed:", err);
  }

  // Detect installed agents and silently wire their unqualified browser use to
  // Kodade's visible internal browser. Settings can still refresh detection.
  if (isTauriRuntime()) {
    void installAutomaticBrowserAgentSetup().catch((error) => {
      console.error("kodade: automatic browser agent setup failed:", error);
    });
  } else {
    void providersStore.getState().detectAll();
  }

  // Poll foreground processes so sessions auto-name themselves ("claude") and
  // the status dot pulses while an agent runs. Cheap: visible sessions only,
  // paused when the window is hidden. Lives for the app's lifetime.
  appStore.getState().startForegroundPolling();

  // Refresh the tree live as the watcher reports filesystem changes.
  await filesStore.getState().startWatchingChanges();
  let commitObservation: ReturnType<typeof setTimeout> | null = null;
  const pendingCommitRoots = new Set<string>();
  await tauriFiles.onChanged((event) => {
    const roots = rootsWithGitCheckpointEvents(
      event.paths,
      appStore.getState().projects.map((project) => project.path),
    );
    if (roots.length === 0) return;
    for (const root of roots) pendingCommitRoots.add(root);
    if (commitObservation !== null) clearTimeout(commitObservation);
    commitObservation = setTimeout(() => {
      commitObservation = null;
      const observedRoots = [...pendingCommitRoots];
      pendingCommitRoots.clear();
      for (const root of observedRoots) {
        void observeProjectCommit(root);
      }
    }, 250);
  });

  try {
    await appStore.getState().hydrate();
    // Adopt the persisted theme selection now that it's loaded (an unknown id
    // resolves back to system-following inside the theme store).
    themeStore.getState().setSelection(appStore.getState().theme);
    // hydrate() may set the active project without a change event the
    // subscriber saw, so point the tree at it explicitly on first boot.
    const active = appStore.getState();
    const activeProject = active.projects.find(
      (p) => p.id === active.activeProjectId,
    );
    if (activeProject) {
      await synchronizeProjectFiles(activeProject.path, activeProject.id);
      await activityPersistence.ensureInitialProjectOpened(activeProject);
    }
  } catch (err) {
    // hydrate() shields itself, but drag-drop below must register regardless.
    console.error("kodade: hydrate failed:", err);
  } finally {
    await tauriPlatform.onFileDrop((drop) => {
      void routeFileDrop(drop, {
        platform: tauriPlatform,
        projects: appStore,
        registry,
      });
    });
  }
}

async function observeProjectCommit(projectRoot: string) {
  try {
    const workspace = await tauriMemory.resolveWorkspace(projectRoot);
    if (!workspace) return;
    const head = (await tauriGit.run(projectRoot, ["rev-parse", "--verify", "HEAD"]))
      .stdout.trim();
    if (!head) return;
    const checkpoint = await tauriMemory.observeCommit(workspace.id, head);
    if (checkpoint && memoryStore.getState().workspace?.id === workspace.id) {
      await memoryStore.getState().refresh();
    }
  } catch (error) {
    console.error("kodade: working-memory commit observation failed:", error);
  }
}

function captureFileActivity(
  root: string,
  path: string,
  kind: "fileOpened" | "fileSaved",
) {
  const project = appStore
    .getState()
    .projects.find((candidate) => candidate.path === root);
  const relativePath = nativeRelativePath(path, root);
  if (project && relativePath) {
    const sessionId = appStore.getState().activeSessionByProject[project.id] ?? null;
    void activityPersistence.recordActivity(project, kind, { relativePath, sessionId });
  }
}
