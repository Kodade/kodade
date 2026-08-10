// Real Tauri implementations of the IPC contracts. The only file in the
// frontend that touches @tauri-apps/api or Tauri plugins directly — everything
// else goes through the contract interfaces so it can be mocked in tests.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  CMD,
  EVENT,
  type AgentCancelArgs,
  type AgentEvent,
  type AgentExitEvent,
  type AgentIpc,
  type AgentSendArgs,
  type AgentStartArgs,
  type ConfigEnv,
  type ConfigDirSnapshot,
  type ConfigFileHash,
  type ConfigInstallFile,
  type ConfigIpc,
  type ConfigScan,
  type DirEntry,
  type BrowserBounds,
  type BrowserAgentActivateEvent,
  type BrowserIpc,
  type BrowserNavigatedEvent,
  type FileDropEvent,
  type ExitEvent,
  type FileRead,
  type FilesIpc,
  type ExternalUrlIpc,
  type ForegroundIpc,
  type GhOutput,
  type GithubIpc,
  type GitOutput,
  type GitIpc,
  type FsChangedEvent,
  type KillArgs,
  type LocalDaemonStatus,
  type LocalDownloadArgs,
  type LocalDownloadProgress,
  type LocalDownloadResult,
  type LocalIpc,
  type LocalModelPathInfo,
  type KodSkillsPackBundle,
  type OutputEvent,
  type PlatformIpc,
  type ProviderIpc,
  type ProjectSkillSourceBundle,
  type PtyIpc,
  type ResizeArgs,
  type SpawnArgs,
  type SshDetectResult,
  type SshExecResult,
  type SshIpc,
  type StorageIpc,
  type Unlisten,
  type WriteArgs,
  type VoxDownloadArgs,
  type VoxDownloadProgress,
  type VoxDownloadResult,
  type VoxErrorEvent,
  type VoxEvent,
  type VoxInitArgs,
  type VoxInitResult,
  type VoxIpc,
  type VoxStartArgs,
  type VoxStopResult,
} from "./contract";

export const tauriIpc: PtyIpc = {
  spawn: (args: SpawnArgs) => invoke<void>(CMD.spawn, { ...args }),
  write: (args: WriteArgs) => invoke<void>(CMD.write, { ...args }),
  resize: (args: ResizeArgs) => invoke<void>(CMD.resize, { ...args }),
  kill: (args: KillArgs) => invoke<void>(CMD.kill, { ...args }),

  async onOutput(handler: (e: OutputEvent) => void): Promise<Unlisten> {
    return listen<OutputEvent>(EVENT.output, (evt) => handler(evt.payload));
  },
  async onExit(handler: (e: ExitEvent) => void): Promise<Unlisten> {
    return listen<ExitEvent>(EVENT.exit, (evt) => handler(evt.payload));
  },
};

async function modelsDirectory(override?: string | null): Promise<string> {
  if (override) return override;
  return join(await appDataDir(), "models");
}

export const tauriVox: VoxIpc = {
  init: (args: VoxInitArgs) => invoke<VoxInitResult>(CMD.voxInit, { ...args }),
  async start(args: VoxStartArgs, onEvent: (event: VoxEvent) => void): Promise<string> {
    const channel = new Channel<VoxEvent>();
    channel.onmessage = onEvent;
    // The Channel arg must match the engine's `on_event` parameter (Tauri v2
    // maps snake_case Rust params to camelCase JS keys). Sending it as
    // `channel` would leave the command with no event sink.
    return invoke<string>(CMD.voxStart, { ...args, onEvent: channel });
  },
  stop: () => invoke<VoxStopResult>(CMD.voxStop),
  cancel: () => invoke<void>(CMD.voxCancel),
  teardown: () => invoke<void>(CMD.voxTeardown),
  async downloadModel(
    args: VoxDownloadArgs,
    onProgress: (progress: VoxDownloadProgress) => void,
  ): Promise<VoxDownloadResult> {
    const channel = new Channel<VoxDownloadProgress>();
    channel.onmessage = onProgress;
    // Matches the engine's `on_progress` parameter name (see start() above).
    return invoke<VoxDownloadResult>(CMD.voxDownloadModel, { ...args, onProgress: channel });
  },
  async onError(handler: (event: VoxErrorEvent) => void): Promise<Unlisten> {
    return listen<VoxErrorEvent>(EVENT.voxError, (event) => handler(event.payload));
  },
  async modelPath(fileName: string, modelsDir?: string | null): Promise<string> {
    return join(await modelsDirectory(modelsDir), fileName);
  },
  async deleteModel(path: string, modelsDir?: string | null): Promise<void> {
    // The frozen voice command surface intentionally has no delete command.
    // Reuse the existing path-confined recoverable deletion operation instead.
    return invoke<void>(CMD.trash, { root: await modelsDirectory(modelsDir), path });
  },
  async listInputDevices(): Promise<string[]> {
    return invoke<string[]>(CMD.voxListInputDevices);
  },
};

export const tauriLocal: LocalIpc = {
  status: () => invoke<LocalDaemonStatus>(CMD.localModeldStatus),
  start: (port?: number) => invoke<LocalDaemonStatus>(CMD.localModeldStart, { port }),
  stop: () => invoke<void>(CMD.localModeldStop),
  async downloadModel(
    args: LocalDownloadArgs,
    onProgress: (progress: LocalDownloadProgress) => void,
  ): Promise<LocalDownloadResult> {
    const channel = new Channel<LocalDownloadProgress>();
    channel.onmessage = onProgress;
    return invoke<LocalDownloadResult>(CMD.localDownloadModel, { ...args, onProgress: channel });
  },
  modelPath: (fileName: string) => invoke<string>(CMD.localModelPath, { fileName }),
  validateModel: (path: string) =>
    invoke<LocalModelPathInfo>(CMD.localValidateModel, { path }),
};

export const tauriStorage: StorageIpc = {
  read: () => invoke<string | null>(CMD.storageRead),
  write: (contents: string) => invoke<void>(CMD.storageWrite, { contents }),
  readDoc: (name: string) => invoke<string | null>(CMD.storageReadDoc, { name }),
  writeDoc: (name: string, contents: string) =>
    invoke<void>(CMD.storageWriteDoc, { name, contents }),
  deleteDoc: (name: string) => invoke<void>(CMD.storageDeleteDoc, { name }),
};

// KödChat headless runs. `start` hands Rust an already-built argv; every line
// that comes back is parsed by the provider's stream adapter, never here.
export const tauriAgent: AgentIpc = {
  start: (args: AgentStartArgs) => invoke<void>(CMD.agentStart, { ...args }),
  send: (args: AgentSendArgs) => invoke<void>(CMD.agentSend, { ...args }),
  cancel: (args: AgentCancelArgs) => invoke<void>(CMD.agentCancel, { ...args }),
  async onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> {
    return listen<AgentEvent>(EVENT.agentEvent, (evt) => handler(evt.payload));
  },
  async onExit(handler: (e: AgentExitEvent) => void): Promise<Unlisten> {
    return listen<AgentExitEvent>(EVENT.agentExit, (evt) => handler(evt.payload));
  },
};

export const tauriPlatform: PlatformIpc = {
  // Native folder picker; null when the user cancels.
  async pickFolder(): Promise<string | null> {
    const picked = await openDialog({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  pickProjectSkill: () =>
    invoke<ProjectSkillSourceBundle | null>(CMD.projectSkillPick),
  // Webview drag-and-drop; only "drop" events carry both paths and position.
  async onFileDrop(handler: (drop: FileDropEvent) => void): Promise<Unlisten> {
    return getCurrentWebview().onDragDropEvent((evt) => {
      if (evt.payload.type === "drop") {
        handler({
          paths: evt.payload.paths,
          position: { x: evt.payload.position.x, y: evt.payload.position.y },
        });
      }
    });
  },
  isDir: (path: string) => invoke<boolean>(CMD.isDir, { path }),
  canonicalize: (path: string) => invoke<string>(CMD.canonicalize, { path }),
  shellName: () => invoke<string>(CMD.shellName),
};

export const tauriProvider: ProviderIpc = {
  detect: (bin: string) => invoke<string | null>(CMD.detectProvider, { bin }),
};

export const tauriForeground: ForegroundIpc = {
  foreground: (id: string) => invoke<string | null>(CMD.ptyForeground, { id }),
};

export const tauriFiles: FilesIpc = {
  listDir: (path: string) => invoke<DirEntry[]>(CMD.listDir, { path }),
  readFile: (path: string) => invoke<FileRead>(CMD.readFile, { path }),
  writeFile: (path: string, contents: string) =>
    invoke<void>(CMD.writeFile, { path, contents }),
  watch: (root: string, generation: number) => invoke<void>(CMD.watch, { root, generation }),
  unwatch: (generation: number) => invoke<void>(CMD.unwatch, { generation }),
  async onChanged(handler: (e: FsChangedEvent) => void): Promise<Unlisten> {
    return listen<FsChangedEvent>(EVENT.fsChanged, (evt) => handler(evt.payload));
  },
  // File-manager mutations (v1.1). Rust confines each to `root`.
  createFile: (root: string, path: string) =>
    invoke<void>(CMD.createFile, { root, path }),
  createDir: (root: string, path: string) =>
    invoke<void>(CMD.createDir, { root, path }),
  rename: (root: string, from: string, to: string) =>
    invoke<void>(CMD.rename, { root, from, to }),
  trash: (root: string, path: string) => invoke<void>(CMD.trash, { root, path }),
  reveal: (root: string, path: string) => invoke<void>(CMD.reveal, { root, path }),
};

export const tauriConfig: ConfigIpc = {
  // Both carry the active projectRoot so Rust's configguard can add it to the
  // per-call allowlist alongside the known home-based config roots.
  scan: (root: string, projectRoot: string) =>
    invoke<ConfigScan>(CMD.configScan, { root, projectRoot }),
  read: (path: string, projectRoot: string) =>
    invoke<FileRead>(CMD.configRead, { path, projectRoot }),
  env: () => invoke<ConfigEnv>(CMD.configEnv),
  // Guarded write surface (M10d). Rust authorizes each under configguard.
  rename: (path: string, newPath: string, projectRoot: string) =>
    invoke<void>(CMD.configRename, { path, newPath, projectRoot }),
  write: (path: string, contents: string, expectedHash: string, projectRoot: string) =>
    invoke<string>(CMD.configWrite, { path, contents, expectedHash, projectRoot }),
  removeFile: (path: string, expectedHash: string, projectRoot: string) =>
    invoke<void>(CMD.configRemoveFile, { path, expectedHash, projectRoot }),
  backup: (path: string, projectRoot: string) =>
    invoke<string>(CMD.configBackup, { path, projectRoot }),
  restore: (path: string, backupPath: string, projectRoot: string) =>
    invoke<void>(CMD.configRestore, { path, backupPath, projectRoot }),
  kodSkillsPackRead: () => invoke<KodSkillsPackBundle>(CMD.kodSkillsPackRead),
  dirSnapshot: (path: string, projectRoot: string) =>
    invoke<ConfigDirSnapshot>(CMD.configDirSnapshot, { path, projectRoot }),
  externalSkillSnapshot: (path: string, projectRoot: string) =>
    invoke<ConfigFileHash[]>(CMD.configExternalSkillSnapshot, { path, projectRoot }),
  installDir: (
    path: string,
    files: ConfigInstallFile[],
    expectedFiles: ConfigFileHash[] | null,
    projectRoot: string,
  ) => invoke<string>(CMD.configInstallDir, { path, files, expectedFiles, projectRoot }),
  removeDir: (
    path: string,
    expectedFiles: ConfigFileHash[],
    projectRoot: string,
    keepBackup: boolean,
  ) => invoke<string>(CMD.configRemoveDir, { path, expectedFiles, projectRoot, keepBackup }),
  restoreDir: (
    path: string,
    backupPath: string,
    expectedFiles: ConfigFileHash[] | null,
    projectRoot: string,
  ) => invoke<void>(CMD.configRestoreDir, { path, backupPath, expectedFiles, projectRoot }),
};

export const tauriSsh: SshIpc = {
  detect: () => invoke<SshDetectResult>(CMD.sshDetect),
  readConfig: (path?: string) => invoke<string | null>(CMD.sshConfigRead, { path }),
  listDir: (path?: string) => invoke<string[] | null>(CMD.sshListDir, { path }),
  // Tauri maps the JS `timeoutMs` key to Rust's `timeout_ms` arg.
  exec: (host: string, argv: string[], timeoutMs: number) =>
    invoke<SshExecResult>(CMD.sshExec, { host, argv, timeoutMs }),
};

export const tauriExternalUrls: ExternalUrlIpc = {
  openUrl: (url: string) => invoke<void>(CMD.openUrl, { url }),
  openMicrophonePrivacySettings: () =>
    invoke<void>(CMD.openMicrophonePrivacySettings),
};

export const tauriGithub: GithubIpc = {
  run: (projectRoot: string, args: string[]) =>
    invoke<GhOutput>(CMD.runGh, { projectRoot, args }),
};

export const tauriGit: GitIpc = {
  run: (projectRoot: string, args: string[]) =>
    invoke<GitOutput>(CMD.runGit, { projectRoot, args }),
};

export const tauriBrowser: BrowserIpc = {
  create: (id: string, url: string, bounds: BrowserBounds) =>
    invoke<void>(CMD.browserCreate, { id, url, bounds }),
  navigate: (id: string, url: string) =>
    invoke<void>(CMD.browserNavigate, { id, url }),
  back: (id: string) => invoke<void>(CMD.browserBack, { id }),
  forward: (id: string) => invoke<void>(CMD.browserForward, { id }),
  reload: (id: string) => invoke<void>(CMD.browserReload, { id }),
  setBounds: (id: string, bounds: BrowserBounds) =>
    invoke<void>(CMD.browserSetBounds, { id, bounds }),
  show: (id: string) => invoke<void>(CMD.browserShow, { id }),
  hide: (id: string) => invoke<void>(CMD.browserHide, { id }),
  destroy: (id: string) => invoke<void>(CMD.browserDestroy, { id }),
  agentReady: (projectRoot: string | null) =>
    invoke<void>(CMD.browserAgentReady, { projectRoot }),
  async onNavigated(handler: (event: BrowserNavigatedEvent) => void): Promise<Unlisten> {
    return listen<BrowserNavigatedEvent>(EVENT.browserNavigated, (evt) => handler(evt.payload));
  },
  async onAgentActivate(handler: (event: BrowserAgentActivateEvent) => void): Promise<Unlisten> {
    return listen<BrowserAgentActivateEvent>(EVENT.browserAgentActivate, (evt) =>
      handler(evt.payload),
    );
  },
};
