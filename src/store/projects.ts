// Projects + sessions store (Zustand vanilla, headless-testable). All deps —
// storage IPC and the terminal registry — are injected, so tests drive it with
// mocks. The persisted document's shape and versioning live HERE, not in Rust.

import { createStore } from "zustand/vanilla";
import type { WorkspaceActivityFact } from "../activity/adapters";
import type { ForegroundIpc, StorageIpc } from "../ipc/contract";
import type { RemoteTarget } from "../ssh/model";
import {
  isRemoteSessionName,
  parseRemoteTarget,
  remoteProjectId,
  remoteSessionBase,
  remoteTargetForProjectId,
  remoteTargetKey,
} from "../ssh/model";
import { buildSshProjectLaunch } from "../ssh/command";
import {
  isProjectColorId,
  normalizeProjectColorId,
} from "../projects/colors";
import { chatProviderIds } from "../agents/registry";
import { normalizeAmbientOverride } from "../harness/ambient";
import {
  defaultShellLayout,
  isShellLayout,
  migrateShellLayout,
  type ShellLayout,
} from "../components/shell/shell-layout";
import {
  DEFAULT_VOICE_PREFERENCES,
  normalizeVoicePreferences,
  type VoicePreferences,
} from "../voice/models";
import {
  DEFAULT_LOCAL_MODEL_PREFERENCES,
  normalizeLocalModelPreferences,
  type LocalModelPreferences,
} from "../local/models";
import {
  nativeBasename,
  nativeEquals,
  normalizeNativeAbsolutePath,
} from "../platform/native-path";

export type Project = {
  id: string;
  name: string;
  path: string;
  color?: string;
};
// What a session actually is. Absent means "pty" so every persisted document
// written before KödChat migrates untouched — the discriminant is additive,
// never a required field. "work" (KödWork, #43) follows the same rule.
export type SessionKind = "pty" | "chat" | "work";

export type SessionMeta = {
  id: string;
  projectId: string;
  // KödChat (issue #163): a chat thread is a session too, so it inherits
  // sidebar grouping, naming, workspaces, and persistence for free. The one
  // behavioural difference is that it owns NO terminal — addSession skips
  // registry.open() for it, and its transcript lives in its own document.
  kind?: SessionKind;
  // Split terminals share their root terminal's workspace id. The root omits
  // this field (its workspace id is its own id), so old documents naturally
  // remain one-workspace-per-session.
  workspaceId?: string;
  name: string; // the base name ("zsh 1", or a manual rename)
  exited?: boolean; // shell died (or never started); terminal shows why
  // A manual rename locks the name: auto-naming never touches a locked session,
  // ever (the manual name always wins). Set true by renameSession.
  nameLocked?: boolean;
  // Foreground-process auto-name ("claude", "vitest", …) shown in place of the
  // base name while a command runs. Cleared when the foreground returns to the
  // shell. Only ever set on unlocked sessions. Runtime-only; never persisted.
  autoName?: string;
  // Session was launched as a remote SSH terminal (KödSSH M11b). Set at
  // creation from the `ssh ` base-name convention, persisted, and — unlike the
  // name prefix — survives a manual rename. A desktop reload skips it because
  // the ssh process died with the app; reviving would boot a mislabeled local
  // shell.
  remote?: boolean;
};

// What the sidebar shows for a session: the base name unless an auto-name is in
// effect (and the session isn't manually locked). Manual names always win.
export function sessionDisplayName(s: SessionMeta): string {
  if (s.nameLocked) return s.name;
  return s.autoName ?? s.name;
}

// True for a KödChat thread. Everything that owns or polls a PTY must check
// this — a chat session has no terminal to write to, resize, or foreground.
export function isChatSession(s: SessionMeta): boolean {
  return s.kind === "chat";
}

// True for a KödWork task (#43). Like a chat thread it owns no PTY; its task
// document lives in the kodwork store keyed by this session's id.
export function isWorkSession(s: SessionMeta): boolean {
  return s.kind === "work";
}

// Sessions with no PTY behind them: chat threads and KödWork tasks. Every
// registry open/close/poll path must skip these.
function ownsNoPty(s: SessionMeta): boolean {
  return isChatSession(s) || isWorkSession(s);
}

// Persisted pane sizes for the 4-pane layout, as react-resizable-panels
// percentages in panel order: [sidebar, terminal, files, editor]. Pane geometry
// is an app-level preference: switching projects or chats must not move it.
export type PaneSizes = number[];
export type SidebarMode = "full" | "rail";

// The slice of the terminal registry the store needs (real: SessionRegistry).
export type RegistryLike = {
  open(id: string, cwd: string): void | Promise<void>;
  ready?(id: string): Promise<void>;
  close(id: string): Promise<void>;
  paste?(id: string, data: string): void | Promise<void>; // queueable user input
  write(id: string, data: string): void | Promise<void>; // command into a session's PTY
};

export type StoreDeps = {
  storage: StorageIpc;
  registry: RegistryLike;
  newId?: () => string; // injectable for deterministic tests
  // Resolve symlinks//tmp-style aliases so dedupe compares real locations.
  // Optional: identity when absent (tests, non-Tauri contexts).
  canonicalize?: (path: string) => Promise<string>;
  // Notified when a project is removed, with its (normalized) path — the app
  // wires this to the files store so its per-root open-tab closure is pruned
  // (v1.1). Optional: tests that don't care omit it.
  onProjectRemoved?: (path: string) => void;
  // Low-sensitivity lifecycle hooks for KödMem. They receive IDs/provider
  // names only, never PTY output or command text.
  onSessionStarted?: (
    project: Project,
    session: SessionMeta,
    provider: string | null,
  ) => void;
  onSessionExited?: (project: Project, session: SessionMeta) => void;
  // A session was closed and is gone from the store. KödChat wires this to
  // drop the thread's transcript document, so closing a chat thread doesn't
  // leave an orphaned file behind. Metadata only — never transcript text.
  onSessionRemoved?: (session: SessionMeta) => void;
  // Foreground-process lookup (real: tauriForeground). Absent = auto-naming off
  // (tests that don't exercise it, non-Tauri contexts). Injected so poller tests
  // drive it with a mock.
  foreground?: ForegroundIpc;
  // Low-sensitivity lifecycle/foreground facts for the Activity module. The
  // adapter adds timestamps; the store never knows how a sidebar is projected.
  onActivity?: (fact: WorkspaceActivityFact) => void;
  // Timer + visibility injection so the poller is headless-testable with fake
  // timers. Default to the real globals; tests pass deterministic stand-ins.
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (h: ReturnType<typeof setInterval>) => void;
  isHidden?: () => boolean; // skip polling when the window is hidden (document.hidden)
  pollIntervalMs?: number; // default FOREGROUND_POLL_MS
  // Runtime entitlement seam for pinned remote projects. Persistence still
  // retains pins while access is unavailable; activation/execution stays shut.
  canUseRemote?: () => boolean;
  // Legacy store consumers can opt into the old root-terminal behavior. The
  // desktop app disables it so entering a project remains chat-first.
  autoStartTerminal?: boolean;
};

// One persisted terminal-session identity: enough to recreate local sessions
// with stable ids after an app restart. Runtime fields (exited, autoName) are
// never persisted; nameLocked survives so a manual rename does. `remote`
// marks SSH sessions so they can be skipped after their process has exited.
export type PersistedSession = {
  id: string;
  name: string;
  workspaceId?: string;
  nameLocked?: boolean;
  remote?: boolean;
  // KödChat "chat" or KödWork "work". Absent restores a terminal session,
  // which is exactly what every pre-KödChat document should do.
  kind?: SessionKind;
};

// Persisted JSON schema, version-gated so later tickets can migrate it.
export const STORAGE_VERSION = 1;
export type MemoryAgentAccessPreference = {
  enabled: boolean;
  access: "read-only" | "read-write";
};

export const DEFAULT_MEMORY_AGENT_ACCESS: MemoryAgentAccessPreference = {
  enabled: false,
  access: "read-write",
};

export type PersistedDoc = {
  version: number;
  projects: Project[];
  activeProjectId: string | null;
  // Optional and additive (still STORAGE_VERSION 1): app-level pane sizes.
  // hydrate() tolerates it being absent or malformed.
  layout?: PaneSizes;
  // Legacy per-project pane sizes. Read only to migrate an existing user's
  // active-project layout into the app-level `layout` preference.
  layouts?: Record<string, PaneSizes>;
  // Optional and additive (still STORAGE_VERSION 1): app-level theme selection —
  // a theme id, or "system" (the default when absent). hydrate() tolerates it
  // being absent or non-string; the theme store validates the id itself.
  theme?: string;
  // Optional and additive (still STORAGE_VERSION 1): the provider new KödChat
  // threads start on. A PREFERENCE, not transcript — transcripts live in their
  // own per-thread documents and never enter this one. Absent or unknown falls
  // back to the first chat-capable provider in the catalog.
  chatProvider?: string;
  // Optional and additive (still STORAGE_VERSION 1): projects sidebar density.
  // Missing or invalid values retain the first-run full sidebar.
  sidebarMode?: SidebarMode;
  // Optional and additive (still STORAGE_VERSION 1): whether the right files
  // pane is collapsed to its narrow rail. Missing or invalid stays expanded.
  filesCollapsed?: boolean;
  // Optional and additive (still STORAGE_VERSION 1): per-project ordered tab
  // encodings. Legacy values are unchanged file paths; non-file tabs reserve
  // prefixes such as `github:`.
  openTabs?: Record<string, string[]>;
  // Optional and additive (still STORAGE_VERSION 1): KödWhisper's selected
  // model, downloaded models, and review preference.
  voice?: VoicePreferences;
  // Optional and additive (still STORAGE_VERSION 1): KödLocal's downloaded
  // catalog entries, custom GGUF paths, and raw-chat context choice.
  local?: LocalModelPreferences;
  // Optional and additive (still STORAGE_VERSION 1): one-time consent for
  // Ködade to keep supported agent connectors reconciled as mapped projects
  // become active. Disabled by default; the Connect agents review flow turns
  // it on only after a successful, explicitly approved batch.
  memoryAgentAccess?: MemoryAgentAccessPreference;
  // Optional and additive (still STORAGE_VERSION 1): KödPR reviewed-file
  // checkmarks (M12d, Pro). Keyed by project PATH (not id — the review store
  // only knows project roots, not the projects-store id), then by a review
  // scope key ("worktree", or "branch:<headBranch>:<base>" — see
  // review.ts's reviewScopeKey). hydrate() tolerates it being absent or
  // malformed, and caps each project to MAX_REVIEW_SCOPES_PER_PROJECT entries
  // (oldest `updatedAt` evicted first) so reviewing many short-lived feature
  // branches can't grow this file forever.
  reviewChecks?: Record<string, Record<string, ReviewCheckEntry>>;
  // Optional and additive (still STORAGE_VERSION 1): KödWhisper Pro per-project
  // user-defined vocabulary terms (M9e), keyed by project PATH. Harvested repo
  // symbols are derived at runtime and never persisted — only the user's own
  // terms live here. hydrate() tolerates it being absent or malformed.
  voiceVocabulary?: Record<string, string[]>;
  // Optional and additive (still STORAGE_VERSION 1): pinned remote projects
  // (KödSSH Pro, M11c). {host, path} entries the user pinned from the Remote
  // sidebar. hydrate() tolerates it being absent or partly corrupt (each entry
  // is validated by parseRemoteTarget). Not gated here — the doc just records
  // them; the UI gates pinning/detection/launch behind ssh.pro.
  remoteTargets?: RemoteTarget[];
  // Optional and additive (still STORAGE_VERSION 1): per-project terminal
  // session identities. A reload recreates local sessions with these ids.
  // Remote SSH sessions are skipped instead of respawning as local shells
  // (#121).
  sessions?: Record<string, PersistedSession[]>;
  // Optional and additive (still STORAGE_VERSION 1): the v2 tabbed shell's
  // layout document (issue #62). Typed as unknown because migrateShellLayout
  // owns the validation and tolerates any shape, including the legacy v1
  // `layout` array it falls back to on a user's first v2 boot.
  shell?: unknown;
  // Optional and additive (still STORAGE_VERSION 1): whether the v2 shell is
  // switched on. Development builds only — the manifest gates the surface, so
  // a `true` here does nothing in a public build. Absent/invalid = false.
  shellV2?: boolean;
  // Optional and additive (still STORAGE_VERSION 1): the Ködade background
  // prompt (issue #63). Absent means "on, with no override" — the default
  // text ships in harness/ambient.ts, never in this document, so improving it
  // doesn't require migrating anyone's settings. An override longer than
  // MAX_AMBIENT_PROMPT_LENGTH is capped on read.
  ambientPromptEnabled?: boolean;
  ambientPromptOverride?: string;
};

// One review-scope's reviewed-path set plus a write timestamp, used only to
// decide which entries to evict once a project exceeds the scope cap.
export type ReviewCheckEntry = { paths: string[]; updatedAt: number };

// Cap on how many review-scope entries (distinct branch identities) one
// project may keep reviewed-checkmarks for. A user reviewing many short-lived
// feature branches would otherwise grow this list forever; capping to the
// most-recently-touched entries keeps the document bounded while still
// covering realistic multi-branch review sessions.
const MAX_REVIEW_SCOPES_PER_PROJECT = 20;

// Bounds for KödWhisper Pro per-project user vocabulary (M9e). The add-a-term
// UI has no client-side limit, so without a cap a pasted wall of text (the
// plain <input> allows arbitrarily long pasted values) or a long tinkering
// session could grow this project's slice of the persisted doc without bound.
// Term count is capped like review scopes (oldest dropped first); each term's
// length is capped too since a "term" is meant to be an identifier/path, not
// prose.
const MAX_VOICE_VOCABULARY_TERMS_PER_PROJECT = 200;
const MAX_VOICE_VOCABULARY_TERM_LENGTH = 200;

// Optional creation-time discriminant for addSession. Absent = a terminal
// session, so every existing caller keeps its exact behaviour.
export type AddSessionOptions = {
  kind?: SessionKind;
  // Trusted remote-shell command for an explicitly launched remote terminal.
  // Omitted means open the user's login shell in the pinned project path.
  remoteCommand?: string;
  // Explicit request for a project-scoped standalone terminal, permitted even
  // in the chat-first (autoStartTerminal === false) runtime. This is the escape
  // hatch for login/agent terminals that need a host when no chat is selected
  // (v2.0 P4 slice 3); routine selection paths still never auto-spawn a root.
  projectScopedTerminal?: boolean;
};

export type ProjectsState = {
  projects: Project[];
  // Session IDENTITY (id/name/lock/remote) persists while runtime fields
  // (exited, autoName) never do. Shells die with the app; a restored local id
  // spawns fresh, and remote SSH identities are skipped entirely (#121).
  sessions: SessionMeta[];
  activeProjectId: string | null;
  activeSessionByProject: Record<string, string>;
  layout: PaneSizes | undefined; // app-level pane sizes shared by every project/chat
  // v2 tabbed shell (issue #62): its own layout document, and whether the shell
  // is switched on at all. Both are inert unless the build carries the `shell`
  // development feature.
  shellLayout: ShellLayout;
  shellV2Enabled: boolean;
  theme: string; // app-level theme selection ("system" or a theme id)
  chatProvider: string; // provider id new KödChat threads start on
  sidebarMode: SidebarMode; // full project/session list, or compact icon rail
  filesCollapsed: boolean; // right files pane collapsed to its narrow rail
  openTabs: Record<string, string[]>; // per-project encoded editor tabs
  voicePreferences: VoicePreferences; // app-level KödWhisper preferences
  localModelPreferences: LocalModelPreferences;
  memoryAgentAccess: MemoryAgentAccessPreference;
  // Ködade's background prompt (issue #63): whether agents Ködade launches
  // receive it at all, and the user's replacement text (null = the default).
  ambientPromptEnabled: boolean;
  ambientPromptOverride: string | null;
  // KödPR reviewed-file checkmarks (M12d, Pro), keyed by project path then
  // review-scope key. See PersistedDoc.reviewChecks for the shape/pruning rule.
  reviewChecks: Record<string, Record<string, ReviewCheckEntry>>;
  // KödWhisper Pro per-project user vocabulary terms (M9e), keyed by project path.
  voiceVocabulary: Record<string, string[]>;
  remoteTargets: RemoteTarget[]; // pinned remote projects (KödSSH Pro, M11c)
  shellBase: string; // login shell basename for default session names
  // Per-project session-list expansion. Session-local (NOT persisted):
  // missing/false = collapsed, true = expanded. Activating a project expands it
  // without changing any other project's disclosure state.
  expandedProjects: Record<string, boolean>;

  hydrate(): Promise<void>;
  // Force any pending debounce and wait until every scheduled settings write
  // has landed. Useful at lifecycle boundaries and for deterministic tests.
  flushPersistence(): Promise<void>;
  addProject(path: string): Promise<void>;
  removeProject(id: string): Promise<void>;
  setActiveProject(id: string): Promise<void>;
  addSession(
    projectId: string,
    base?: string,
    workspaceId?: string,
    options?: AddSessionOptions,
  ): string | null;
  addTerminal(projectId: string, workspaceId: string, base?: string): string | null;
  // KödChat: a session with kind "chat" and no PTY (issue #163).
  addChatThread(projectId: string, base: string): string | null;
  // KödWork (#43): a session with kind "work" and no PTY. Local projects only;
  // never changes the active selection.
  addWorkSession(projectId: string): string | null;
  launchInSession(command: string, base: string): Promise<void>;
  closeSession(id: string): Promise<void>;
  closeWorkspace(id: string): Promise<void>;
  setActiveSession(projectId: string, sessionId: string): void;
  // Select a session from any project's expanded list. Project and session
  // update together so the terminal, files, and sidebar stay in sync.
  activateSession(projectId: string, sessionId: string): Promise<void>;
  // Keyboard cycling (M6a). Wrap around the ordered list; no-op when there's
  // nothing (or only one) to switch to.
  cycleSession(direction: 1 | -1): void;
  cycleProject(direction: 1 | -1): Promise<void>;
  setLayout(sizes: PaneSizes): void;
  // Record the v2 shell's layout (active tab, splits) and persist debounced.
  // Rejects a document isShellLayout doesn't accept.
  setShellLayout(next: ShellLayout): void;
  // Turn the v2 shell on/off. Development-only affordance; the release
  // manifest still decides whether the shell exists in this build.
  setShellV2Enabled(enabled: boolean): void;
  setTheme(theme: string): void;
  // Record which provider new KödChat threads start on. Existing threads keep
  // whatever provider they were created with.
  setChatProvider(providerId: string): void;
  setSidebarMode(mode: SidebarMode): void;
  toggleSidebarMode(): void;
  // Collapse/expand the right files pane to/from its narrow rail (issue #8).
  setFilesCollapsed(collapsed: boolean): void;
  toggleFilesPanel(): void;
  // Set a picked palette id, or null to return to deterministic auto-color.
  setProjectColor(projectId: string, colorId: string | null): void;
  // Record a project's open editor tabs (v1.1) and persist (debounced, like
  // layout changes — opening/closing tabs shouldn't hammer the disk). No-op for an
  // unknown project id.
  setOpenTabs(projectId: string, paths: string[]): void;
  setVoicePreferences(preferences: VoicePreferences): void;
  setLocalModelPreferences(preferences: LocalModelPreferences): void;
  setMemoryAgentAccess(preference: MemoryAgentAccessPreference): void;
  // Ködade background prompt (issue #63).
  setAmbientPromptEnabled(enabled: boolean): void;
  setAmbientPromptOverride(text: string | null): void;
  // Record one review scope's reviewed-path set for `projectRoot` (KödPR,
  // M12d) and persist debounced, like setOpenTabs. No-op for a project whose
  // path isn't currently tracked. Caps the project's scope-entry count (see
  // MAX_REVIEW_SCOPES_PER_PROJECT), evicting the oldest-updated entries first.
  setReviewChecks(projectRoot: string, scopeKey: string, paths: string[]): void;
  // Record a project's KödWhisper Pro user-defined vocabulary terms (M9e),
  // keyed by project path, and persist debounced. No-op for an untracked path.
  setVoiceVocabularyTerms(projectRoot: string, terms: string[]): void;
  // Pin a remote {host, path} as a project (KödSSH Pro, M11c) and persist.
  // Idempotent — pinning an already-pinned target is a no-op. Gating is the
  // caller's concern; the store only records.
  pinRemoteTarget(target: RemoteTarget): void;
  // Unpin a previously pinned remote target (matched by host+path) and persist.
  unpinRemoteTarget(target: RemoteTarget): void;
  markSessionExited(id: string): void;
  setShellBase(name: string): void;
  // Manual inline rename (double-click a session row). Empty/whitespace reverts
  // to the current name (no-op). A successful rename LOCKS the name so auto-
  // naming can never overwrite it, and clears any auto-name in effect.
  renameSession(id: string, name: string): void;
  // Toggle a project's session-list expansion (chevron in the sidebar).
  toggleProjectExpanded(projectId: string): void;
  // Foreground-process poller lifecycle. start() begins the interval (idempotent);
  // stop() clears it. pollForeground() is one tick — exported so tests can drive
  // it directly without a timer.
  startForegroundPolling(): void;
  stopForegroundPolling(): void;
  pollForeground(): Promise<void>;
};

// A persisted project entry is only trusted if every field is a string —
// hand-edited or partially-corrupt docs must not abort hydration (finding:
// a single null entry used to throw and leave init permanently broken).
function parseProject(p: unknown): Project | null {
  if (typeof p !== "object" || p === null) return null;
  const c = p as Record<string, unknown>;
  if (
    typeof c.id !== "string" ||
    typeof c.name !== "string" ||
    typeof c.path !== "string"
  ) {
    return null;
  }
  // Colors were added additively: preserve or migrate a recognized palette id,
  // while a hand-edited/obsolete value returns to stable auto assignment.
  const color = normalizeProjectColorId(c.color);
  return color
    ? { id: c.id, name: c.name, path: c.path, color }
    : { id: c.id, name: c.name, path: c.path };
}

// Strip trailing slashes so "/a/b/" and "/a/b" are the same project.
function normalizePath(path: string): string {
  return normalizeNativeAbsolutePath(path) || path;
}

// A valid PaneSizes entry: exactly 4 non-negative percentages summing to ~100
// (collapsed panes persist as 0, so tolerance covers rounding only). Guards
// against a hand-edited doc — e.g. [0,0,0,0] would otherwise restore a layout
// with every pane crushed.
function isPaneSizes(v: unknown): v is PaneSizes {
  if (!Array.isArray(v) || v.length !== 4) return false;
  if (!v.every((n) => typeof n === "number" && isFinite(n) && n >= 0))
    return false;
  const sum = v.reduce((a, b) => a + b, 0);
  return sum >= 90 && sum <= 110;
}

// Structural equality for two v2 shell layouts, used only for cheap "did
// anything actually change?" checks.
//
// Field-compared rather than stringified: JSON.stringify is key-ORDER
// sensitive, and while every layout in practice originates from
// defaultShellLayout/migrateShellLayout (or a spread of one, which preserves
// order), that is an invariant a caller could quietly break by rebuilding the
// object literal by hand. A false "changed" would cost an extra disk write; a
// field compare can't be fooled at all.
function sameShellLayout(a: ShellLayout, b: ShellLayout): boolean {
  return (
    a.version === b.version &&
    a.activeTab === b.activeTab &&
    a.sidebarPct === b.sidebarPct &&
    a.code.mode === b.code.mode &&
    a.code.chatPct === b.code.chatPct &&
    a.code.expanded === b.code.expanded &&
    a.editor.filesPct === b.editor.filesPct &&
    a.editor.panels.github === b.editor.panels.github &&
    a.editor.panels.review === b.editor.panels.review
  );
}

// A valid open-tabs entry: an array of non-empty encoded strings. Garbage is
// dropped; missing file encodings are pruned later by the files store.
function isOpenTabs(v: unknown): v is string[] {
  return (
    Array.isArray(v) && v.every((p) => typeof p === "string" && p.length > 0)
  );
}

function isSidebarMode(v: unknown): v is SidebarMode {
  return v === "full" || v === "rail";
}

function normalizeMemoryAgentAccess(
  value: unknown,
): MemoryAgentAccessPreference {
  if (!value || typeof value !== "object") {
    return DEFAULT_MEMORY_AGENT_ACCESS;
  }
  const candidate = value as Partial<MemoryAgentAccessPreference>;
  return {
    enabled: candidate.enabled === true,
    access: candidate.access === "read-only" ? "read-only" : "read-write",
  };
}

// The provider new KödChat threads start on. Only a CLI with a verified
// headless stream qualifies, so a hand-edited or newly-unsupported id falls
// back to the default rather than producing threads that can't send.
export const DEFAULT_CHAT_PROVIDER = "claude";

function isChatProvider(v: unknown): v is string {
  return typeof v === "string" && chatProviderIds().includes(v);
}

function sameVoicePreferences(
  a: VoicePreferences,
  b: VoicePreferences,
): boolean {
  return (
    a.modelId === b.modelId &&
    a.reviewBeforeInsert === b.reviewBeforeInsert &&
    a.reviewBeforeInsertConfigured === b.reviewBeforeInsertConfigured &&
    a.commandAutoConfirm === b.commandAutoConfirm &&
    a.pushToTalkCombo === b.pushToTalkCombo &&
    a.pushToTalkCommandCombo === b.pushToTalkCommandCombo &&
    a.installedModelIds.length === b.installedModelIds.length &&
    a.installedModelIds.every((id, index) => id === b.installedModelIds[index])
  );
}

function sameLocalModelPreferences(
  a: LocalModelPreferences,
  b: LocalModelPreferences,
): boolean {
  return (
    a.contextLength === b.contextLength &&
    a.downloadedModelIds.length === b.downloadedModelIds.length &&
    a.downloadedModelIds.every(
      (id, index) => id === b.downloadedModelIds[index],
    ) &&
    a.customModels.length === b.customModels.length &&
    a.customModels.every((model, index) => {
      const other = b.customModels[index];
      return (
        other?.id === model.id &&
        other.path === model.path &&
        other.label === model.label &&
        other.format === model.format
      );
    }) &&
    a.savedEndpoints.length === b.savedEndpoints.length &&
    a.savedEndpoints.every((endpoint, index) => {
      const other = b.savedEndpoints[index];
      return (
        other?.id === endpoint.id &&
        other.label === endpoint.label &&
        other.baseURL === endpoint.baseURL &&
        other.notes === endpoint.notes
      );
    })
  );
}

// A valid reviewed-checkmarks entry: reuses isOpenTabs's string[] shape for
// `paths`, plus a finite numeric timestamp. Garbage (either field wrong) drops
// the whole entry rather than half-restoring it.
function isReviewCheckEntry(v: unknown): v is ReviewCheckEntry {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    isOpenTabs(c.paths) &&
    typeof c.updatedAt === "number" &&
    isFinite(c.updatedAt)
  );
}

// One project's reviewChecks map: every key a valid scope, tolerating a
// partly-corrupt object (invalid entries are simply dropped).
function isReviewChecksMap(v: unknown): v is Record<string, ReviewCheckEntry> {
  return typeof v === "object" && v !== null;
}

// Keep only the MAX_REVIEW_SCOPES_PER_PROJECT most-recently-updated scope
// entries for one project — the pruning rule that keeps deleted/stale
// branches from growing the document forever. Applied on every write and
// tolerated on read (a hand-edited doc could exceed the cap).
function capReviewScopes(
  scopes: Record<string, ReviewCheckEntry>,
): Record<string, ReviewCheckEntry> {
  const entries = Object.entries(scopes);
  if (entries.length <= MAX_REVIEW_SCOPES_PER_PROJECT) return scopes;
  // Object key order is insertion order (oldest write first); break
  // same-millisecond updatedAt ties by that order so a tight burst of writes
  // (as in a test, or several toggles within one Date.now() tick) still
  // evicts the actually-oldest entry rather than an arbitrary one.
  const indexed = entries.map((entry, index) => ({ entry, index }));
  indexed.sort(
    (a, b) => b.entry[1].updatedAt - a.entry[1].updatedAt || b.index - a.index,
  );
  return Object.fromEntries(
    indexed.slice(0, MAX_REVIEW_SCOPES_PER_PROJECT).map((x) => x.entry),
  );
}

// Keep a project's vocabulary bounded: trim each term to
// MAX_VOICE_VOCABULARY_TERM_LENGTH and keep only the first
// MAX_VOICE_VOCABULARY_TERMS_PER_PROJECT (insertion order — earlier terms are
// more likely deliberate additions than a later paste of a wall of text).
// Applied on every write and tolerated on read (a hand-edited doc could
// exceed either bound).
function capVoiceVocabularyTerms(terms: string[]): string[] {
  return terms
    .map((term) => term.slice(0, MAX_VOICE_VOCABULARY_TERM_LENGTH))
    .slice(0, MAX_VOICE_VOCABULARY_TERMS_PER_PROJECT);
}

// Persisted session entries are trusted only if id and name are non-empty
// strings — garbage entries are dropped; an empty result reads as "none saved"
// (the project then boots a fresh session as before this field existed).
function parseSessions(v: unknown): PersistedSession[] | null {
  if (!Array.isArray(v)) return null;
  const out: PersistedSession[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const c = e as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id) continue;
    if (typeof c.name !== "string" || !c.name) continue;
    const entry: PersistedSession = { id: c.id, name: c.name };
    if (typeof c.workspaceId === "string" && c.workspaceId) {
      entry.workspaceId = c.workspaceId;
    }
    if (c.nameLocked === true) entry.nameLocked = true;
    // Docs written before the marker existed carry only the `ssh ` name
    // prefix (the M11b creation convention) — stamp those on read (#121).
    if (c.remote === true || isRemoteSessionName(c.name)) entry.remote = true;
    // Only known non-pty values are trusted; anything else restores a terminal.
    if (c.kind === "chat" || c.kind === "work") entry.kind = c.kind;
    out.push(entry);
  }
  if (out.length === 0) return null;
  const ids = new Set(out.map((entry) => entry.id));
  return out.map((entry) =>
    entry.workspaceId &&
    entry.workspaceId !== entry.id &&
    ids.has(entry.workspaceId)
      ? entry
      : { ...entry, workspaceId: undefined },
  );
}

// The persistable slice of a live session (identity only; runtime state such
// as exited/autoName is deliberately dropped).
function toPersistedSession(s: SessionMeta): PersistedSession {
  const out: PersistedSession = { id: s.id, name: s.name };
  if (s.workspaceId) out.workspaceId = s.workspaceId;
  if (s.nameLocked) out.nameLocked = true;
  if (s.remote) out.remote = true;
  if (s.kind === "chat" || s.kind === "work") out.kind = s.kind;
  return out;
}

// Debounce interval for persisting layout drags — a drag fires many changes,
// so we write once the user pauses instead of on every pixel.
const LAYOUT_PERSIST_DEBOUNCE_MS = 500;

// How often the foreground-process poller ticks. ~2s is responsive enough to
// pick up "claude" a beat after launch while staying cheap (one syscall per
// VISIBLE session per tick; hidden/background projects aren't polled at all).
const FOREGROUND_POLL_MS = 2000;

// Shell basenames whose foreground reads as "idle" — the session shows its base
// name, not an auto-name. A foreground matching one of these reverts auto-naming.
const SHELL_NAMES = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "-zsh",
  "-bash",
  "-fish",
]);

export function createProjectsStore(deps: StoreDeps) {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const canonicalize =
    deps.canonicalize ?? ((path: string) => Promise.resolve(path));
  // Poller injection points, defaulted to the real globals.
  const setTimer = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearInterval ?? ((h) => clearInterval(h));
  const isHidden =
    deps.isHidden ??
    (() => (typeof document !== "undefined" ? document.hidden : false));
  const pollIntervalMs = deps.pollIntervalMs ?? FOREGROUND_POLL_MS;
  const canUseRemote = deps.canUseRemote ?? (() => true);

  // Hydration gate: persisted mutations wait for hydrate() even if they arrive
  // before startup has begun the disk read. Without this separate deferred,
  // an early mutation could see `hydration === null` and write the empty store
  // over the saved document. Idempotent — the first hydrate call owns the read;
  // all callers share this gate, which resolves exactly when it finishes.
  let hydration: Promise<void> | null = null;
  let resolveHydrationGate!: () => void;
  const hydrationGate = new Promise<void>((resolve) => {
    resolveHydrationGate = resolve;
  });
  const hydrationSettled = () => hydrationGate;

  return createStore<ProjectsState>((set, get) => {
    // Write the current persistable slice to disk (fire-safe: log, don't throw).
    // Writes are chained so two in-flight persists (a debounced layout write
    // racing a removeProject write) can never land on disk out of order — each
    // write snapshots state when it RUNS, so the last write is the newest.
    let writeChain: Promise<void> = Promise.resolve();

    // Whether the persisted document should carry a `shell` field yet (#62).
    // Until the user actually touches the v2 shell, the v1 `layout` array stays
    // the single source of geometry: writing a derived `shell` on every save
    // would freeze the sidebar width at whatever it was on the first boot of
    // ANY build, and later v1 resizes would never reach the real first v2 boot.
    // Set when the document already had a `shell`, and when the user enables
    // the shell or moves it. Sticky once set — switching v2 back off must not
    // discard the layout it remembered.
    let shellLayoutPersisted = false;

    // Persisted session identities not yet revived (hydrated from disk, waiting
    // for their project's first ensureSession). Consumed one-shot per boot;
    // persist() keeps unconsumed entries in the doc so a background project's
    // sessions survive persists that happen before it's ever activated.
    const pendingSessions = new Map<string, PersistedSession[]>();

    const persist = (): Promise<void> => {
      const run = async () => {
        const {
          projects,
          sessions,
          activeProjectId,
          layout,
          theme,
          chatProvider,
          sidebarMode,
          filesCollapsed,
          openTabs,
          voicePreferences,
          localModelPreferences,
          memoryAgentAccess,
          ambientPromptEnabled,
          ambientPromptOverride,
          reviewChecks,
          voiceVocabulary,
          remoteTargets,
          shellLayout,
          shellV2Enabled,
        } = get();
        // Session identities per project: live (non-exited) sessions once a
        // project's saved set has been revived, the saved set until then.
        const sessionsDoc: Record<string, PersistedSession[]> = {};
        const projectIds = [
          ...projects.map((project) => project.id),
          ...remoteTargets.map(remoteProjectId),
        ];
        for (const projectId of projectIds) {
          const saved =
            pendingSessions.get(projectId) ??
            sessions
              .filter((s) => s.projectId === projectId && !s.exited)
              .map(toPersistedSession);
          if (saved.length > 0) sessionsDoc[projectId] = saved;
        }
        const doc: PersistedDoc = {
          version: STORAGE_VERSION,
          projects,
          activeProjectId,
          layout,
          theme,
          chatProvider,
          sidebarMode,
          filesCollapsed,
          openTabs,
          voice: voicePreferences,
          local: localModelPreferences,
          memoryAgentAccess,
          ambientPromptEnabled,
          ...(ambientPromptOverride === null
            ? {}
            : { ambientPromptOverride }),
          reviewChecks,
          voiceVocabulary,
          remoteTargets,
          sessions: sessionsDoc,
          ...(shellLayoutPersisted ? { shell: shellLayout } : {}),
          shellV2: shellV2Enabled,
        };
        try {
          await deps.storage.write(JSON.stringify(doc));
        } catch (err) {
          console.error("kodade: persist failed:", err);
        }
      };
      writeChain = writeChain.then(run);
      return writeChain;
    };

    // Background mutations expose one completion seam instead of making
    // callers guess how many microtasks or debounce intervals persistence
    // needs. Each scheduled operation reaches persist(), whose write chain
    // preserves disk order.
    let persistenceWork: Promise<void> = Promise.resolve();
    const persistAfterHydration = (): Promise<void> => {
      const work = (async () => {
        await hydrationSettled();
        await persist();
      })();
      persistenceWork = work;
      return work;
    };

    // Foreground poller handle (null when not running). Lives in the closure so
    // start/stop are idempotent and the interval survives re-renders.
    let pollHandle: ReturnType<typeof setInterval> | null = null;

    // Monotonic poll-cycle counter. Each pollForeground() call claims the next
    // token before it awaits; when its results land, they apply only if no newer
    // cycle has started since. Guards against a slow older cycle clobbering a
    // newer cycle's fresher result (out-of-order async foreground lookups).
    let pollSeq = 0;
    let latestPoll = 0;
    // Activity transitions cannot rely on autoName because a manual rename
    // locks the visible name while the terminal still has a live foreground.
    const lastForegroundBySession = new Map<string, string | null>();

    // Debounced persist for bursty changes — layout drags, tab churn, and
    // session lifecycle (open/close/exit/rename all reuse this one timer).
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    const persistDebounced = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        void persistAfterHydration();
      }, LAYOUT_PERSIST_DEBOUNCE_MS);
    };

    const flushPersistence = async () => {
      for (;;) {
        if (persistTimer) {
          clearTimeout(persistTimer);
          persistTimer = null;
          void persistAfterHydration();
        }
        const scheduled = persistenceWork;
        await scheduled;
        const writes = writeChain;
        await writes;
        if (
          !persistTimer &&
          scheduled === persistenceWork &&
          writes === writeChain
        ) {
          return;
        }
      }
    };

    const emitSelectedSessionActivity = (projectId: string) => {
      const { activeProjectId, activeSessionByProject } = get();
      // Session state is retained per project, but ActivityModule has one
      // global selection. Background mutations must not replace that fact.
      if (activeProjectId !== projectId) return;
      const sessionId = activeSessionByProject[projectId];
      if (sessionId) {
        deps.onActivity?.({ type: "session-selected", projectId, sessionId });
      }
    };

    // Recreate a project's persisted local sessions with their saved ids.
    // Mirrors addSession's lifecycle per session; the last revived session
    // becomes the active one.
    const reviveSessions = (
      project: Project,
      saved: PersistedSession[],
      cwd = project.path,
    ) => {
      const revived: SessionMeta[] = saved.map((meta) => ({
        id: meta.id,
        projectId: project.id,
        ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
        name: meta.name,
        ...(meta.nameLocked ? { nameLocked: true } : {}),
        ...(meta.remote ? { remote: true } : {}),
        ...(meta.kind === "chat" || meta.kind === "work"
          ? { kind: meta.kind }
          : {}),
      }));
      const selected =
        [...revived].reverse().find((session) => isChatSession(session)) ?? revived.at(-1)!;
      set((s) => ({
        sessions: [...s.sessions, ...revived],
        activeSessionByProject: {
          ...s.activeSessionByProject,
          [project.id]: selected.id,
        },
      }));
      for (const session of revived) {
        deps.onActivity?.({
          type: "session-created",
          projectId: project.id,
          sessionId: session.id,
          name: session.name,
        });
      }
      emitSelectedSessionActivity(project.id);
      for (const session of revived) {
        // Chat threads and KödWork tasks have no shell to reattach; their
        // documents load lazily when their pane/tab opens.
        if (ownsNoPty(session)) continue;
        const ready = deps.registry.open(session.id, cwd);
        if (ready) void ready.catch(() => undefined);
        deps.onSessionStarted?.(project, session, null);
      }
    };

    // Revive a project's persisted sessions when it becomes active. A project
    // with no saved sessions stays empty until the user starts a KödChat thread
    // or explicitly opens that thread's terminal; navigation never starts a
    // background shell on its own.
    const ensureSession = (projectId: string): boolean => {
      const hasExisting = get().sessions.some((s) => s.projectId === projectId);
      const pending = pendingSessions.get(projectId);
      pendingSessions.delete(projectId);
      const project = get().projects.find((p) => p.id === projectId);
      const remoteTarget = remoteTargetForProjectId(
        get().remoteTargets,
        projectId,
      );
      // Remote SSH processes die with the app. Reviving their identities would
      // boot local shells mislabeled `ssh <host>`, so skip them. If every saved
      // session was remote, fall through to a fresh, plainly named shell.
      const revivable = pending?.filter((session) =>
        deps.autoStartTerminal === false
          ? session.kind === "chat" || session.kind === "work"
          : !session.remote ||
            session.kind === "chat" ||
            session.kind === "work",
      );
      if (revivable && revivable.length > 0 && (project || remoteTarget)) {
        reviveSessions(
          project ?? {
            id: projectId,
            name: remoteTarget!.path.split("/").filter(Boolean).at(-1) ?? remoteTarget!.host,
            path: remoteTarget!.path,
          },
          revivable,
          remoteTarget ? "" : project!.path,
        );
        return true;
      }
      if (hasExisting) return false;
      // Selecting a remote project is navigation, not permission to open an
      // SSH connection. Its first terminal/chat is created by an explicit
      // action in the Remote tree.
      if (remoteTarget || deps.autoStartTerminal === false) return false;
      get().addSession(projectId);
      return true;
    };

    // In the chat-first desktop runtime, a chat-OWNED terminal normalizes back
    // to its chat so shortcuts and dormant callers cannot escape KödChat. A
    // project-scoped standalone terminal (a login/agent shell hosted at project
    // scope, slice 3) is a first-class session and selectable as itself.
    const selectableSessionId = (
      projectId: string,
      requestedId: string,
    ): string | null => {
      const state = get();
      const requested = state.sessions.find(
        (session) =>
          session.id === requestedId && session.projectId === projectId,
      );
      if (!requested) return null;
      if (
        deps.autoStartTerminal !== false ||
        remoteTargetForProjectId(state.remoteTargets, projectId) ||
        isChatSession(requested)
      ) {
        return requested.id;
      }
      // A standalone terminal root (no owner) is selectable as itself, but a
      // PTY-less session (a KödWork task) must never steal selection — creating
      // or activating one is background, per the addSession invariant.
      if (!requested.workspaceId)
        return ownsNoPty(requested) ? null : requested.id;
      const owner = state.sessions.find(
        (session) =>
          session.projectId === projectId &&
          session.id === requested.workspaceId,
      );
      // Owned by a chat/work host → normalize to that host; a split of a
      // standalone terminal (owner is another terminal) selects itself. A
      // dangling owner (its host was closed) is not selectable.
      if (!owner) return null;
      return ownsNoPty(owner) ? owner.id : requested.id;
    };

    return {
      projects: [],
      sessions: [],
      activeProjectId: null,
      activeSessionByProject: {},
      layout: undefined,
      shellLayout: defaultShellLayout(), // v2 shell geometry (issue #62)
      shellV2Enabled: false, // v2 shell stays off until it is switched on
      theme: "system", // system-following by default (resolved by the theme store)
      chatProvider: DEFAULT_CHAT_PROVIDER,
      sidebarMode: "full",
      filesCollapsed: false, // files pane starts expanded
      openTabs: {}, // per-project open editor tabs (v1.1)
      voicePreferences: DEFAULT_VOICE_PREFERENCES,
      localModelPreferences: DEFAULT_LOCAL_MODEL_PREFERENCES,
      memoryAgentAccess: DEFAULT_MEMORY_AGENT_ACCESS,
      ambientPromptEnabled: true, // background prompt is on by default (#63)
      ambientPromptOverride: null, // …with Ködade's own text
      reviewChecks: {}, // KödPR reviewed-file checkmarks, per project path (M12d)
      voiceVocabulary: {}, // KödWhisper Pro per-project user vocabulary (M9e)
      remoteTargets: [], // pinned remote projects (KödSSH Pro, M11c)
      shellBase: "zsh",
      expandedProjects: {},

      // Load the persisted document; tolerate a missing/corrupt/foreign doc
      // and skip individually invalid entries. Idempotent (see hydration gate).
      hydrate() {
        if (hydration) return hydration;
        hydration = (async () => {
          try {
            let doc: PersistedDoc | null = null;
            try {
              const raw = await deps.storage.read();
              if (raw) doc = JSON.parse(raw) as PersistedDoc;
            } catch (err) {
              console.error("kodade: hydrate failed, starting fresh:", err);
            }
            if (
              !doc ||
              doc.version !== STORAGE_VERSION ||
              !Array.isArray(doc.projects)
            ) {
              return;
            }

            const persisted = doc.projects
              .map(parseProject)
              .filter((project): project is Project => project !== null);
            const skipped = doc.projects.length - persisted.length;
            if (skipped > 0) {
              console.error(
                `kodade: skipped ${skipped} invalid project entr(y/ies)`,
              );
            }
            // Read the legacy per-project layout map only for migration.
            const persistedLayouts: Record<string, PaneSizes> = {};
            if (doc.layouts && typeof doc.layouts === "object") {
              for (const p of persisted) {
                const sizes = doc.layouts[p.id];
                if (isPaneSizes(sizes)) persistedLayouts[p.id] = sizes;
              }
            }

            // Keep only well-formed open-tab entries — tolerate the openTabs field
            // being absent or partly corrupt (v1.1).
            const persistedTabs: Record<string, string[]> = {};
            if (doc.openTabs && typeof doc.openTabs === "object") {
              for (const p of persisted) {
                const tabs = doc.openTabs[p.id];
                if (isOpenTabs(tabs)) persistedTabs[p.id] = tabs;
              }
            }

            // Keep only well-formed reviewed-checkmarks entries (M12d) — keyed
            // by PATH (not id), tolerating the field being absent or partly
            // corrupt, and capped per project.
            const persistedReviewChecks: Record<
              string,
              Record<string, ReviewCheckEntry>
            > = {};
            if (doc.reviewChecks && typeof doc.reviewChecks === "object") {
              for (const p of persisted) {
                const scopes = doc.reviewChecks[p.path];
                if (!isReviewChecksMap(scopes)) continue;
                const cleaned: Record<string, ReviewCheckEntry> = {};
                for (const [key, entry] of Object.entries(scopes)) {
                  if (isReviewCheckEntry(entry)) cleaned[key] = entry;
                }
                if (Object.keys(cleaned).length > 0) {
                  persistedReviewChecks[p.path] = capReviewScopes(cleaned);
                }
              }
            }

            // KödWhisper Pro per-project vocabulary (M9e): keyed by PATH,
            // tolerate absent/corrupt, keep only string term arrays.
            const persistedVoiceVocabulary: Record<string, string[]> = {};
            if (
              doc.voiceVocabulary &&
              typeof doc.voiceVocabulary === "object"
            ) {
              for (const p of persisted) {
                const terms = doc.voiceVocabulary[p.path];
                if (isOpenTabs(terms) && terms.length > 0) {
                  persistedVoiceVocabulary[p.path] =
                    capVoiceVocabularyTerms(terms);
                }
              }
            }

            // Pinned remote targets (M11c): a flat list, validated per entry so
            // a corrupt one is dropped, not fatal. Deduped by host+path.
            const persistedRemoteTargets: RemoteTarget[] = [];
            if (Array.isArray(doc.remoteTargets)) {
              const seen = new Set<string>();
              for (const raw of doc.remoteTargets) {
                const target = parseRemoteTarget(raw);
                if (!target) continue;
                const key = remoteTargetKey(target);
                if (seen.has(key)) continue;
                seen.add(key);
                persistedRemoteTargets.push(target);
              }
            }
            if (doc.openTabs && typeof doc.openTabs === "object") {
              for (const target of persistedRemoteTargets) {
                const projectId = remoteProjectId(target);
                const tabs = doc.openTabs[projectId];
                if (isOpenTabs(tabs)) persistedTabs[projectId] = tabs;
              }
            }
            const activeFromDoc =
              typeof doc.activeProjectId === "string" &&
              (persisted.some((p) => p.id === doc.activeProjectId) ||
                (canUseRemote() &&
                  persistedRemoteTargets.some(
                    (target) => remoteProjectId(target) === doc.activeProjectId,
                  )))
                ? doc.activeProjectId
                : null;
            const persistedLayout = isPaneSizes(doc.layout)
              ? doc.layout
              : ((activeFromDoc ? persistedLayouts[activeFromDoc] : undefined) ??
                Object.values(persistedLayouts)[0]);

            // Merge, don't replace: a project added while hydration was in
            // flight (mutations gate on us, but belt-and-braces) survives —
            // and wins path collisions so its id stays referenced.
            let hadRuntimeProjects = false;
            set((s) => {
              hadRuntimeProjects = s.projects.length > 0;
              const projects = [
                ...persisted.filter(
                  (q) => !s.projects.some((p) => p.path === q.path),
                ),
                ...s.projects,
              ];
              // Pane geometry is app-level. An in-session resize wins; older
              // per-project documents migrate from the last active project.
              const layout = s.layout ?? persistedLayout;
              // Open tabs retain project shadow/twin carry-over. Session-set
              // tabs win; entries for dropped projects are pruned (v1.1).
              const openTabs: Record<string, string[]> = {};
              for (const p of projects) {
                const twin = persisted.find((q) => q.path === p.path);
                const saved =
                  persistedTabs[p.id] ??
                  (twin ? persistedTabs[twin.id] : undefined);
                const chosen = s.openTabs[p.id] ?? saved;
                if (chosen) openTabs[p.id] = chosen;
              }
              for (const target of [
                ...s.remoteTargets,
                ...persistedRemoteTargets,
              ]) {
                const projectId = remoteProjectId(target);
                const chosen =
                  s.openTabs[projectId] ?? persistedTabs[projectId];
                if (chosen) openTabs[projectId] = chosen;
              }
              // Reviewed checkmarks (M12d): keyed by path already, so no
              // id-shadow indirection needed. Session-set wins; entries for
              // dropped projects are pruned.
              const reviewChecks: Record<
                string,
                Record<string, ReviewCheckEntry>
              > = {};
              for (const p of projects) {
                const chosen =
                  s.reviewChecks[p.path] ?? persistedReviewChecks[p.path];
                if (chosen) reviewChecks[p.path] = chosen;
              }
              // Per-project vocabulary (M9e): keyed by path; session-set wins;
              // entries for dropped projects are pruned.
              const voiceVocabulary: Record<string, string[]> = {};
              for (const p of projects) {
                const chosen =
                  s.voiceVocabulary[p.path] ?? persistedVoiceVocabulary[p.path];
                if (chosen) voiceVocabulary[p.path] = chosen;
              }
              // Theme: accept any non-empty string from disk (the theme store
              // resolves an unknown id back to "system"); tolerate garbage. An
              // explicit in-session pick (anything but the "system" default)
              // outranks the stale doc — hydration must not revert it.
              const docTheme =
                typeof doc.theme === "string" && doc.theme
                  ? doc.theme
                  : s.theme;
              const theme = s.theme !== "system" ? s.theme : docTheme;
              // Like theme, a pre-hydration switch wins over the stale document.
              // Invalid/missing values preserve the first-run full sidebar.
              const docSidebarMode = isSidebarMode(doc.sidebarMode)
                ? doc.sidebarMode
                : s.sidebarMode;
              const sidebarMode =
                s.sidebarMode !== "full" ? s.sidebarMode : docSidebarMode;
              // Files pane collapse follows the sidebar rule: a pre-hydration
              // toggle wins; anything but `true` on disk stays expanded.
              const filesCollapsed =
                s.filesCollapsed || doc.filesCollapsed === true;
              // Same pre-hydration rule as theme: a choice already made in this
              // session outranks the stale document. An unknown id (a provider
              // that lost its adapter) falls back to the default.
              const docChatProvider = isChatProvider(doc.chatProvider)
                ? doc.chatProvider
                : s.chatProvider;
              const chatProvider =
                s.chatProvider !== DEFAULT_CHAT_PROVIDER
                  ? s.chatProvider
                  : docChatProvider;
              const docVoicePreferences = normalizeVoicePreferences(doc.voice);
              const voicePreferences =
                !sameVoicePreferences(s.voicePreferences, DEFAULT_VOICE_PREFERENCES)
                  ? s.voicePreferences
                  : docVoicePreferences;
              const docLocalModelPreferences = normalizeLocalModelPreferences(doc.local);
              const localModelPreferences =
                !sameLocalModelPreferences(
                  s.localModelPreferences,
                  DEFAULT_LOCAL_MODEL_PREFERENCES,
                )
                  ? s.localModelPreferences
                  : docLocalModelPreferences;
              const persistedMemoryAgentAccess =
                normalizeMemoryAgentAccess(doc.memoryAgentAccess);
              const memoryAgentAccess = s.memoryAgentAccess.enabled
                ? s.memoryAgentAccess
                : persistedMemoryAgentAccess;
              // v2 shell (issue #62). A doc without a `shell` field falls back
              // to the v1 pane array, so an existing user's first v2 boot keeps
              // the sidebar width they already chose. A change made in this
              // session outranks the stale document, like theme/sidebar above.
              const docShellLayout = migrateShellLayout(doc.shell ?? doc.layout);
              if (doc.shell !== undefined) shellLayoutPersisted = true;
              const shellLayout = sameShellLayout(
                s.shellLayout,
                defaultShellLayout(),
              )
                ? docShellLayout
                : s.shellLayout;
              // Monotonic: an enable made before the read landed survives it.
              // The mirror case (disabling v2 pre-hydration, then hydrating a
              // doc that had it on) re-enables — accepted, because this is a
              // development-only toggle one click away from being flipped back.
              const shellV2Enabled = s.shellV2Enabled || doc.shellV2 === true;
              // Background prompt (#63). An absent field means "on, default
              // text"; a change made in this session outranks the document,
              // like theme/sidebar above. Same accepted edge as the shellV2
              // note: a pre-hydration change back TO the default (re-enabling,
              // or clearing the override) is indistinguishable from an
              // untouched store, so a document that disagrees wins — one click
              // away from being flipped back, in the direction of the user's
              // saved settings.
              const ambientPromptEnabled = !s.ambientPromptEnabled
                ? false
                : doc.ambientPromptEnabled !== false;
              const ambientPromptOverride =
                s.ambientPromptOverride ??
                normalizeAmbientOverride(doc.ambientPromptOverride);
              const activeProjectId = s.activeProjectId ?? activeFromDoc;
              // Union runtime (pre-hydration) pins with persisted ones, runtime
              // winning on a key collision, so a pin made before the read landed
              // isn't lost.
              const remoteSeen = new Set<string>();
              const remoteTargets: RemoteTarget[] = [];
              for (const target of [
                ...s.remoteTargets,
                ...persistedRemoteTargets,
              ]) {
                const key = remoteTargetKey(target);
                if (remoteSeen.has(key)) continue;
                remoteSeen.add(key);
                remoteTargets.push(target);
              }
              return {
                projects,
                activeProjectId,
                expandedProjects: activeProjectId
                  ? { ...s.expandedProjects, [activeProjectId]: true }
                  : s.expandedProjects,
                layout,
                theme,
                chatProvider,
                sidebarMode,
                filesCollapsed,
                openTabs,
                voicePreferences,
                localModelPreferences,
                memoryAgentAccess,
                ambientPromptEnabled,
                ambientPromptOverride,
                reviewChecks,
                voiceVocabulary,
                remoteTargets,
                shellLayout,
                shellV2Enabled,
              };
            });
            for (const project of get().projects) {
              deps.onActivity?.({
                type: "project-added",
                projectId: project.id,
                projectName: project.name,
              });
            }
            // Stage persisted session identities for revival, with the same
            // shadow/twin carry-over as open tabs. A project that already has
            // live sessions (belt-and-braces) keeps them — its saved set is
            // simply dropped.
            if (doc.sessions && typeof doc.sessions === "object") {
              for (const p of get().projects) {
                if (get().sessions.some((s) => s.projectId === p.id)) continue;
                const twin = persisted.find((q) => q.path === p.path);
                const saved =
                  parseSessions(doc.sessions[p.id]) ??
                  (twin ? parseSessions(doc.sessions[twin.id]) : null);
                if (saved) {
                  const work = saved.filter((session) => session.kind === "work");
                  if (work.length > 0) reviveSessions(p, work);
                  const deferred = saved.filter((session) => session.kind !== "work");
                  if (deferred.length > 0) pendingSessions.set(p.id, deferred);
                }
              }
              for (const target of get().remoteTargets) {
                const projectId = remoteProjectId(target);
                if (
                  get().sessions.some((session) => session.projectId === projectId)
                ) {
                  continue;
                }
                const saved = parseSessions(doc.sessions[projectId]);
                if (saved) pendingSessions.set(projectId, saved);
              }
            }
            // Landing in the last active project means a terminal ready at its root.
            const active = get().activeProjectId;
            if (active) ensureSession(active);
            // Fold pre-hydration additions back into the doc on disk.
            if (hadRuntimeProjects) await persist();
          } finally {
            resolveHydrationGate();
          }
        })();
        return hydration;
      },

      flushPersistence,

      // Picker and drag-drop both funnel here. Duplicate paths (after
      // canonicalization) select the existing project instead of duplicating.
      async addProject(path: string) {
        await hydrationSettled();
        const norm = normalizePath(await canonicalize(path));
        const existing = get().projects.find((p) => nativeEquals(p.path, norm));
        if (existing) {
          await get().setActiveProject(existing.id);
          return;
        }
        const project: Project = {
          id: newId(),
          name: nativeBasename(norm),
          path: norm,
        };
        set((s) => ({ projects: [...s.projects, project] }));
        deps.onActivity?.({
          type: "project-added",
          projectId: project.id,
          projectName: project.name,
        });
        await get().setActiveProject(project.id); // persists
      },

      // Remove from kodade only — never touches the folder on disk.
      async removeProject(id: string) {
        await hydrationSettled();
        const { projects, sessions } = get();
        const removed = projects.find((p) => p.id === id);
        if (!removed) return;

        const doomed = sessions.filter((s) => s.projectId === id);
        set((s) => {
          const remaining = s.projects.filter((p) => p.id !== id);
          const active = { ...s.activeSessionByProject };
          delete active[id];
          const openTabs = { ...s.openTabs };
          delete openTabs[id]; // drop the removed project's saved tabs
          const reviewChecks = { ...s.reviewChecks };
          delete reviewChecks[removed.path]; // drop the removed project's reviewed checkmarks (keyed by path)
          const voiceVocabulary = { ...s.voiceVocabulary };
          delete voiceVocabulary[removed.path]; // drop the removed project's vocabulary (keyed by path)
          const expandedProjects = { ...s.expandedProjects };
          delete expandedProjects[id]; // drop the removed project's disclosure state
          // If removal promotes a new active project, expand it so its
          // sessions are visible immediately.
          if (s.activeProjectId === id && remaining[0]) {
            expandedProjects[remaining[0].id] = true;
          }
          return {
            projects: remaining,
            sessions: s.sessions.filter((sess) => sess.projectId !== id),
            activeSessionByProject: active,
            openTabs,
            reviewChecks,
            voiceVocabulary,
            expandedProjects,
            activeProjectId:
              s.activeProjectId === id
                ? (remaining[0]?.id ?? null)
                : s.activeProjectId,
          };
        });
        deps.onActivity?.({ type: "project-removed", projectId: id });
        pendingSessions.delete(id); // never revive a removed project's sessions
        for (const session of doomed)
          lastForegroundBySession.delete(session.id);
        for (const sess of doomed) {
          if (!sess.exited) deps.onSessionExited?.(removed, sess);
          await deps.registry.close(sess.id);
        }
        // Prune the files store's per-root tab closure for the removed project
        // (v1.1) so a removed-then-re-added folder starts with no stale tabs.
        deps.onProjectRemoved?.(removed.path);
        const nextActive = get().activeProjectId;
        if (nextActive && !ensureSession(nextActive)) {
          emitSelectedSessionActivity(nextActive);
        }
        await persist();
      },

      // Switching projects only changes what's visible — background sessions
      // (and their processes) keep running untouched.
      async setActiveProject(id: string) {
        await hydrationSettled();
        const remoteTarget = remoteTargetForProjectId(get().remoteTargets, id);
        if (
          !get().projects.some((p) => p.id === id) &&
          !remoteTarget
        ) {
          return;
        }
        if (remoteTarget && !canUseRemote()) return;
        if (get().activeProjectId === id) {
          set((s) => ({
            expandedProjects: { ...s.expandedProjects, [id]: true },
          }));
          return;
        }
        // Auto-expand the newly active project without collapsing background rows.
        set((s) => ({
          activeProjectId: id,
          expandedProjects: { ...s.expandedProjects, [id]: true },
        }));
        if (!ensureSession(id)) emitSelectedSessionActivity(id);
        await persist();
      },

      // New named terminal at the project root ("zsh 1"-style, max suffix + 1).
      // `base` defaults to the login shell name; a launcher passes a provider
      // name instead ("claude 1"). Returns the new session id, or null if the
      // project is unknown.
      addSession(
        projectId: string,
        base?: string,
        workspaceId?: string,
        options?: AddSessionOptions,
      ): string | null {
        const { projects, remoteTargets, sessions, shellBase } = get();
        const project = projects.find((p) => p.id === projectId);
        const remoteTarget = remoteTargetForProjectId(remoteTargets, projectId);
        if (!project && !remoteTarget) return null;
        if (remoteTarget && !canUseRemote()) return null;
        const chat = options?.kind === "chat";
        // KödWork tasks are local-only in this milestone: an agent working a
        // pinned remote folder is a later surface, so refuse rather than
        // silently spawning against the wrong filesystem.
        const work = options?.kind === "work";
        if (work && remoteTarget) return null;
        if (
          deps.autoStartTerminal === false &&
          project &&
          !chat &&
          !work &&
          // An explicitly requested project-scoped terminal is allowed to host
          // a login/agent shell without a chat (slice 3); only the implicit
          // auto-spawn path stays blocked in the chat-first runtime.
          !options?.projectScopedTerminal &&
          (!workspaceId ||
            !sessions.some(
              (session) =>
                session.projectId === projectId &&
                session.id === workspaceId &&
                isChatSession(session),
            ))
        ) {
          return null;
        }
        const requestedBase = base ?? shellBase;
        const nameBase =
          remoteTarget && !chat && !isRemoteSessionName(requestedBase)
            ? remoteSessionBase(base ?? remoteTarget.host)
            : requestedBase;

        // Escape regex metacharacters in the base so a name like "c++" is safe.
        const escaped = nameBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const suffixes = sessions
          .filter((s) => s.projectId === projectId)
          .map((s) => {
            const m = s.name.match(new RegExp(`^${escaped} (\\d+)$`));
            return m ? Number(m[1]) : 0;
          });
        const name = `${nameBase} ${Math.max(0, ...suffixes) + 1}`;

        // Remote launches (M11b) pass a `ssh `-prefixed base (remoteSessionBase)
        // — the one creation-time convention every remote path uses. Stamp the
        // durable marker here so it survives renames and persists (#121).
        const session: SessionMeta = {
          id: newId(),
          projectId,
          ...(workspaceId ? { workspaceId } : {}),
          name,
          ...(remoteTarget || isRemoteSessionName(nameBase)
            ? { remote: true }
            : {}),
          ...(chat ? { kind: "chat" as const } : {}),
          ...(work ? { kind: "work" as const } : {}),
        };
        // A KödWork task runs in the background: creating one must not steal
        // the chat pane's selection the way a new chat/terminal does.
        set((s) => ({
          sessions: [...s.sessions, session],
          ...(work
            ? {}
            : {
                activeSessionByProject: {
                  ...s.activeSessionByProject,
                  [projectId]: session.id,
                },
              }),
        }));
        deps.onActivity?.({
          type: "session-created",
          projectId,
          sessionId: session.id,
          name: session.name,
        });
        if (!work) emitSelectedSessionActivity(projectId);
        // A KödChat thread or KödWork task owns no PTY: opening one would spawn
        // a shell nobody can see and leave it running for the session's life.
        if (!chat && !work) {
          const ready = deps.registry.open(session.id, project?.path ?? "");
          if (ready) void ready.catch(() => undefined);
          deps.onSessionStarted?.(
            project ?? {
              id: projectId,
              name:
                remoteTarget!.path.split("/").filter(Boolean).at(-1) ??
                remoteTarget!.host,
              path: remoteTarget!.path,
            },
            session,
            base ?? null,
          );
          if (remoteTarget) {
            void (async () => {
              await ready;
              await deps.registry.ready?.(session.id);
              await deps.registry.write(
                session.id,
                `${buildSshProjectLaunch(
                  remoteTarget,
                  options?.remoteCommand,
                )}\r`,
              );
            })().catch((error) => {
              console.error("kodade: remote terminal launch failed:", error);
            });
          }
        }
        persistDebounced(); // session identity must survive a reload
        return session.id;
      },

      // Start a KödChat thread in `projectId`, named after the provider that
      // will answer it ("claude 1"). Same session lifecycle as a terminal minus
      // the PTY; the chat store owns the transcript keyed by the returned id.
      addChatThread(projectId: string, base: string): string | null {
        return get().addSession(projectId, base, undefined, { kind: "chat" });
      },

      // Start a KödWork task session (#43). No PTY, no selection change — the
      // kodwork store owns the task document keyed by the returned id.
      addWorkSession(projectId: string): string | null {
        return get().addSession(projectId, "work", undefined, { kind: "work" });
      },

      // Add another terminal inside an existing workspace. It gets its own PTY
      // identity but is projected under the root workspace card instead of
      // becoming a second workspace in the sidebar.
      addTerminal(
        projectId: string,
        workspaceId: string,
        base?: string,
      ): string | null {
        const root = get().sessions.find(
          (session) =>
            session.projectId === projectId &&
            (session.workspaceId ?? session.id) === workspaceId,
        );
        if (!root) return null;
        return get().addSession(projectId, base, root.workspaceId ?? root.id);
      },

      // Launch a CLI in the active project. A chat-first launch (a chat thread
      // selected) hangs the shell off that thread. Otherwise the shell hosts at
      // project scope — a standalone terminal in the active project — so login
      // and agent terminals no longer require an open chat (slice 3). Legacy
      // auto-start callers keep their root-session behavior.
      async launchInSession(command: string, base: string) {
        const projectId = get().activeProjectId;
        if (!projectId) throw new Error("open a project first");
        const remoteTarget = remoteTargetForProjectId(
          get().remoteTargets,
          projectId,
        );
        if (remoteTarget && !canUseRemote()) {
          throw new Error("remote projects require Ködade Pro");
        }
        const remoteCommand =
          remoteTarget && !command.startsWith("exec ")
            ? `exec ${command}`
            : command;
        const selectedId = get().activeSessionByProject[projectId];
        const selected = get().sessions.find((session) => session.id === selectedId);
        const chatSelected = !!selected && isChatSession(selected);
        const existingOwnedTerminal = chatSelected
          ? get().sessions.find(
              (session) =>
                session.projectId === projectId &&
                !isChatSession(session) &&
                session.workspaceId === selected!.id,
            )
          : undefined;
        // A chat-less launch hosts at project scope. Reuse is keyed on the
        // launch base (the provider), so each provider gets its own shell — a
        // second provider's login never gets typed into another's OAuth prompt.
        // A live standalone terminal (not embedded in a chat/task, not exited)
        // whose name matches this base is reused; otherwise a fresh one opens.
        const usedProjectScope =
          !remoteTarget && deps.autoStartTerminal === false && !chatSelected;
        const escapedBase = (base ?? get().shellBase).replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const baseNameRe = new RegExp(`^${escapedBase} \\d+$`);
        const isReusableTerminal = (session: SessionMeta): boolean =>
          session.projectId === projectId &&
          !session.exited && // a dead PTY can't host a new login
          !ownsNoPty(session) &&
          baseNameRe.test(session.name) && // same provider only
          !(
            session.workspaceId !== undefined &&
            get().sessions.some(
              (owner) => owner.id === session.workspaceId && ownsNoPty(owner),
            )
          );
        const projectTerminalHost = usedProjectScope
          ? get().sessions.find(isReusableTerminal)
          : undefined;
        const sessionId =
          !remoteTarget && deps.autoStartTerminal === false
            ? chatSelected
              ? (existingOwnedTerminal?.id ?? get().addTerminal(projectId, selected!.id, base))
              : (projectTerminalHost?.id ??
                  get().addSession(projectId, base, undefined, {
                    projectScopedTerminal: true,
                  }))
            : get().addSession(
                projectId,
                base,
                undefined,
                remoteTarget ? { remoteCommand } : undefined,
              );
        if (!sessionId) {
          throw new Error("could not create a terminal session");
        }
        if (remoteTarget) return;
        // addTerminal/addSession select their new PTY as part of the generic
        // lifecycle. Keep a chat-owned launch on the chat so the shell stays
        // embedded in KödChat; a project-scoped launch selects its terminal so
        // the login prompt is visible even when reusing an existing one.
        if (deps.autoStartTerminal === false && chatSelected) {
          get().setActiveSession(projectId, selected!.id);
        } else if (usedProjectScope) {
          get().setActiveSession(projectId, sessionId);
        }
        await deps.registry.ready?.(sessionId);
        await deps.registry.write(sessionId, `${command}\r`);
      },

      // Close a session: drop it from state, then actually kill its shell.
      async closeSession(id: string) {
        const session = get().sessions.find((s) => s.id === id);
        if (!session) return;
        const workspaceId = session.workspaceId ?? session.id;

        let fallbackSelected = false;
        set((s) => {
          let sessions = s.sessions.filter((x) => x.id !== id);
          // The first terminal is also the persisted workspace identity. When
          // it closes independently, promote a sibling and retarget the other
          // members so the workspace survives a restart as one group.
          if (workspaceId === session.id) {
            const promoted = sessions.find(
              (candidate) =>
                candidate.projectId === session.projectId &&
                candidate.workspaceId === workspaceId,
            );
            if (promoted) {
              sessions = sessions.map((candidate) => {
                if (candidate.id === promoted.id) {
                  return { ...candidate, workspaceId: undefined };
                }
                return candidate.projectId === session.projectId &&
                  candidate.workspaceId === workspaceId
                  ? { ...candidate, workspaceId: promoted.id }
                  : candidate;
              });
            }
          }
          const active = { ...s.activeSessionByProject };
          if (active[session.projectId] === id) {
            const fallback = sessions
              .filter((x) => x.projectId === session.projectId)
              .at(-1);
            if (fallback) {
              active[session.projectId] = fallback.id;
              fallbackSelected = true;
            } else delete active[session.projectId];
          }
          return { sessions, activeSessionByProject: active };
        });
        deps.onActivity?.({
          type: "session-closed",
          projectId: session.projectId,
          sessionId: id,
        });
        lastForegroundBySession.delete(id);
        if (fallbackSelected && get().activeProjectId === session.projectId) {
          emitSelectedSessionActivity(session.projectId);
        }
        // Chat threads and KödWork tasks never opened a registry host, and
        // closing one that was never opened would be the only path to create it.
        if (!ownsNoPty(session)) await deps.registry.close(id);
        deps.onSessionRemoved?.(session);
        if (!ownsNoPty(session) && !session.exited) {
          const project = get().projects.find(
            (candidate) => candidate.id === session.projectId,
          );
          if (project) deps.onSessionExited?.(project, session);
        }
        persistDebounced(); // a closed session must not be revived on reload
      },

      async closeWorkspace(id: string) {
        const selected = get().sessions.find((session) => session.id === id);
        if (!selected) return;
        const workspaceId = selected.workspaceId ?? selected.id;
        const terminalIds = get()
          .sessions.filter(
            (session) =>
              session.projectId === selected.projectId &&
              (session.workspaceId ?? session.id) === workspaceId,
          )
          .map((session) => session.id);
        for (const terminalId of terminalIds) {
          await get().closeSession(terminalId);
        }
      },

      setActiveSession(projectId: string, sessionId: string) {
        const selectableId = selectableSessionId(projectId, sessionId);
        if (!selectableId) return;
        set((s) => ({
          activeSessionByProject: {
            ...s.activeSessionByProject,
            [projectId]: selectableId,
          },
        }));
        emitSelectedSessionActivity(projectId);
      },

      async activateSession(projectId: string, sessionId: string) {
        await hydrationSettled();
        const selectableId = selectableSessionId(projectId, sessionId);
        if (!selectableId) return;
        set((s) => ({
          activeProjectId: projectId,
          activeSessionByProject: {
            ...s.activeSessionByProject,
            [projectId]: selectableId,
          },
          expandedProjects: { ...s.expandedProjects, [projectId]: true },
        }));
        emitSelectedSessionActivity(projectId);
        await persist();
      },

      // Move to the next/prev session within the active project, wrapping around.
      // Order follows sessions[] (creation order), which matches the sidebar.
      cycleSession(direction: 1 | -1) {
        const {
          activeProjectId,
          activeSessionByProject,
          remoteTargets,
          sessions,
        } = get();
        if (!activeProjectId) return;
        const chatOnly =
          deps.autoStartTerminal === false &&
          !remoteTargetForProjectId(remoteTargets, activeProjectId);
        const projectSessions = sessions.filter(
          (session) =>
            session.projectId === activeProjectId &&
            (!chatOnly || isChatSession(session)),
        );
        if (projectSessions.length < 2) return;
        const currentId = activeSessionByProject[activeProjectId];
        const idx = projectSessions.findIndex((s) => s.id === currentId);
        // Unknown/absent current: step from the ends so both directions land.
        const from = idx === -1 ? (direction === 1 ? -1 : 0) : idx;
        const next =
          (from + direction + projectSessions.length) % projectSessions.length;
        get().setActiveSession(activeProjectId, projectSessions[next].id);
      },

      // Move to the next/prev project, wrapping around. Order follows projects[]
      // followed by Remote (the sidebar order). Delegates to setActiveProject
      // so both trees expand/select through the same lifecycle.
      async cycleProject(direction: 1 | -1) {
        const { projects, remoteTargets, activeProjectId } = get();
        const projectIds = [
          ...projects.map((project) => project.id),
          ...(canUseRemote() ? remoteTargets.map(remoteProjectId) : []),
        ];
        if (projectIds.length < 2) return;
        const idx = projectIds.findIndex((id) => id === activeProjectId);
        const from = idx === -1 ? (direction === 1 ? -1 : 0) : idx;
        const next =
          (from + direction + projectIds.length) % projectIds.length;
        await get().setActiveProject(projectIds[next]);
      },

      // Record the app-level pane sizes after a drag, then persist debounced
      // (a drag fires many changes; one write on pause is enough).
      setLayout(sizes: PaneSizes) {
        if (!isPaneSizes(sizes)) return;
        set({ layout: sizes });
        persistDebounced();
      },

      // Record the v2 shell's layout (issue #62) and persist debounced, like
      // setLayout — tab switches and split drags come in bursts. A malformed
      // document is rejected outright rather than partially applied.
      setShellLayout(next: ShellLayout) {
        if (!isShellLayout(next)) return;
        if (sameShellLayout(get().shellLayout, next)) return;
        // The user has moved the v2 shell: its document is authoritative now.
        shellLayoutPersisted = true;
        set({ shellLayout: next });
        persistDebounced();
      },

      // Switch the v2 shell on/off (development builds only).
      setShellV2Enabled(shellV2Enabled: boolean) {
        if (get().shellV2Enabled === shellV2Enabled) return;
        // Turning the shell ON hands it ownership of its own geometry; the v1
        // layout stops being the fallback from here on.
        if (shellV2Enabled) shellLayoutPersisted = true;
        set({ shellV2Enabled });
        // Same rule as theme/sidebar: never persist before hydration settles.
        void persistAfterHydration();
      },

      // Persist the app-level theme selection ("system" or a theme id). The
      // theme store owns resolution/applying; this only records the choice so
      // it survives restarts.
      setTheme(theme: string) {
        if (!theme || get().theme === theme) return;
        set({ theme });
        // Persist only after hydration settles — a pre-hydration pick must
        // never write the still-empty project list over the saved document.
        void persistAfterHydration();
      },

      // The provider new KödChat threads start on. Rejects an id KödChat can't
      // actually drive, so the preference can never make the composer unusable.
      setChatProvider(chatProvider: string) {
        if (!isChatProvider(chatProvider) || get().chatProvider === chatProvider) {
          return;
        }
        set({ chatProvider });
        void persistAfterHydration();
      },

      setSidebarMode(sidebarMode: SidebarMode) {
        if (!isSidebarMode(sidebarMode) || get().sidebarMode === sidebarMode)
          return;
        set({ sidebarMode });
        // Match theme/color persistence: wait for hydration so a quick toggle
        // cannot write an empty in-memory project list over the saved document.
        void persistAfterHydration();
      },

      toggleSidebarMode() {
        get().setSidebarMode(get().sidebarMode === "full" ? "rail" : "full");
      },

      setFilesCollapsed(filesCollapsed: boolean) {
        if (get().filesCollapsed === filesCollapsed) return;
        set({ filesCollapsed });
        // Same rule as setSidebarMode: never persist before hydration settles.
        void persistAfterHydration();
      },

      toggleFilesPanel() {
        get().setFilesCollapsed(!get().filesCollapsed);
      },

      setProjectColor(projectId: string, colorId: string | null) {
        if (colorId !== null && !isProjectColorId(colorId)) return;
        const project = get().projects.find((p) => p.id === projectId);
        if (!project || project.color === colorId) return;
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId ? { ...p, color: colorId ?? undefined } : p,
          ),
        }));
        // Follow the theme-setting pattern: do not let a pre-hydration change
        // overwrite the persisted project list before the read has settled.
        void persistAfterHydration();
      },

      // Record a project's open editor tabs (v1.1) and persist debounced —
      // opening/closing tabs in a burst writes once on pause, like layout changes.
      // An empty array is a valid state (all tabs closed) and is persisted.
      setOpenTabs(projectId: string, paths: string[]) {
        if (
          !get().projects.some((p) => p.id === projectId) &&
          !remoteTargetForProjectId(get().remoteTargets, projectId)
        ) {
          return;
        }
        if (!isOpenTabs(paths)) return;
        set((s) => ({ openTabs: { ...s.openTabs, [projectId]: paths } }));
        persistDebounced();
      },

      // Pin a remote {host, path} target (KödSSH Pro, M11c). Idempotent; a
      // corrupt/empty target is ignored. Persists after hydration settles so a
      // quick pin can't write the still-empty project list over the saved doc
      // (same discipline as theme/color/sidebar).
      pinRemoteTarget(target: RemoteTarget) {
        const clean = parseRemoteTarget(target);
        if (!clean) return;
        const key = remoteTargetKey(clean);
        if (get().remoteTargets.some((t) => remoteTargetKey(t) === key)) return;
        set((s) => ({ remoteTargets: [...s.remoteTargets, clean] }));
        void persistAfterHydration();
      },

      // Remove a pinned remote target (matched by host+path) and persist.
      unpinRemoteTarget(target: RemoteTarget) {
        const key = remoteTargetKey(target);
        if (!get().remoteTargets.some((t) => remoteTargetKey(t) === key))
          return;
        const projectId = remoteProjectId(target);
        const doomed = get().sessions.filter(
          (session) => session.projectId === projectId,
        );
        set((s) => {
          const remoteTargets = s.remoteTargets.filter(
            (candidate) => remoteTargetKey(candidate) !== key,
          );
          const activeSessionByProject = { ...s.activeSessionByProject };
          delete activeSessionByProject[projectId];
          const expandedProjects = { ...s.expandedProjects };
          delete expandedProjects[projectId];
          const openTabs = { ...s.openTabs };
          delete openTabs[projectId];
          return {
            remoteTargets,
            sessions: s.sessions.filter(
              (session) => session.projectId !== projectId,
            ),
            activeSessionByProject,
            expandedProjects,
            openTabs,
            activeProjectId:
              s.activeProjectId === projectId
                ? (s.projects[0]?.id ??
                  (remoteTargets[0]
                    ? remoteProjectId(remoteTargets[0])
                    : null))
                : s.activeProjectId,
          };
        });
        pendingSessions.delete(projectId);
        for (const session of doomed) {
          lastForegroundBySession.delete(session.id);
          deps.onActivity?.({
            type: "session-closed",
            projectId,
            sessionId: session.id,
          });
          if (!ownsNoPty(session)) {
            void deps.registry.close(session.id);
          }
          deps.onSessionRemoved?.(session);
        }
        void persistAfterHydration();
      },

      // Record one review scope's reviewed-path set (KödPR, M12d) and persist
      // debounced, like setOpenTabs. Keyed by project PATH — the review store
      // only knows project roots — and capped per project (oldest `updatedAt`
      // evicted first) so reviewing many short-lived branches can't grow the
      // document forever. An empty array (nothing reviewed) is still recorded.
      setReviewChecks(projectRoot: string, scopeKey: string, paths: string[]) {
        if (!get().projects.some((p) => p.path === projectRoot)) return;
        if (!isOpenTabs(paths)) return;
        set((s) => {
          const forProject = { ...(s.reviewChecks[projectRoot] ?? {}) };
          forProject[scopeKey] = { paths, updatedAt: Date.now() };
          return {
            reviewChecks: {
              ...s.reviewChecks,
              [projectRoot]: capReviewScopes(forProject),
            },
          };
        });
        persistDebounced();
      },

      setVoicePreferences(preferences: VoicePreferences) {
        const normalized = normalizeVoicePreferences(preferences);
        if (sameVoicePreferences(get().voicePreferences, normalized)) return;
        set({ voicePreferences: normalized });
        void persistAfterHydration();
      },

      setLocalModelPreferences(preferences: LocalModelPreferences) {
        const normalized = normalizeLocalModelPreferences(preferences);
        if (sameLocalModelPreferences(get().localModelPreferences, normalized))
          return;
        set({ localModelPreferences: normalized });
        void persistAfterHydration();
      },

      // Switch Ködade's background prompt on/off (#63). Off means every spawn
      // is byte-identical to a build without the feature.
      setAmbientPromptEnabled(enabled: boolean) {
        if (get().ambientPromptEnabled === enabled) return;
        set({ ambientPromptEnabled: enabled });
        void persistAfterHydration();
      },

      // Replace the background prompt's text, or clear back to Ködade's own
      // default. Trimmed and capped — this becomes a system prompt on every run.
      setAmbientPromptOverride(text: string | null) {
        const normalized = normalizeAmbientOverride(text);
        if (get().ambientPromptOverride === normalized) return;
        set({ ambientPromptOverride: normalized });
        void persistAfterHydration();
      },

      setMemoryAgentAccess(preference: MemoryAgentAccessPreference) {
        const normalized = normalizeMemoryAgentAccess(preference);
        const current = get().memoryAgentAccess;
        if (
          current.enabled === normalized.enabled &&
          current.access === normalized.access
        ) {
          return;
        }
        set({ memoryAgentAccess: normalized });
        void persistAfterHydration();
      },

      // Record a project's KödWhisper Pro user vocabulary terms (M9e), keyed by
      // path, persisted debounced like setReviewChecks. Trims/dedupes and drops
      // the entry entirely when the list is empty. No-op for an untracked path.
      setVoiceVocabularyTerms(projectRoot: string, terms: string[]) {
        if (!get().projects.some((p) => p.path === projectRoot)) return;
        if (!isOpenTabs(terms)) return;
        const cleaned = capVoiceVocabularyTerms([
          ...new Set(terms.map((term) => term.trim()).filter(Boolean)),
        ]);
        set((s) => {
          const next = { ...s.voiceVocabulary };
          if (cleaned.length > 0) next[projectRoot] = cleaned;
          else delete next[projectRoot];
          return { voiceVocabulary: next };
        });
        persistDebounced();
      },

      // The shell behind a session died (natural exit or failed spawn). The
      // session stays listed so the user can read the terminal's message and
      // close it; the sidebar renders it dimmed.
      markSessionExited(id: string) {
        const session = get().sessions.find((candidate) => candidate.id === id);
        if (!session || session.exited) return;
        const project = get().projects.find(
          (candidate) => candidate.id === session.projectId,
        );
        // Drop any auto-name too — a dead shell has no foreground to name it.
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id ? { ...x, exited: true, autoName: undefined } : x,
          ),
        }));
        lastForegroundBySession.delete(id);
        if (project) deps.onSessionExited?.(project, session);
        persistDebounced(); // an exited session must not be revived on reload
      },

      setShellBase(name: string) {
        if (name) set({ shellBase: name });
      },

      // Manual inline rename. Trims; empty reverts (no-op). Locks the name so
      // auto-naming can never touch it again, and drops any live auto-name.
      renameSession(id: string, name: string) {
        const trimmed = name.trim();
        if (!trimmed) return; // empty → keep the current name
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id
              ? { ...x, name: trimmed, nameLocked: true, autoName: undefined }
              : x,
          ),
        }));
        persistDebounced(); // the renamed (locked) name survives a reload
      },

      // Flip a project's session-list expansion (session-local, not persisted).
      toggleProjectExpanded(projectId: string) {
        if (
          !get().projects.some((p) => p.id === projectId) &&
          !remoteTargetForProjectId(get().remoteTargets, projectId)
        ) {
          return;
        }
        set((s) => ({
          expandedProjects: {
            ...s.expandedProjects,
            [projectId]: !s.expandedProjects[projectId],
          },
        }));
      },

      // One poll tick: for every VISIBLE (active-project) live session, read its
      // foreground process. Activity transitions are independent from auto-name
      // mutation, so manually locked sessions still report working and idle.
      async pollForeground() {
        if (!deps.foreground || isHidden()) return;
        // Claim this cycle's token before awaiting any lookup.
        const myPoll = ++pollSeq;
        const { activeProjectId, sessions, shellBase, expandedProjects } =
          get();
        if (!activeProjectId) return;
        // Visible = active project's sessions plus any EXPANDED project's —
        // multi-expand (v1.2) made background sessions visible, so their
        // auto-names and dots must stay live too.
        const visible = sessions.filter(
          (s) =>
            (s.projectId === activeProjectId ||
              expandedProjects[s.projectId]) &&
            !s.exited &&
            // Chat threads and KödWork tasks have no PTY to read a foreground from.
            !ownsNoPty(s),
        );

        // Resolve all visible sessions' foregrounds concurrently, then apply.
        const results = await Promise.all(
          visible.map(async (s) => {
            try {
              return {
                id: s.id,
                name: await deps.foreground!.foreground(s.id),
              };
            } catch {
              return { id: s.id, name: null }; // lookup failed → treat as idle
            }
          }),
        );

        // Ordering guard: a newer cycle started (and may already have applied a
        // fresher result) while we awaited — drop this stale batch entirely.
        if (myPoll < latestPoll) return;
        latestPoll = myPoll;

        const activityFacts: WorkspaceActivityFact[] = [];
        const foregroundBySession = new Map(
          results.map((result) => [result.id, result.name]),
        );
        set((s) => {
          let changed = false;
          const sessions = s.sessions.map((sess) => {
            const foreground = foregroundBySession.get(sess.id);
            if (foreground === undefined) return sess;
            // A late result must never restore an auto-name on a dead row. Locked
            // sessions still emit Activity metadata; only their visible name is
            // protected from automatic mutation.
            if (sess.exited) return sess;
            // A foreground that's the shell (or the session's own base shell, or
            // unresolved) means idle → no auto-name. Anything else is the
            // running command's name.
            const fg = foreground;
            const isIdle =
              !fg ||
              SHELL_NAMES.has(fg) ||
              fg === shellBase ||
              fg === s.shellBase;
            const process = isIdle ? null : fg;
            const hadForeground = lastForegroundBySession.has(sess.id);
            if (
              hadForeground
                ? lastForegroundBySession.get(sess.id) !== process
                : process !== null
            ) {
              lastForegroundBySession.set(sess.id, process);
              activityFacts.push({
                type: "terminal-foreground",
                projectId: sess.projectId,
                sessionId: sess.id,
                process,
              });
            }
            const autoName = sess.nameLocked
              ? undefined
              : (process ?? undefined);
            if (sess.autoName === autoName) return sess;
            changed = true;
            return { ...sess, autoName };
          });
          return changed ? { sessions } : {};
        });
        for (const fact of activityFacts) deps.onActivity?.(fact);
      },

      // Start the poll interval (idempotent — a second call is a no-op). Ticks
      // fire pollForeground(); errors inside are swallowed there.
      startForegroundPolling() {
        if (pollHandle !== null) return;
        pollHandle = setTimer(
          () => void get().pollForeground(),
          pollIntervalMs,
        );
      },

      // Stop the poll interval (idempotent).
      stopForegroundPolling() {
        if (pollHandle === null) return;
        clearTimer(pollHandle);
        pollHandle = null;
      },
    };
  });
}
