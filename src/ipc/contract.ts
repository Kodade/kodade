// The single typed IPC contract between the frontend and the Rust core.
// Nothing outside this ipc/ folder may call Tauri invoke/listen directly —
// the frontend talks to Rust through the interfaces below, so everything can
// be tested against mocks that implement the same shapes.

// Command names (must match #[tauri::command] fn names in Rust).
export const CMD = {
  spawn: "pty_spawn",
  write: "pty_write",
  resize: "pty_resize",
  kill: "pty_kill",
  storageRead: "storage_read",
  storageWrite: "storage_write",
  storageReadDoc: "storage_read_doc",
  storageWriteDoc: "storage_write_doc",
  storageDeleteDoc: "storage_delete_doc",
  agentStart: "agent_start",
  agentSend: "agent_send",
  agentEnd: "agent_end",
  agentCancel: "agent_cancel",
  agentListLive: "agent_list_live",
  isDir: "fs_is_dir",
  canonicalize: "fs_canonicalize",
  listDir: "fs_list_dir",
  readFile: "fs_read_file",
  writeFile: "fs_write_file",
  watch: "fs_watch",
  unwatch: "fs_unwatch",
  kodworkLedgerBegin: "kodwork_ledger_begin",
  kodworkLedgerFinish: "kodwork_ledger_finish",
  kodworkLedgerAccept: "kodwork_ledger_accept",
  kodworkLedgerRestore: "kodwork_ledger_restore",
  createFile: "fs_create_file",
  createDir: "fs_create_dir",
  rename: "fs_rename",
  trash: "fs_trash",
  reveal: "fs_reveal",
  openUrl: "open_url",
  shellName: "shell_name",
  detectProvider: "detect_provider",
  ptyForeground: "pty_foreground",
  runGh: "run_gh",
  runGit: "run_git",
  browserCreate: "browser_create",
  browserNavigate: "browser_navigate",
  browserBack: "browser_back",
  browserForward: "browser_forward",
  browserReload: "browser_reload",
  browserSetBounds: "browser_set_bounds",
  browserShow: "browser_show",
  browserHide: "browser_hide",
  browserDestroy: "browser_destroy",
  browserAgentReady: "browser_agent_ready",
  voxInit: "vox_init",
  voxStart: "vox_start",
  voxStop: "vox_stop",
  voxCancel: "vox_cancel",
  voxTeardown: "vox_teardown",
  voxDownloadModel: "vox_download_model",
  voxListInputDevices: "vox_list_input_devices",
  localModeldStatus: "local_modeld_status",
  localModeldStart: "local_modeld_start",
  localModeldStop: "local_modeld_stop",
  localDownloadModel: "local_download_model",
  localModelPath: "local_model_path",
  localValidateModel: "local_validate_model",
  openMicrophonePrivacySettings: "open_microphone_privacy_settings",
  configScan: "config_scan",
  configRead: "config_read",
  configReadOptionalText: "config_read_optional_text",
  configBaselineText: "config_baseline_text",
  configEnv: "config_env",
  configRename: "config_rename",
  configWrite: "config_write",
  configRemoveFile: "config_remove_file",
  configBackup: "config_backup",
  configRestore: "config_restore",
  kodSkillsPackRead: "kodskills_pack_read",
  configDirSnapshot: "config_dir_snapshot",
  configExternalSkillSnapshot: "config_external_skill_snapshot",
  configInstallDir: "config_install_dir",
  configRemoveDir: "config_remove_dir",
  configRestoreDir: "config_restore_dir",
  projectSkillPick: "project_skill_pick",
  memoryRegisterWorkspace: "memory_register_workspace",
  memoryResolveWorkspace: "memory_resolve_workspace",
  memoryListWorkspaces: "memory_list_workspaces",
  memoryRelinkWorkspace: "memory_relink_workspace",
  memoryProjectsVault: "memory_projects_vault",
  memoryRegisterProjectsVault: "memory_register_projects_vault",
  memoryWorkspaceProjectMapping: "memory_workspace_project_mapping",
  memoryMapWorkspaceToProject: "memory_map_workspace_to_project",
  memoryProjectWorkspaceMappings: "memory_project_workspace_mappings",
  memoryPreviewProjectScaffold: "memory_preview_project_scaffold",
  memoryApplyProjectScaffold: "memory_apply_project_scaffold",
  memoryPreviewLegacyMigration: "memory_preview_legacy_migration",
  memoryApplyLegacyMigration: "memory_apply_legacy_migration",
  memoryRollbackLegacyMigration: "memory_rollback_legacy_migration",
  memoryOpenProjectInObsidian: "memory_open_project_in_obsidian",
  memoryContext: "memory_context",
  memorySearch: "memory_search",
  memoryGet: "memory_get",
  memoryListDeleted: "memory_list_deleted",
  memoryRemember: "memory_remember",
  memoryRevise: "memory_revise",
  memoryForget: "memory_forget",
  memoryRestore: "memory_restore",
  memoryCheckpoint: "memory_checkpoint",
  memorySearchCheckpoints: "memory_search_checkpoints",
  memoryWorkingStatus: "memory_working_status",
  memoryActivateWorking: "memory_activate_working",
  memorySyncWorking: "memory_sync_working",
  memoryObserveCommit: "memory_observe_commit",
  memoryAudit: "memory_audit",
  memorySetRetention: "memory_set_retention",
  memoryRunRetention: "memory_run_retention",
  memoryDrainRetention: "memory_drain_retention",
  memoryExportToDirectory: "memory_export_to_directory",
  memoryPurgeWorkspace: "memory_purge_workspace",
  memoryRecordActivity: "memory_record_activity",
  memoryDatabasePath: "memory_database_path",
  memoryMcpBinaryPath: "memory_mcp_binary_path",
  memoryMcpHealth: "memory_mcp_health",
  sshDetect: "ssh_detect",
  sshConfigRead: "ssh_config_read",
  sshListDir: "ssh_list_dir",
  sshExec: "ssh_exec",
} as const;

// Event names (must match EVENT_* constants in Rust).
export const EVENT = {
  output: "pty://output",
  exit: "pty://exit",
  agentEvent: "agent://event",
  agentExit: "agent://exit",
  fsChanged: "fs://changed",
  browserNavigated: "browser://navigated",
  browserAgentActivate: "browser://agent-activate",
  voxError: "vox://error",
} as const;

// --- Command payloads ---

export type SpawnArgs = {
  id: string; // frontend-chosen session id; spawn REJECTS ids that are already live
  cwd: string; // working directory for the shell ("" = user's home)
  cols: number;
  rows: number;
};

export type WriteArgs = {
  id: string;
  data: string; // base64-encoded input bytes
};

export type ResizeArgs = {
  id: string;
  cols: number;
  rows: number;
};

export type KillArgs = {
  id: string;
};

// --- Event payloads ---

export type OutputEvent = {
  id: string;
  data: string; // base64-encoded output bytes
};

export type ExitEvent = {
  id: string;
  code: number | null;
};

// --- KödChat headless agent runs (issue #163) ---
//
// The chat counterpart to the pty_* surface. One run is one agent turn: Rust
// resolves `bin` through the login shell (so the CLI inherits the user's own
// credentials — Kodade never proxies auth), spawns it with the argv the
// provider catalog built, and streams stdout back one raw line at a time.
// Nothing here knows a CLI dialect; src/agents/ parses every line.

export type AgentStartArgs = {
  id: string; // caller-chosen run id; start REJECTS ids that are already live
  cwd: string; // project root the agent runs in ("" = user's home)
  bin: string; // bare executable name, resolved through the login shell
  args: string[]; // already-built argv (providers/catalog.ts `stream`)
  // Written to the child's stdin, which is then closed — the one-shot turn
  // shape both shipped dialects use. Omit to keep stdin open for `send`.
  stdin?: string;
};

export type AgentSendArgs = {
  id: string;
  data: string; // raw text appended to a still-open stdin
};

export type AgentCancelArgs = {
  id: string;
};

// Native process liveness is authoritative: this list survives a webview
// reload so KödChat can reclaim a still-running provider turn.
export type AgentLiveRun = { id: string };

// One raw stdout line. Parsing is entirely the adapter's job.
export type AgentEvent = {
  id: string;
  line: string;
};

// Emitted once when a run's process exits, with the captured stderr head.
export type AgentExitEvent = {
  id: string;
  code: number | null;
  stderr: string;
};

export type VoxEvent =
  | { type: "level"; rms: number }
  | { type: "state"; state: "capturing" | "transcribing" }
  // Streaming partial hypothesis (KödWhisper Pro, M9e). Emitted only while a
  // capture ran with `streaming: true`; carries the LocalAgreement-stabilized
  // prefix so committed text never flicker-rewrites. Free tier never sees these.
  | { type: "partial"; text: string }
  | { type: "error"; message: string };

// deviceName selects a specific microphone by name (from listInputDevices);
// omit or null keeps the host default. Rust falls back to the default itself
// if the named device no longer exists (unplugged since last selection).
export type VoxInitArgs = { modelPath: string; deviceName?: string | null };
export type VoxInitResult = {
  device: string | null;
  backend: "metal" | "cpu";
  modelPath: string;
};
// initialPrompt biases the whisper decode toward the project vocabulary
// (KödWhisper Pro); omit/null for the unbiased free-tier decode. streaming
// turns on the actor's re-decode-a-growing-buffer partial mode — the store only
// sets it when `vox.streaming` is entitled AND the hardware is capable, so free
// and weak-hardware captures stay transcribe-on-release.
export type VoxStartArgs = {
  language?: string | null;
  initialPrompt?: string | null;
  streaming?: boolean;
};
export type VoxStopResult = {
  utteranceId: string;
  text: string;
  durationMs: number;
};
export type VoxDownloadArgs = {
  url: string;
  destPath: string;
  // Rust verifies before the atomic install; a mismatch deletes the partial.
  expectedSha256?: string | null;
  // Expert storage-location override: an absolute directory destPath must
  // live inside. Omit or null keeps the default appDataDir()/models root.
  modelRoot?: string | null;
};
export type VoxDownloadProgress = { downloaded: number; total: number | null };
export type VoxDownloadResult = { sha256: string; bytes: number };
export type VoxErrorEvent = { message: string };

// One directory entry (one level; the tree expands children lazily).
export type DirEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

// Result of reading a file — the two failure modes are explicit so the editor
// shows a placeholder instead of hanging on a huge/binary file. Shape mirrors
// the Rust FileRead enum (serde tag = "kind").
export type FileRead =
  | { kind: "text"; content: string }
  | { kind: "tooLarge"; bytes: number }
  | { kind: "binary"; bytes?: number };

// Debounced batch of paths affected by filesystem changes under the watched root.
export type FsChangedEvent = {
  paths: string[];
};

// Tauri types drag-drop positions as PhysicalPosition, but macOS delivers
// logical points from WKWebView while Windows delivers physical pixels.
// Components convert only non-macOS positions before CSS hit-testing.
export type DropPosition = {
  x: number;
  y: number;
};

export type FileDropEvent = {
  paths: string[];
  position: DropPosition;
};

// --- KödHarness config surface (M10) ---
//
// One guarded directory entry from `config_scan`. Mirrors the Rust ConfigEntry
// (serde camelCase). A symlinked skill entry carries its resolved `target`;
// `orphaned` is true for a symlink whose target no longer exists. `children`
// is the one-level recurse (populated for directory entries, e.g. a skill dir's
// SKILL.md) — null for leaves and for the nested children themselves.
export type ConfigDirEntry = {
  name: string;
  path: string; // absolute path of the entry (the link location for a symlink)
  isDir: boolean; // resolved: does it point at a directory
  isSymlink: boolean;
  target: string | null; // resolved symlink target (symlinks only)
  orphaned: boolean; // a symlink whose target is missing
  children: ConfigDirEntry[] | null; // one level deep, for skills-dir recurse
};

// Result of scanning one harness location. `missing` (the dir simply isn't
// there) is normal and produces no artifacts; `unreadable` (guard rejection or
// permission denied) becomes a per-location HarnessScanError — never a throw.
export type ConfigScan =
  | { status: "listing"; root: string; rootIsSymlink?: boolean; entries: ConfigDirEntry[] }
  | { status: "missing"; root: string }
  | { status: "unreadable"; root: string; rootIsSymlink?: boolean; error: string };

// KödSkills resource and guarded directory-mutation shapes (M15). Pack files
// are UTF-8 text in the pinned upstream release; hashes are SHA-256 over those
// exact UTF-8 bytes. Directory snapshots are relative-path/hash pairs so all
// ownership and update decisions remain in TypeScript.
export type KodSkillsPackBundle = {
  manifest: string;
  files: { path: string; contents: string }[];
};

// A user-selected project skill, read by the native picker command only after
// the operating-system dialog returns the directory. Files are bounded UTF-8
// text with portable relative paths; TypeScript owns manifest interpretation.
export type ProjectSkillSourceBundle = {
  root: string;
  files: { path: string; contents: string }[];
};

export type ConfigFileHash = { path: string; sha256: string };
export type ConfigInstallFile = ConfigFileHash & { contents: string };
export type ConfigDirSnapshot =
  | { status: "missing"; path: string }
  | { status: "snapshot"; path: string; files: ConfigFileHash[] };

// The real home dir + OS family (M10c), so global-scope templates resolve
// against a real user instead of a blank-home placeholder. Mirrors the Rust
// ConfigEnv (serde camelCase). Rust is the only place that can see the
// login-shell's actual home, so this is a getter, nothing more — the platform
// literal is narrowed to the two shipping targets ("mac" | "windows").
//
// appDataRoaming/appDataLocal (M10g): the real %APPDATA%/%LOCALAPPDATA% roots,
// read directly from the environment — null on macOS/Linux, and null on
// Windows only in the (unexpected) case those variables are unset. A handful
// of CLIs keep their global config under %APPDATA% instead of the
// home-relative dotfile path every other adapter uses (opencode confirmed);
// the harness catalog's per-template `windows` override consults these.
export type ConfigEnv = {
  home: string;
  platform: "mac" | "windows";
  appDataRoaming: string | null;
  appDataLocal: string | null;
};

// The guarded config command surface. `scan` lists one config directory (with a
// one-level recurse and symlink resolution); `read` reads a single config file
// with the existing fs size/binary caps. Both take the active `projectRoot` so
// Rust's configguard can add it to the per-call allowlist. `env` hands over the
// real home/platform for building a global-scope ScanContext. Rust never parses
// artifact bytes — all format/shape logic lives in TypeScript (scan.ts + adapters).
export interface ConfigIpc {
  scan(root: string, projectRoot: string): Promise<ConfigScan>;
  read(path: string, projectRoot: string): Promise<FileRead>;
  // Distinguish a missing artifact from an unreadable one. Transaction plans
  // need this ownership fact to preserve pre-existing empty files.
  readOptionalText(path: string, projectRoot: string): Promise<string | null>;
  // Recover the exact pre-onboarding bytes from a guarded sibling backup whose
  // sha-256 is recorded in the managed MCP entry.
  baselineText(path: string, expectedHash: string, projectRoot: string): Promise<string>;
  env(): Promise<ConfigEnv>;

  // --- Guarded write surface (M10d) ---
  // Every write carries `projectRoot` so Rust's configguard authorizes it under
  // the same per-call allowlist the reads use. All reject with a clear error
  // string the store surfaces inline; none can escape the guard.

  // The reversible enable/disable primitive: rename a skill/subagent entry to
  // add or strip the `.disabled` suffix. Rust rejects any rename that isn't
  // exactly `path` ± ".disabled", and operates on the link entry itself (never
  // following a symlink into a dotfiles target).
  rename(path: string, newPath: string, projectRoot: string): Promise<void>;
  // Atomic write with optimistic concurrency: `expectedHash` is the sha-256 of
  // the bytes the caller last read; a mismatch rejects. Prior bytes are backed
  // up first. Returns the backup path ("" for a brand-new file). Consumed by
  // M10e instruction editing; the skills rename path does not use it.
  write(
    path: string,
    contents: string,
    expectedHash: string,
    projectRoot: string,
  ): Promise<string>;
  // Remove an exact newly-created config during transaction rollback. The
  // current sha-256 must match the bytes Ködade wrote; no unrelated or changed
  // file can be deleted through this primitive.
  removeFile(path: string, expectedHash: string, projectRoot: string): Promise<void>;
  // Copy a file's current bytes to a timestamped `.kodade-bak` sibling; returns
  // the backup path.
  backup(path: string, projectRoot: string): Promise<string>;
  // Atomically restore a file from a backup. Rust refuses a backupPath that
  // isn't a `.kodade-bak` sibling or escapes the guard.
  restore(path: string, backupPath: string, projectRoot: string): Promise<void>;

  // Read the fixed, bundled KödSkills pack. Packaged builds resolve from the
  // Tauri resource directory; development resolves the repository resource.
  kodSkillsPackRead(): Promise<KodSkillsPackBundle>;
  // Recursively hash one real skill directory. Symlinks at the directory or
  // anywhere below it are rejected rather than followed.
  dirSnapshot(path: string, projectRoot: string): Promise<ConfigDirSnapshot>;
  // Hash an externally managed skill symlink without returning or mutating its
  // target. Used only to prove exact bundled-contract equivalence.
  externalSkillSnapshot(path: string, projectRoot: string): Promise<ConfigFileHash[]>;
  // Atomically create (expectedFiles=null) or replace (exact old snapshot)
  // one skill directory. Returns a backup path for replacement, else "".
  installDir(
    path: string,
    files: ConfigInstallFile[],
    expectedFiles: ConfigFileHash[] | null,
    projectRoot: string,
  ): Promise<string>;
  // Remove one exact, unmodified skill directory. Explicit uninstall keeps a
  // reversible backup; rollback of a just-installed tree discards it.
  removeDir(
    path: string,
    expectedFiles: ConfigFileHash[],
    projectRoot: string,
    keepBackup: boolean,
  ): Promise<string>;
  // Restore a prior directory backup. expectedFiles is the exact current tree
  // for update rollback, or null when uninstall left the target absent.
  restoreDir(
    path: string,
    backupPath: string,
    expectedFiles: ConfigFileHash[] | null,
    projectRoot: string,
  ): Promise<void>;
}

// Unsubscribe function returned by the event listeners.
export type Unlisten = () => void;

// The contract both the real Tauri implementation and the mock satisfy.
export interface PtyIpc {
  spawn(args: SpawnArgs): Promise<void>;
  write(args: WriteArgs): Promise<void>;
  resize(args: ResizeArgs): Promise<void>;
  kill(args: KillArgs): Promise<void>;
  onOutput(handler: (e: OutputEvent) => void): Promise<Unlisten>;
  onExit(handler: (e: ExitEvent) => void): Promise<Unlisten>;
}

// Voice capture is one long-lived native session. Channels remain an
// implementation detail here so the mock stays a simple callback-driven seam.
export interface VoxIpc {
  init(args: VoxInitArgs): Promise<VoxInitResult>;
  start(args: VoxStartArgs, onEvent: (event: VoxEvent) => void): Promise<string>;
  stop(): Promise<VoxStopResult>;
  cancel(): Promise<void>;
  teardown(): Promise<void>;
  downloadModel(
    args: VoxDownloadArgs,
    onProgress: (progress: VoxDownloadProgress) => void,
  ): Promise<VoxDownloadResult>;
  onError(handler: (event: VoxErrorEvent) => void): Promise<Unlisten>;
  // Paths and deletion are frontend product policy. The real adapter resolves
  // models below appDataDir()/models by default, or below modelsDir when the
  // expert storage-location override is set, and uses the existing confined
  // trash path for deletion.
  modelPath(fileName: string, modelsDir?: string | null): Promise<string>;
  deleteModel(path: string, modelsDir?: string | null): Promise<void>;
  // Every microphone name the host currently exposes, for the expert
  // input-device picker.
  listInputDevices(): Promise<string[]>;
}

// KödLocal's control plane remains native: Rust owns the shared daemon process
// and verified files, while the app and CLI use direct loopback HTTP for model
// data and generation. This interface deliberately contains no chat method.
export type LocalDaemonStatus = {
  running: boolean;
  managed: boolean;
  port: number;
  binaryPath: string | null;
  cliPath: string | null;
  message: string | null;
};
export type LocalDownloadArgs = {
  url: string;
  fileName: string;
  expectedSha256: string;
};
export type LocalDownloadProgress = { downloaded: number; total: number | null };
export type LocalDownloadResult = { path: string; sha256: string; bytes: number };
export type LocalModelPathInfo = { path: string; bytes: number; format: "gguf" | "mlx" };

export interface LocalIpc {
  status(): Promise<LocalDaemonStatus>;
  start(port?: number): Promise<LocalDaemonStatus>;
  stop(): Promise<void>;
  downloadModel(
    args: LocalDownloadArgs,
    onProgress: (progress: LocalDownloadProgress) => void,
  ): Promise<LocalDownloadResult>;
  modelPath(fileName: string): Promise<string>;
  validateModel(path: string): Promise<LocalModelPathInfo>;
}

// Headless agent runs (KödChat). Deliberately separate from PtyIpc: a chat turn
// is a bounded structured-stream process, not a terminal, and mixing the two
// would push dialect knowledge into the PTY path.
export interface AgentIpc {
  start(args: AgentStartArgs): Promise<void>;
  send(args: AgentSendArgs): Promise<void>;
  end?(args: AgentCancelArgs): Promise<void>;
  cancel(args: AgentCancelArgs): Promise<void>;
  listLive(): Promise<AgentLiveRun[]>;
  onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten>;
  onExit(handler: (e: AgentExitEvent) => void): Promise<Unlisten>;
}

// Persistence of the JSON app-data documents. Rust only moves bytes (atomic
// write); shape and versioning live in TypeScript.
//
// `read`/`write` are the single main document (kodade.json). The `*Doc` trio is
// the named side-document surface KödChat transcripts use
// (`chats/<threadId>.json`): too large and too private for the main doc, and
// loaded lazily per thread. Rust validates the name so it can never escape the
// app data dir, and still never reads the contents.
export interface StorageIpc {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
  readDoc(name: string): Promise<string | null>;
  writeDoc(name: string, contents: string): Promise<void>;
  deleteDoc(name: string): Promise<void>;
}

// Platform facilities: folder picker, file drag-and-drop, path checks, and
// the login shell's basename (for default session names).
export interface PlatformIpc {
  pickFolder(): Promise<string | null>;
  pickProjectSkill(): Promise<ProjectSkillSourceBundle | null>;
  onFileDrop(handler: (drop: FileDropEvent) => void): Promise<Unlisten>;
  isDir(path: string): Promise<boolean>;
  canonicalize(path: string): Promise<string>; // resolves symlinks; input on failure
  shellName(): Promise<string>;
}

// Provider (agent-CLI) detection. Runs `<bin> --version` inside a login shell
// so the result matches the user's real PATH. Returns the raw stdout when the
// binary exists, or null when it's missing/errors — TypeScript trims it to a
// short version token. Rust never parses the output.
export interface ProviderIpc {
  detect(bin: string): Promise<string | null>;
}

// Foreground-process lookup for a live PTY. Returns the basename of whatever
// process currently owns the tty's foreground (the shell when idle, the running
// command otherwise), or null for an unknown/exited session. The projects store
// polls this lightly for visible sessions to auto-name them and pulse the dot.
export interface ForegroundIpc {
  foreground(id: string): Promise<string | null>;
}

// Opens a URL outside the webview. Rust validates the URL scheme before asking
// the OS to launch the user's default handler.
export interface ExternalUrlIpc {
  openUrl(url: string): Promise<void>;
  // Deep-links into the OS microphone-privacy pane (macOS System Settings →
  // Privacy & Security → Microphone; Windows Settings → Privacy → Microphone)
  // for the KödWhisper permission-denied guidance. The target is fixed on the
  // Rust side — never a caller-supplied URL.
  openMicrophonePrivacySettings(): Promise<void>;
}

export type GhOutput = { stdout: string; stderr: string };

// Constrained access to the user's own gh installation. Rust validates the
// argv and runs it from the active project in the user's login-shell PATH.
export interface GithubIpc {
  run(projectRoot: string, args: string[]): Promise<GhOutput>;
}

export type GitOutput = { stdout: string; stderr: string };

// Constrained, read-only access to the user's own git installation — the KödPR
// diff surface (M12). Rust validates the argv against a fixed allowlist of
// read-only shapes (status, diff, log, rev-parse, merge-base, branch/worktree
// list) and runs git directly from the active project in the login-shell PATH.
// KödPR never writes to the repo; there is no stage/commit/checkout/push shape.
// stdout is raw git output — all parsing lives in TypeScript (M12b).
export interface GitIpc {
  run(projectRoot: string, args: string[]): Promise<GitOutput>;
}

// Native filesystem snapshot seam for KödWork. Rust only captures/restores
// bytes and reports a bounded ledger; review policy and git parsing stay in TS.
export type KodworkNativeFile = {
  path: string;
  relativePath: string;
  change: "added" | "modified" | "deleted";
  binary: boolean;
  before: string | null;
  after: string | null;
  adds: number;
  dels: number;
};

export type KodworkNativeReview = {
  kind: "git" | "folder";
  files: KodworkNativeFile[];
  fingerprint: string;
};

export interface KodworkIpc {
  begin(taskId: string, root: string): Promise<void>;
  finish(taskId: string): Promise<KodworkNativeReview>;
  accept(taskId: string): Promise<void>;
  // The native transaction restores the baseline, verifies it, and rolls the
  // attempted restore back automatically when verification fails.
  restore(taskId: string): Promise<void>;
}

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserNavigatedEvent = { id: string; url: string };
export type BrowserAgentActivateEvent = {
  projectRoot: string;
  url: string | null;
};

// A native child webview with no app IPC handler and an immutable undefined
// `window.ipc` guard. The id keeps the Rust registry additive even though the
// MVP uses one editor browser at a time.
export interface BrowserIpc {
  create(id: string, url: string, bounds: BrowserBounds): Promise<void>;
  navigate(id: string, url: string): Promise<void>;
  back(id: string): Promise<void>;
  forward(id: string): Promise<void>;
  reload(id: string): Promise<void>;
  setBounds(id: string, bounds: BrowserBounds): Promise<void>;
  show(id: string): Promise<void>;
  hide(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  agentReady(projectRoot: string | null): Promise<void>;
  onNavigated(handler: (event: BrowserNavigatedEvent) => void): Promise<Unlisten>;
  onAgentActivate(handler: (event: BrowserAgentActivateEvent) => void): Promise<Unlisten>;
}

// --- KödSSH foundations (M11a) ---
//
// Rust never parses ssh config content — it only locates the `ssh` binary
// (same login-shell resolution as detect_provider) and performs one guarded
// read of a file confined to ~/.ssh. Parsing/Include resolution happen in
// TypeScript (src/ssh/config.ts, src/store/ssh.ts).

export type SshDetectResult = { path: string; version: string };

// Result of a bounded, non-PTY `ssh_exec` (M11c). Mirrors the Rust
// SshExecResult (serde camelCase). `status` is the remote command's exit code
// (null if the local ssh was signal-killed, e.g. on timeout the call rejects
// instead); `truncated` is set when either stream exceeded the output cap.
export type SshExecResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

// Locates the user's `ssh` and reads a file under ~/.ssh (defaulting to
// ~/.ssh/config), for Include-target resolution. Both reject with a clear
// error string on failure — "not found" and "outside ~/.ssh" alike — which
// the ssh store treats as "nothing to show" for the affected location.
export interface SshIpc {
  detect(): Promise<SshDetectResult>;
  // `path` omitted reads ~/.ssh/config; otherwise must canonicalize inside
  // ~/.ssh (Include targets). Returns null when the file simply doesn't
  // exist (a normal "no hosts yet" state, not an error).
  readConfig(path?: string): Promise<string | null>;
  // File names in one directory under ~/.ssh (non-recursive, files only,
  // sorted) — used to expand a globbed Include like `~/.ssh/config.d/*`.
  // Null when the directory doesn't exist; the glob matching itself lives
  // in TypeScript (src/store/ssh.ts).
  listDir(path?: string): Promise<string[] | null>;
  // Bounded remote exec (M11c): `ssh -o BatchMode=yes <host> -- <argv…>`. Rust
  // enforces the host allowlist and runs argv as discrete process args (no
  // local shell); the caller builds/quotes argv via src/ssh/command.ts. Rejects
  // on a hard timeout or an invalid host. Used for remote provider detection
  // and (M11d) file listing.
  exec(host: string, argv: string[], timeoutMs: number): Promise<SshExecResult>;
}

// File-tree facilities: list one directory level, read a file (with size/binary
// caps applied in Rust), and run the active project's recursive watcher. The
// files store owns all tree/refresh logic; Rust just moves data and emits events.
export interface FilesIpc {
  listDir(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<FileRead>;
  // Write the editor buffer back to disk atomically (temp file + rename in Rust).
  // Rejects with a clear error string on failure (read-only file, missing dir)
  // and never truncates the existing file on a failed write.
  writeFile(path: string, contents: string): Promise<void>;
  watch(root: string, generation: number): Promise<void>; // replaces any prior watcher
  unwatch(generation: number): Promise<void>;
  onChanged(handler: (e: FsChangedEvent) => void): Promise<Unlisten>;

  // --- File-manager mutations (v1.1) ---
  // Every mutation carries the active project `root`; Rust confines the target
  // to it (canonicalized) and rejects anything that escapes — these mutate, so
  // unlike the read paths above they are path-confined. All reject with a clear
  // error string on failure (collision, escape, missing dir) which the store
  // surfaces to the UI.
  createFile(root: string, path: string): Promise<void>;
  createDir(root: string, path: string): Promise<void>;
  rename(root: string, from: string, to: string): Promise<void>;
  trash(root: string, path: string): Promise<void>; // recoverable — OS trash
  reveal(root: string, path: string): Promise<void>; // Finder or Explorer
}

export type MemoryKind = "summary" | "decision" | "task" | "fact" | "preference";
export type MemorySource = "user" | "kodade" | "agent";

export type MemoryWorkspace = {
  id: string;
  canonicalRoot: string;
  displayName: string;
  color: string | null;
  capturePaused: boolean;
  activityRetentionDays: number;
  auditRetentionDays: number;
  tombstoneRetentionDays: number;
  createdAt: number;
  updatedAt: number;
};

export type LogicalProject = {
  id: string;
  displayName: string;
  folderExists: boolean;
};

export type ProjectsVault = {
  canonicalRoot: string;
  projects: LogicalProject[];
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceProjectMapping = {
  workspaceId: string;
  projectId: string;
  workspaceRoot: string;
  workspaceDisplayName: string;
  projectDisplayName: string;
  createdAt: number;
  updatedAt: number;
};

export type ScaffoldOperationKind = "createDirectory" | "createFile";

export type ScaffoldOperation = {
  kind: ScaffoldOperationKind;
  relativePath: string;
  content: string | null;
};

export type ProjectScaffoldPlan = {
  workspaceId: string;
  projectId: string;
  projectDisplayName: string;
  vaultRoot: string;
  fingerprint: string;
  operations: ScaffoldOperation[];
};

export type ProjectScaffoldApply = {
  projectId: string;
  created: ScaffoldOperation[];
};

export type LegacyMigrationStatus =
  | "noLegacy"
  | "ready"
  | "blocked"
  | "complete";

export type LegacyMigrationAction =
  | "create"
  | "append"
  | "replacePlaceholder"
  | "skipDuplicate";

export type LegacyMigrationOperation = {
  action: LegacyMigrationAction;
  sourceKind: string;
  sourceRelativePath: string | null;
  sourceSha256: string;
  targetRelativePath: string;
  expectedTargetSha256: string | null;
  targetSha256: string | null;
  itemCount: number;
  conflict: string | null;
};

export type LegacyMigrationPlan = {
  schema: number;
  status: LegacyMigrationStatus;
  workspaceId: string;
  projectId: string;
  projectDisplayName: string;
  fingerprint: string;
  migrationId: string | null;
  manifestSha256: string | null;
  sources: Array<{
    workspaceId: string;
    workspaceDisplayName: string;
    snapshotCount: number;
  }>;
  sourceSnapshots: Array<{ kind: string; sha256: string }>;
  counts: {
    sourceFiles: number;
    memories: number;
    checkpoints: number;
    operations: number;
    duplicates: number;
    conflicts: number;
  };
  operations: LegacyMigrationOperation[];
  systemOperations: Array<{
    sequence: number;
    kind: string;
    target: string;
    localOnly: boolean;
  }>;
  canApply: boolean;
  sourceRetained: boolean;
  createsLocalRecoveryBackup: boolean;
  writesCutoverLast: boolean;
  recovery: {
    migrationId: string;
    manifestSha256: string;
    phase:
      | "prepared"
      | "markdownWritten"
      | "cutover"
      | "complete"
      | "rollingBack";
    canRetry: boolean;
    canRollback: boolean;
  } | null;
};

export type LegacyMigrationApply = {
  projectId: string;
  migrationId: string;
  manifestSha256: string;
  written: number;
  skipped: number;
  backupPath: string;
  sourceRetained: boolean;
};

export type LegacyMigrationRollback = {
  projectId: string;
  migrationId: string;
  restored: number;
  removed: number;
  sourceRetained: boolean;
};

// The bundled KödMCP helper resolved by the desktop app. `path` stays nullable
// so callers can model an unavailable helper without inventing a sentinel path.
export type MemoryMcpBinaryPath = {
  path: string | null;
  exists: boolean;
};

export type MemoryMcpHealth = {
  ok: boolean;
  client: "claude" | "codex";
  access: "read-only" | "read-write";
  action:
    | "setupProjectKnowledge"
    | "migrateLegacyMemory"
    | "recoverMigration"
    | null;
  workspaceId: string;
  projectId: string | null;
  stateHash: string | null;
  tools: string[];
  stage: string;
  message: string;
};

export type MemoryLink = { targetId: string; relation: string };

export type MemoryRecord = {
  id: string;
  workspaceId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  source: MemorySource;
  sourceClient: string;
  sessionId: string | null;
  pinned: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  links: MemoryLink[];
  backlinks: MemoryLink[];
  projectSource?: ProjectKnowledgeProvenance;
};

export type Checkpoint = {
  id: string;
  workspaceId: string;
  summary: string;
  decisions: string[];
  nextActions: string[];
  changedPaths: string[];
  source: MemorySource;
  sourceClient: string;
  sessionId: string | null;
  createdAt: number;
};

export type WorkspaceContext = {
  workspace: MemoryWorkspace;
  latestCheckpoint: Checkpoint | null;
  pinnedDecisions: MemoryRecord[];
  openTasks: MemoryRecord[];
  recentMemories: MemoryRecord[];
  workingMemory?: WorkingMemoryContext | null;
  projectKnowledge?: ProjectKnowledgeContext | null;
};

export type ProjectKnowledgeKind =
  | "project"
  | "state"
  | "worklog"
  | "decision"
  | "knowledge";

export type ProjectKnowledgeSync = {
  status: "current" | "error";
  refreshedAt: number;
  indexedDocuments: number;
  indexHash: string | null;
  truncated: boolean;
  error: string | null;
};

export type ProjectKnowledgeSource = {
  kind: ProjectKnowledgeKind;
  relativePath: string;
  title: string;
  content: string;
  sha256: string;
  modifiedAt: number;
  truncated: boolean;
};

export type ProjectKnowledgeProvenance = {
  projectId: string;
  relativePath: string;
  sha256: string;
};

export type ProjectKnowledgeContext = {
  projectId: string;
  projectDisplayName: string;
  origin: string;
  sync: ProjectKnowledgeSync;
  sources: ProjectKnowledgeSource[];
};

export type WorkingMemoryMode = "commit" | "local";

export type WorkingMemoryStatus = {
  enabled: boolean;
  mode: WorkingMemoryMode;
  directory: string;
  statePath: string;
  worklogPath: string;
  decisionsPath: string;
  lastIndexedAt: number | null;
  lastCommit: string | null;
};

export type WorkingMemoryContext = {
  directory: string;
  state: string;
  recentWorklog: string;
};

export type MemoryQuery = {
  workspaceId: string;
  text: string;
  kinds: MemoryKind[];
  sources: MemorySource[];
  updatedAfter: number | null;
  limit: number;
  offset: number;
};

export type DeletedMemoryQuery = {
  workspaceId: string;
  limit: number;
  offset: number;
};

export type AuditQuery = {
  workspaceId: string;
  targetId: string | null;
  limit: number;
  offset: number;
};

export type MemorySearchHit = {
  id: string;
  workspaceId: string;
  kind: MemoryKind;
  title: string;
  excerpt: string;
  source: MemorySource;
  pinned: boolean;
  version: number;
  updatedAt: number;
  filePath?: string | null;
  projectSource?: ProjectKnowledgeProvenance | null;
};

export type CheckpointQuery = {
  workspaceId: string;
  text: string;
  limit: number;
  offset: number;
};

export type CheckpointSearchHit = {
  id: string;
  workspaceId: string;
  summary: string;
  excerpt: string;
  source: MemorySource;
  sourceClient: string;
  sessionId: string | null;
  createdAt: number;
};

export type Page<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export type NewMemory = {
  workspaceId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  source: MemorySource;
  sourceClient: string;
  sessionId: string | null;
  pinned: boolean;
  idempotencyKey: string | null;
  links: MemoryLink[];
};

export type MemoryRevision = {
  id: string;
  expectedVersion: number;
  kind: MemoryKind;
  title: string;
  body: string;
  pinned: boolean;
  sourceClient: string;
  sessionId: string | null;
  links: MemoryLink[];
};

export type NewCheckpoint = {
  workspaceId: string;
  summary: string;
  decisions: string[];
  nextActions: string[];
  changedPaths: string[];
  source: MemorySource;
  sourceClient: string;
  sessionId: string | null;
  idempotencyKey: string | null;
};

export type Tombstone = {
  id: string;
  workspaceId: string;
  version: number;
  deletedAt: number;
};

export type AuditEntry = {
  id: string;
  workspaceId: string;
  client: string;
  capability: string;
  action: string;
  targetId: string | null;
  sessionId: string | null;
  result: string;
  occurredAt: number;
};

export type RetentionSettings = {
  capturePaused: boolean;
  activityDays: number;
  auditDays: number;
  tombstoneDays: number;
};

export type MutationProvenance = {
  sourceClient: string;
  sessionId: string | null;
};

export type RetentionReport = {
  activityDeleted: number;
  auditDeleted: number;
  tombstonesDeleted: number;
};

export type ExportResult = { markdownPath: string; jsonPath: string };

export type ActivityKind =
  | "projectOpened"
  | "projectClosed"
  | "sessionStarted"
  | "sessionExited"
  | "active"
  | "idle"
  | "fileOpened"
  | "fileSaved"
  | "providerLaunched";

export type NewActivity = {
  workspaceId: string;
  kind: ActivityKind;
  source: string;
  sessionId: string | null;
  relativePath: string | null;
  provider: string | null;
  occurredAt: number | null;
};

export type ActivityEvent = Omit<NewActivity, "occurredAt"> & {
  id: string;
  sequence: number;
  occurredAt: number;
};

export interface MemoryIpc {
  registerWorkspace(root: string, displayName: string, color: string | null): Promise<MemoryWorkspace>;
  resolveWorkspace(root: string): Promise<MemoryWorkspace | null>;
  listWorkspaces(): Promise<MemoryWorkspace[]>;
  relinkWorkspace(
    workspaceId: string,
    expectedRoot: string,
    newRoot: string,
    sourceClient: string,
  ): Promise<MemoryWorkspace>;
  projectsVault(): Promise<ProjectsVault | null>;
  registerProjectsVault(root: string): Promise<ProjectsVault>;
  workspaceProjectMapping(
    workspaceId: string,
  ): Promise<WorkspaceProjectMapping | null>;
  mapWorkspaceToProject(
    workspaceId: string,
    expectedProjectId: string | null,
    projectId: string,
    projectDisplayName: string,
  ): Promise<WorkspaceProjectMapping>;
  projectWorkspaceMappings(
    projectId: string,
  ): Promise<WorkspaceProjectMapping[]>;
  previewProjectScaffold(workspaceId: string): Promise<ProjectScaffoldPlan>;
  applyProjectScaffold(
    workspaceId: string,
    expectedFingerprint: string,
  ): Promise<ProjectScaffoldApply>;
  previewLegacyMigration(workspaceId: string): Promise<LegacyMigrationPlan>;
  applyLegacyMigration(
    workspaceId: string,
    expectedFingerprint: string,
  ): Promise<LegacyMigrationApply>;
  rollbackLegacyMigration(
    workspaceId: string,
    migrationId: string,
    expectedManifestSha256: string,
  ): Promise<LegacyMigrationRollback>;
  openProjectInObsidian(workspaceId: string): Promise<void>;
  context(workspaceId: string): Promise<WorkspaceContext>;
  search(query: MemoryQuery): Promise<Page<MemorySearchHit>>;
  get(id: string): Promise<MemoryRecord>;
  listDeleted(query: DeletedMemoryQuery): Promise<Page<MemoryRecord>>;
  remember(input: NewMemory): Promise<MemoryRecord>;
  revise(input: MemoryRevision, expectedContentHash?: string): Promise<MemoryRecord>;
  forget(
    id: string,
    expectedVersion: number,
    sourceClient: string,
    sessionId: string | null,
    expectedContentHash?: string,
  ): Promise<Tombstone>;
  restore(
    id: string,
    expectedVersion: number,
    sourceClient: string,
    sessionId: string | null,
    expectedContentHash?: string,
  ): Promise<MemoryRecord>;
  checkpoint(input: NewCheckpoint, expectedStateHash?: string): Promise<Checkpoint>;
  searchCheckpoints(query: CheckpointQuery): Promise<Page<CheckpointSearchHit>>;
  workingStatus(workspaceId: string): Promise<WorkingMemoryStatus | null>;
  activateWorking(
    workspaceId: string,
    mode: WorkingMemoryMode,
    exportExisting: boolean,
  ): Promise<WorkingMemoryStatus>;
  syncWorking(workspaceId: string): Promise<number>;
  observeCommit(workspaceId: string, head: string): Promise<Checkpoint | null>;
  audit(query: AuditQuery): Promise<Page<AuditEntry>>;
  setRetention(
    workspaceId: string,
    settings: RetentionSettings,
    provenance: MutationProvenance,
  ): Promise<MemoryWorkspace>;
  runRetention(
    workspaceId: string,
    now: number,
    batchSize: number,
    provenance: MutationProvenance,
  ): Promise<RetentionReport>;
  drainRetention(
    workspaceId: string,
    provenance: MutationProvenance,
  ): Promise<RetentionReport>;
  exportToDirectory(workspaceId: string, destination: string): Promise<ExportResult>;
  purgeWorkspace(workspaceId: string): Promise<void>;
  recordActivity(input: NewActivity): Promise<ActivityEvent | null>;
  databasePath(): Promise<string>;
  mcpBinaryPath(): Promise<MemoryMcpBinaryPath>;
  mcpHealth(
    workspaceId: string,
    client: "claude" | "codex",
    readOnly: boolean,
  ): Promise<MemoryMcpHealth>;
}

// Native capability flags are injectable so component behavior can be tested
// against an unavailable platform surface without changing the IPC contract.
export type PlatformCapabilities = {
  browser: boolean;
  pickFolder: boolean;
  voice: boolean;
  revealInOs: boolean;
};
