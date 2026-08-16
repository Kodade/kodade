// In-memory mock of the PtyIpc contract for tests. Records calls and lets a
// test script output/exit events back to whatever subscribed via onOutput/onExit.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  type ConfigEnv,
  type ConfigIpc,
  type ConfigDirSnapshot,
  type ConfigFileHash,
  type ConfigInstallFile,
  type ConfigScan,
  type KodSkillsPackBundle,
  type KodworkIpc,
  type KodworkNativeReview,
  type ProjectSkillSourceBundle,
  type DirEntry,
  type FileDropEvent,
  type ExitEvent,
  type FileRead,
  type FilesIpc,
  type ForegroundIpc,
  type FsChangedEvent,
  type GitIpc,
  type GitOutput,
  type KillArgs,
  type LocalDaemonStatus,
  type LocalDownloadArgs,
  type AgentCancelArgs,
  type AgentEvent,
  type AgentExitEvent,
  type AgentIpc,
  type AgentLiveRun,
  type AgentSendArgs,
  type AgentStartArgs,
  type LocalDownloadProgress,
  type LocalDownloadResult,
  type LocalIpc,
  type LocalModelPathInfo,
  type OutputEvent,
  type PlatformIpc,
  type ProviderIpc,
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
import { nativeBasename, nativeDirname } from "../platform/native-path";

export class MockLocalIpc implements LocalIpc {
  statusValue: LocalDaemonStatus = {
    running: false,
    managed: false,
    port: 4470,
    binaryPath: "/tmp/kodade-modeld",
    cliPath: "/tmp/kodade-local.mjs",
    message: null,
  };
  downloads: LocalDownloadArgs[] = [];
  validated = new Map<string, LocalModelPathInfo>();
  starts = 0;
  stops = 0;

  status(): Promise<LocalDaemonStatus> {
    return Promise.resolve({ ...this.statusValue });
  }
  start(_port?: number): Promise<LocalDaemonStatus> {
    this.starts++;
    this.statusValue.running = true;
    this.statusValue.managed = true;
    return this.status();
  }
  stop(): Promise<void> {
    this.stops++;
    this.statusValue.running = false;
    this.statusValue.managed = false;
    return Promise.resolve();
  }
  downloadModel(
    args: LocalDownloadArgs,
    onProgress: (progress: LocalDownloadProgress) => void,
  ): Promise<LocalDownloadResult> {
    this.downloads.push(args);
    onProgress({ downloaded: 1, total: 1 });
    return Promise.resolve({ path: `/models/local/${args.fileName}`, sha256: args.expectedSha256, bytes: 1 });
  }
  validateModel(path: string): Promise<LocalModelPathInfo> {
    const value = this.validated.get(path);
    return value ? Promise.resolve(value) : Promise.reject(new Error("model file was not found"));
  }
  modelPath(fileName: string): Promise<string> {
    return Promise.resolve(`/models/local/${fileName}`);
  }
}

export class MockPtyIpc implements PtyIpc {
  // Recorded calls, so tests can assert what the frontend sent.
  spawns: SpawnArgs[] = [];
  writes: WriteArgs[] = [];
  resizes: ResizeArgs[] = [];
  kills: KillArgs[] = [];

  // When true, spawn() stays pending until resolveSpawn() — lets tests race
  // dispose/exit against an in-flight spawn.
  deferSpawn = false;
  // When set, spawn() rejects with this error (missing cwd, duplicate id...).
  failSpawnWith: unknown = null;

  // Every output event emitted, in order — lets MockWebIpc replay "what the PTY
  // produced" per session (mirrors the server's ring buffer).
  emitted: OutputEvent[] = [];

  private outputHandlers = new Set<(e: OutputEvent) => void>();
  private exitHandlers = new Set<(e: ExitEvent) => void>();
  private spawnResolvers: (() => void)[] = [];

  spawn(args: SpawnArgs): Promise<void> {
    this.spawns.push(args);
    if (this.failSpawnWith !== null) return Promise.reject(this.failSpawnWith);
    if (!this.deferSpawn) return Promise.resolve();
    return new Promise((resolve) => this.spawnResolvers.push(resolve));
  }
  write(args: WriteArgs): Promise<void> {
    this.writes.push(args);
    return Promise.resolve();
  }
  resize(args: ResizeArgs): Promise<void> {
    this.resizes.push(args);
    return Promise.resolve();
  }
  kill(args: KillArgs): Promise<void> {
    this.kills.push(args);
    return Promise.resolve();
  }

  async onOutput(handler: (e: OutputEvent) => void): Promise<Unlisten> {
    this.outputHandlers.add(handler);
    return () => this.outputHandlers.delete(handler);
  }
  async onExit(handler: (e: ExitEvent) => void): Promise<Unlisten> {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  // --- Test drivers: push events as if Rust emitted them ---
  emitOutput(e: OutputEvent) {
    this.emitted.push(e);
    for (const h of this.outputHandlers) h(e);
  }
  emitExit(e: ExitEvent) {
    for (const h of this.exitHandlers) h(e);
  }
  // Release the oldest pending deferred spawn.
  resolveSpawn() {
    this.spawnResolvers.shift()?.();
  }
}

// Scriptable native voice adapter. Capture/download events are delivered
// synchronously to keep feature tests deterministic and free of Tauri itself.
export class MockVoxIpc implements VoxIpc {
  inits: VoxInitArgs[] = [];
  starts: VoxStartArgs[] = [];
  stops = 0;
  cancels = 0;
  teardowns = 0;
  downloads: VoxDownloadArgs[] = [];
  deletedModels: string[] = [];
  modelPaths = new Map<string, string>();
  nextInit: VoxInitResult = { device: "Built-in Microphone", backend: "cpu", modelPath: "" };
  nextUtteranceId = "utterance-1";
  nextStop: VoxStopResult = { utteranceId: "utterance-1", text: "", durationMs: 1000 };
  nextDownload: VoxDownloadResult = { sha256: "", bytes: 0 };
  downloadProgress: VoxDownloadProgress[] = [];
  failInitWith: unknown = null;
  failStartWith: unknown = null;
  failStopWith: unknown = null;
  failDownloadWith: unknown = null;
  failCancelWith: unknown = null;
  failTeardownWith: unknown = null;
  failDeleteModelWith: unknown = null;
  failListInputDevicesWith: unknown = null;
  deferInit = false;
  deferStart = false;
  deferDownload = false;
  autoCaptureState = true;
  operations: string[] = [];
  modelPathCalls: { fileName: string; modelsDir?: string | null }[] = [];
  deleteModelCalls: { path: string; modelsDir?: string | null }[] = [];
  inputDevices: string[] = ["Built-in Microphone", "USB headset"];

  private captureHandlers: ((event: VoxEvent) => void)[] = [];
  private errorHandlers = new Set<(event: VoxErrorEvent) => void>();
  private initResolvers: (() => void)[] = [];
  private startResolvers: (() => void)[] = [];
  private downloadResolvers: (() => void)[] = [];

  init(args: VoxInitArgs): Promise<VoxInitResult> {
    this.inits.push(args);
    this.operations.push("init");
    if (this.failInitWith !== null) return Promise.reject(this.failInitWith);
    if (this.deferInit) {
      return new Promise((resolve) =>
        this.initResolvers.push(() => resolve({ ...this.nextInit, modelPath: args.modelPath })),
      );
    }
    return Promise.resolve({ ...this.nextInit, modelPath: args.modelPath });
  }
  start(args: VoxStartArgs, onEvent: (event: VoxEvent) => void): Promise<string> {
    this.starts.push(args);
    this.operations.push("start");
    this.captureHandlers.push(onEvent);
    if (this.failStartWith !== null) return Promise.reject(this.failStartWith);
    if (this.autoCaptureState) onEvent({ type: "state", state: "capturing" });
    if (this.deferStart) {
      return new Promise((resolve) => this.startResolvers.push(() => resolve(this.nextUtteranceId)));
    }
    return Promise.resolve(this.nextUtteranceId);
  }
  stop(): Promise<VoxStopResult> {
    this.stops++;
    this.operations.push("stop");
    if (this.failStopWith !== null) return Promise.reject(this.failStopWith);
    return Promise.resolve(this.nextStop);
  }
  cancel(): Promise<void> {
    this.cancels++;
    this.operations.push("cancel");
    if (this.failCancelWith !== null) return Promise.reject(this.failCancelWith);
    return Promise.resolve();
  }
  teardown(): Promise<void> {
    this.teardowns++;
    this.operations.push("teardown");
    if (this.failTeardownWith !== null) return Promise.reject(this.failTeardownWith);
    return Promise.resolve();
  }
  downloadModel(
    args: VoxDownloadArgs,
    onProgress: (progress: VoxDownloadProgress) => void,
  ): Promise<VoxDownloadResult> {
    this.downloads.push(args);
    this.operations.push("download");
    for (const progress of this.downloadProgress) onProgress(progress);
    if (this.failDownloadWith !== null) return Promise.reject(this.failDownloadWith);
    if (this.deferDownload) {
      return new Promise((resolve) => this.downloadResolvers.push(() => resolve(this.nextDownload)));
    }
    return Promise.resolve(this.nextDownload);
  }
  onError(handler: (event: VoxErrorEvent) => void): Promise<Unlisten> {
    this.errorHandlers.add(handler);
    return Promise.resolve(() => this.errorHandlers.delete(handler));
  }
  modelPath(fileName: string, modelsDir?: string | null): Promise<string> {
    this.modelPathCalls.push({ fileName, modelsDir });
    const root = modelsDir ?? "/app/models";
    return Promise.resolve(this.modelPaths.get(fileName) ?? `${root}/${fileName}`);
  }
  deleteModel(path: string, modelsDir?: string | null): Promise<void> {
    this.deletedModels.push(path);
    this.deleteModelCalls.push({ path, modelsDir });
    this.operations.push("delete-model");
    if (this.failDeleteModelWith !== null) return Promise.reject(this.failDeleteModelWith);
    return Promise.resolve();
  }
  listInputDevices(): Promise<string[]> {
    if (this.failListInputDevicesWith !== null) return Promise.reject(this.failListInputDevicesWith);
    return Promise.resolve(this.inputDevices);
  }

  emitCapture(event: VoxEvent) {
    this.captureHandlers.at(-1)?.(event);
  }
  emitCaptureForStart(index: number, event: VoxEvent) {
    this.captureHandlers[index]?.(event);
  }
  emitError(message: string) {
    for (const handler of this.errorHandlers) handler({ message });
  }
  resolveInit() {
    this.initResolvers.shift()?.();
  }
  resolveStart() {
    this.startResolvers.shift()?.();
  }
  resolveDownload() {
    this.downloadResolvers.shift()?.();
  }
}

// In-memory mock of the StorageIpc contract: one main string document plus the
// named side documents KödChat transcripts use.
export class MockStorage implements StorageIpc {
  doc: string | null = null;
  writes = 0; // how many times write() was called, for persistence assertions
  // Named side documents by name ("chats/<threadId>.json"), and a per-name
  // write count so transcript-persistence tests can assert debouncing.
  docs = new Map<string, string>();
  docWrites = 0;

  // When true, read() stays pending until resolveRead() — lets tests race
  // mutations against an in-flight hydration.
  deferRead = false;
  private readResolvers: ((doc: string | null) => void)[] = [];

  read(): Promise<string | null> {
    if (!this.deferRead) return Promise.resolve(this.doc);
    return new Promise((resolve) => this.readResolvers.push(resolve));
  }
  write(contents: string): Promise<void> {
    this.doc = contents;
    this.writes++;
    return Promise.resolve();
  }
  readDoc(name: string): Promise<string | null> {
    return Promise.resolve(this.docs.get(name) ?? null);
  }
  writeDoc(name: string, contents: string): Promise<void> {
    this.docs.set(name, contents);
    this.docWrites++;
    return Promise.resolve();
  }
  deleteDoc(name: string): Promise<void> {
    this.docs.delete(name);
    return Promise.resolve();
  }
  // Release the oldest pending deferred read with the current doc.
  resolveRead() {
    this.readResolvers.shift()?.(this.doc);
  }
}

// In-memory mock of the AgentIpc contract. Tests script a run's stdout by
// calling emit()/exit(); nothing here parses a dialect, exactly like Rust.
export class MockAgentIpc implements AgentIpc {
  starts: AgentStartArgs[] = [];
  sends: AgentSendArgs[] = [];
  ends: AgentCancelArgs[] = [];
  cancels: AgentCancelArgs[] = [];
  // When set, start() rejects with this error (CLI missing, duplicate id...).
  failStartWith: unknown = null;
  liveRunIds: string[] = [];

  private eventHandlers = new Set<(e: AgentEvent) => void>();
  private exitHandlers = new Set<(e: AgentExitEvent) => void>();

  start(args: AgentStartArgs): Promise<void> {
    this.starts.push(args);
    if (this.failStartWith !== null) return Promise.reject(this.failStartWith);
    return Promise.resolve();
  }
  send(args: AgentSendArgs): Promise<void> {
    this.sends.push(args);
    return Promise.resolve();
  }
  end(args: AgentCancelArgs): Promise<void> {
    this.ends.push(args);
    return Promise.resolve();
  }
  cancel(args: AgentCancelArgs): Promise<void> {
    this.cancels.push(args);
    return Promise.resolve();
  }
  listLive(): Promise<AgentLiveRun[]> {
    return Promise.resolve(this.liveRunIds.map((id) => ({ id })));
  }
  async onEvent(handler: (e: AgentEvent) => void): Promise<Unlisten> {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }
  async onExit(handler: (e: AgentExitEvent) => void): Promise<Unlisten> {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  // Deliver one raw stdout line for a run, as Rust would.
  emit(id: string, line: string): void {
    for (const handler of this.eventHandlers) handler({ id, line });
  }
  // Deliver several lines in order (a fixture NDJSON stream).
  emitLines(id: string, lines: readonly string[]): void {
    for (const line of lines) this.emit(id, line);
  }
  exit(id: string, code: number | null = 0, stderr = ""): void {
    for (const handler of this.exitHandlers) handler({ id, code, stderr });
  }
}

export class MockKodworkIpc implements KodworkIpc {
  begins: { taskId: string; root: string }[] = [];
  finishes: string[] = [];
  accepts: string[] = [];
  restores: string[] = [];
  reviews = new Map<string, KodworkNativeReview>();
  restoreError: string | null = null;

  begin(taskId: string, root: string): Promise<void> {
    this.begins.push({ taskId, root });
    return Promise.resolve();
  }
  finish(taskId: string): Promise<KodworkNativeReview> {
    this.finishes.push(taskId);
    return Promise.resolve(
      this.reviews.get(taskId) ?? {
        kind: "folder",
        files: [],
        fingerprint: "empty",
      },
    );
  }
  accept(taskId: string): Promise<void> {
    this.accepts.push(taskId);
    return Promise.resolve();
  }
  restore(taskId: string): Promise<void> {
    this.restores.push(taskId);
    return this.restoreError
      ? Promise.reject(new Error(this.restoreError))
      : Promise.resolve();
  }
}

// Mock of the PlatformIpc contract: scriptable picker/drop/isDir answers.
export class MockPlatform implements PlatformIpc {
  nextPickedFolder: string | null = null;
  nextProjectSkill: ProjectSkillSourceBundle | null = null;
  dirs = new Set<string>(); // paths isDir() answers true for
  shell = "zsh";

  private dropHandlers = new Set<(drop: FileDropEvent) => void>();

  pickFolder(): Promise<string | null> {
    return Promise.resolve(this.nextPickedFolder);
  }
  pickProjectSkill(): Promise<ProjectSkillSourceBundle | null> {
    return Promise.resolve(this.nextProjectSkill);
  }
  async onFileDrop(handler: (drop: FileDropEvent) => void): Promise<Unlisten> {
    this.dropHandlers.add(handler);
    return () => this.dropHandlers.delete(handler);
  }
  isDir(path: string): Promise<boolean> {
    return Promise.resolve(this.dirs.has(path));
  }
  // Scriptable canonical paths (e.g. "/tmp/x" → "/private/tmp/x"); identity
  // for anything not in the map, matching the Rust fallback.
  canonicalMap = new Map<string, string>();
  canonicalize(path: string): Promise<string> {
    return Promise.resolve(this.canonicalMap.get(path) ?? path);
  }
  shellName(): Promise<string> {
    return Promise.resolve(this.shell);
  }

  // Test driver: simulate a drag-and-drop of paths onto the window.
  emitDrop(paths: string[], position = { x: 0, y: 0 }) {
    for (const h of this.dropHandlers) h({ paths, position });
  }
}

// Mock of the ProviderIpc contract: a scriptable bin → version-string map.
// A bin absent from `versions` (or mapped to null) reads as "not installed".
export class MockProvider implements ProviderIpc {
  versions = new Map<string, string | null>();
  detected: string[] = []; // bins queried, for refresh/ordering assertions

  detect(bin: string): Promise<string | null> {
    this.detected.push(bin);
    return Promise.resolve(this.versions.get(bin) ?? null);
  }
}

// Mock of the ForegroundIpc contract: a scriptable session id → foreground name
// map. Absent ids read as null (unknown/exited). Records queries so poller tests
// can assert which sessions were polled (and, crucially, which were NOT).
export class MockForeground implements ForegroundIpc {
  names = new Map<string, string | null>();
  queries: string[] = [];

  foreground(id: string): Promise<string | null> {
    this.queries.push(id);
    return Promise.resolve(this.names.get(id) ?? null);
  }
}

// In-memory mock of the FilesIpc contract: a scriptable directory tree and
// file contents, plus watch/unwatch recording and a change-event driver.
export class MockFiles implements FilesIpc {
  // dir path -> its immediate children (what listDir returns).
  tree = new Map<string, DirEntry[]>();
  // file path -> what readFile returns.
  fileReads = new Map<string, FileRead>();

  // Recorded lifecycle, so tests can assert the watcher followed project switches.
  watchCalls: string[] = [];
  unwatchCalls = 0;
  currentRoot: string | null = null;
  private currentGeneration = 0;

  // Recorded readFile paths, so tests can assert a directory click never reads.
  reads: string[] = [];
  // Recorded writes (path, contents), so save tests can assert what hit disk.
  writes: { path: string; contents: string }[] = [];
  // When set, writeFile() rejects with this error (read-only file, missing dir).
  failWriteWith: string | null = null;
  // Paths readFile() should reject for (simulates a delete under the editor).
  readFailPaths = new Set<string>();
  // When set, writeFile() stays pending until resolveWrite() — lets tests land
  // an external change while a save is in flight (status === "saving").
  deferWrite = false;
  private writeResolvers: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  // When true, readFile() stays pending until resolveRead() — lets tests pause a
  // restore/reconcile mid-read to race a project switch or live tab activity.
  deferRead = false;
  private readResolvers: (() => void)[] = [];

  private changedHandlers = new Set<(e: FsChangedEvent) => void>();

  listDir(path: string): Promise<DirEntry[]> {
    return Promise.resolve(this.tree.get(path) ?? []);
  }
  readFile(path: string): Promise<FileRead> {
    this.reads.push(path);
    if (this.readFailPaths.has(path)) {
      return Promise.reject(new Error(`stat ${path}: no such file`));
    }
    const result = this.fileReads.get(path) ?? { kind: "text", content: "" };
    if (!this.deferRead) return Promise.resolve(result);
    return new Promise((resolve) => this.readResolvers.push(() => resolve(result)));
  }
  // Release the oldest pending deferred read with its captured result.
  resolveRead() {
    this.readResolvers.shift()?.();
  }
  // Mimics the atomic Rust write: on success, the new contents become what a
  // later readFile returns (so external-change/reload tests see fresh disk). On
  // a scripted failure the "disk" is left untouched — never truncated.
  writeFile(path: string, contents: string): Promise<void> {
    // An immediate (non-deferred) scripted failure rejects before touching disk.
    if (this.failWriteWith !== null && !this.deferWrite) {
      return Promise.reject(new Error(this.failWriteWith));
    }
    if (!this.deferWrite) {
      this.writes.push({ path, contents });
      this.fileReads.set(path, { kind: "text", content: contents });
      return Promise.resolve();
    }
    // Deferred: hold until resolveWrite()/rejectWrite(). Only record the write to
    // disk when it actually succeeds (resolveWrite), so a rejected in-flight
    // write never truncates — matching the atomic Rust write.
    return new Promise((resolve, reject) => {
      this.writeResolvers.push({
        resolve: () => {
          this.writes.push({ path, contents });
          this.fileReads.set(path, { kind: "text", content: contents });
          resolve();
        },
        reject,
      });
    });
  }
  // Release the oldest pending deferred write (it commits to disk).
  resolveWrite() {
    this.writeResolvers.shift()?.resolve();
  }
  // Fail the oldest pending deferred write (nothing hits disk).
  rejectWrite(message = "write failed") {
    this.writeResolvers.shift()?.reject(new Error(message));
  }
  watch(root: string, generation: number): Promise<void> {
    this.watchCalls.push(root);
    if (generation >= this.currentGeneration) {
      this.currentGeneration = generation;
      this.currentRoot = root;
    }
    return Promise.resolve();
  }
  unwatch(generation: number): Promise<void> {
    this.unwatchCalls++;
    if (generation >= this.currentGeneration) {
      this.currentGeneration = generation;
      this.currentRoot = null;
    }
    return Promise.resolve();
  }
  async onChanged(handler: (e: FsChangedEvent) => void): Promise<Unlisten> {
    this.changedHandlers.add(handler);
    return () => this.changedHandlers.delete(handler);
  }

  // Test driver: emit a filesystem-change batch as if Rust's watcher fired.
  emitChanged(paths: string[]) {
    for (const h of this.changedHandlers) h({ paths });
  }

  // --- File-manager mutations (v1.1) ---
  // Recorded op calls so store tests can assert what hit the IPC seam, plus a
  // scriptable failure per op. Each success mutates the in-memory `tree` so a
  // follow-up relist (the store's optimistic/watcher refresh) sees the change.

  createFileCalls: { root: string; path: string }[] = [];
  createDirCalls: { root: string; path: string }[] = [];
  renameCalls: { root: string; from: string; to: string }[] = [];
  trashCalls: { root: string; path: string }[] = [];
  revealCalls: { root: string; path: string }[] = [];
  // When set, the matching op rejects with this error (collision, escape, etc.).
  failCreateFileWith: string | null = null;
  failCreateDirWith: string | null = null;
  failRenameWith: string | null = null;
  failTrashWith: string | null = null;
  failRevealWith: string | null = null;
  // When true, rename()/trash() stay pending until resolveRename()/resolveTrash()
  // — lets tests land a watcher-driven reconcile while the op is in flight.
  deferRename = false;
  deferTrash = false;
  private renameResolvers: (() => void)[] = [];
  private trashResolvers: (() => void)[] = [];

  // Add an entry to a parent dir's listing (kept sorted dirs-first then name,
  // matching Rust's list_dir order) so a relist reflects a create/rename.
  private addEntry(entry: DirEntry) {
    const parent = parentOf(entry.path);
    const list = this.tree.get(parent) ?? [];
    const next = list.filter((e) => e.path !== entry.path);
    next.push(entry);
    next.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    this.tree.set(parent, next);
  }
  // Remove an entry (and, for a dir, its subtree listings) from the mock fs.
  // A removed file also starts rejecting readFile (as a real deleted file would),
  // so the store's deleted-on-disk reconciliation fires in tests.
  private removeEntry(path: string) {
    const parent = parentOf(path);
    const list = this.tree.get(parent);
    if (list) this.tree.set(parent, list.filter((e) => e.path !== path));
    this.tree.delete(path);
    this.fileReads.delete(path);
    this.readFailPaths.add(path);
  }

  createFile(root: string, path: string): Promise<void> {
    this.createFileCalls.push({ root, path });
    if (this.failCreateFileWith !== null)
      return Promise.reject(new Error(this.failCreateFileWith));
    this.addEntry({ name: baseName(path), path, isDir: false });
    this.fileReads.set(path, { kind: "text", content: "" });
    return Promise.resolve();
  }
  createDir(root: string, path: string): Promise<void> {
    this.createDirCalls.push({ root, path });
    if (this.failCreateDirWith !== null)
      return Promise.reject(new Error(this.failCreateDirWith));
    this.addEntry({ name: baseName(path), path, isDir: true });
    if (!this.tree.has(path)) this.tree.set(path, []);
    return Promise.resolve();
  }
  rename(root: string, from: string, to: string): Promise<void> {
    this.renameCalls.push({ root, from, to });
    if (this.failRenameWith !== null)
      return Promise.reject(new Error(this.failRenameWith));
    // Carry the entry's kind and any file content across the rename.
    const wasDir = (this.tree.get(parentOf(from)) ?? []).find((e) => e.path === from)?.isDir
      ?? this.tree.has(from);
    const content = this.fileReads.get(from);
    this.removeEntry(from);
    this.addEntry({ name: baseName(to), path: to, isDir: !!wasDir });
    if (content) this.fileReads.set(to, content);
    if (wasDir) this.tree.set(to, this.tree.get(to) ?? []);
    if (!this.deferRename) return Promise.resolve();
    return new Promise((resolve) => this.renameResolvers.push(resolve));
  }
  // Release the oldest pending deferred rename.
  resolveRename() {
    this.renameResolvers.shift()?.();
  }
  trash(root: string, path: string): Promise<void> {
    this.trashCalls.push({ root, path });
    if (this.failTrashWith !== null) return Promise.reject(new Error(this.failTrashWith));
    this.removeEntry(path);
    if (!this.deferTrash) return Promise.resolve();
    return new Promise((resolve) => this.trashResolvers.push(resolve));
  }
  // Release the oldest pending deferred trash.
  resolveTrash() {
    this.trashResolvers.shift()?.();
  }
  reveal(root: string, path: string): Promise<void> {
    this.revealCalls.push({ root, path });
    if (this.failRevealWith !== null) return Promise.reject(new Error(this.failRevealWith));
    return Promise.resolve();
  }
}

// In-memory mock of the GitIpc contract: scriptable per-command output keyed by
// the leading argv tokens (e.g. "status", "diff --numstat"), records every call
// so the M12 review store can assert exactly which git shapes it ran, and injects
// a failure per key to exercise the store's error paths. A key absent from
// `responses` (with no scripted failure) returns empty stdout, standing in for a
// clean/empty repo state. Mirrors Rust's GitOutput shape; no parsing happens here.
export class MockGit implements GitIpc {
  // argv-prefix -> the GitOutput (or Error) the guarded run_git would return.
  responses = new Map<string, GitOutput | Error>();
  // Recorded argv of every run(), for "which git shapes were run" assertions.
  calls: string[][] = [];

  // Longest-prefix match so a caller can key on "diff --numstat" or a bare
  // "diff" without listing every trailing range/path variant.
  private lookup(args: string[]): GitOutput | Error | undefined {
    for (let take = args.length; take >= 1; take--) {
      const hit = this.responses.get(args.slice(0, take).join(" "));
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  run(_projectRoot: string, args: string[]): Promise<GitOutput> {
    this.calls.push(args);
    const response = this.lookup(args);
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response ?? { stdout: "", stderr: "" });
  }
}

// In-memory mock of the ConfigIpc contract: scriptable per-path scan results
// and file reads, so harness scan/adapter tests replay fixtures without Tauri.
// A path absent from `scans` reads as "missing" (a normal, no-artifacts state);
// a path absent from `reads` (with no scripted failure) rejects like a missing
// file. Records queries so tests can assert exactly which locations were probed.
export class MockConfig implements ConfigIpc {
  // root path -> the scan result the guarded config_scan would return.
  scans = new Map<string, ConfigScan>();
  // file path -> the FileRead the guarded config_read would return.
  reads = new Map<string, FileRead>();
  // Paths read() should reject for (guard rejection / genuine read failure).
  readFailPaths = new Set<string>();

  // Recorded queries, for "which locations were scanned/read" assertions.
  scanQueries: { root: string; projectRoot: string }[] = [];
  readQueries: { path: string; projectRoot: string }[] = [];
  envQueries = 0;

  // --- Write surface (M10d) ---
  // Recorded mutating calls plus per-op failure injection, and an in-memory
  // apply so a rescan after a rename reflects the change (drives verify).
  renameCalls: { path: string; newPath: string; projectRoot: string }[] = [];
  writeCalls: { path: string; contents: string; expectedHash: string; projectRoot: string }[] = [];
  removeFileCalls: { path: string; expectedHash: string; projectRoot: string }[] = [];
  backupCalls: { path: string; projectRoot: string }[] = [];
  restoreCalls: { path: string; backupPath: string; projectRoot: string }[] = [];
  failRenameWith: string | null = null;
  failConfigWriteWith: string | null = null;
  failBackupWith: string | null = null;
  failRestoreWith: string | null = null;
  kodSkillsBundle: KodSkillsPackBundle | null = null;
  dirSnapshots = new Map<string, ConfigDirSnapshot>();
  externalSkillSnapshots = new Map<string, ConfigFileHash[]>();
  installDirCalls: {
    path: string;
    files: ConfigInstallFile[];
    expectedFiles: ConfigFileHash[] | null;
    projectRoot: string;
  }[] = [];
  removeDirCalls: {
    path: string;
    expectedFiles: ConfigFileHash[];
    projectRoot: string;
    keepBackup: boolean;
  }[] = [];
  restoreDirCalls: {
    path: string;
    backupPath: string;
    expectedFiles: ConfigFileHash[] | null;
    projectRoot: string;
  }[] = [];
  // When true, rename() applies the mutation but stays pending until
  // resolveRename() — lets a store test race a rescan against an in-flight apply.
  deferConfigRename = false;
  private configRenameResolvers: (() => void)[] = [];

  // The env() result a test scripts (M10c global scope). Defaults to a mac
  // fixture home so a test that never touches this still gets a plausible,
  // realistic ScanContext rather than a blank one.
  envResult: ConfigEnv = {
    home: "/Users/keith",
    platform: "mac",
    appDataRoaming: null,
    appDataLocal: null,
  };

  scan(root: string, projectRoot: string): Promise<ConfigScan> {
    this.scanQueries.push({ root, projectRoot });
    return Promise.resolve(this.scans.get(root) ?? { status: "missing", root });
  }
  read(path: string, projectRoot: string): Promise<FileRead> {
    this.readQueries.push({ path, projectRoot });
    if (this.readFailPaths.has(path) || !this.reads.has(path)) {
      return Promise.reject(new Error(`config_read ${path}: no such file`));
    }
    return Promise.resolve(this.reads.get(path)!);
  }
  readOptionalText(path: string, projectRoot: string): Promise<string | null> {
    this.readQueries.push({ path, projectRoot });
    if (this.readFailPaths.has(path)) {
      return Promise.reject(new Error("config artifact is unreadable"));
    }
    const read = this.reads.get(path);
    if (!read) return Promise.resolve(null);
    return read.kind === "text"
      ? Promise.resolve(read.content)
      : Promise.reject(new Error("config artifact is not text"));
  }
  baselineText(path: string, expectedHash: string, _projectRoot: string): Promise<string> {
    for (const [candidate, read] of this.reads) {
      if (!candidate.startsWith(`${path}.kodade-bak`) || read.kind !== "text") continue;
      const actual = bytesToHex(sha256(utf8ToBytes(read.content)));
      if (actual === expectedHash) return Promise.resolve(read.content);
    }
    return Promise.reject(new Error("the onboarding baseline backup is unavailable"));
  }
  env(): Promise<ConfigEnv> {
    this.envQueries++;
    return Promise.resolve(this.envResult);
  }

  async rename(path: string, newPath: string, projectRoot: string): Promise<void> {
    this.renameCalls.push({ path, newPath, projectRoot });
    if (this.failRenameWith !== null) throw new Error(this.failRenameWith);
    this.applyRename(path, newPath);
    if (this.deferConfigRename) {
      await new Promise<void>((resolve) => this.configRenameResolvers.push(resolve));
    }
  }
  // Release the oldest pending deferred rename.
  resolveRename() {
    this.configRenameResolvers.shift()?.();
  }

  write(path: string, contents: string, expectedHash: string, projectRoot: string): Promise<string> {
    this.writeCalls.push({ path, contents, expectedHash, projectRoot });
    if (this.failConfigWriteWith !== null) {
      return Promise.reject(new Error(this.failConfigWriteWith));
    }
    const hadFile = this.reads.has(path);
    const backup = hadFile ? `${path}.kodade-bak-mock` : "";
    if (hadFile) this.reads.set(backup, this.reads.get(path)!);
    this.reads.set(path, { kind: "text", content: contents });
    return Promise.resolve(backup);
  }
  removeFile(path: string, expectedHash: string, projectRoot: string): Promise<void> {
    this.removeFileCalls.push({ path, expectedHash, projectRoot });
    const current = this.reads.get(path);
    if (!current || current.kind !== "text") {
      return Promise.reject(new Error("config file is unavailable"));
    }
    const actual = bytesToHex(sha256(utf8ToBytes(current.content)));
    if (actual !== expectedHash) return Promise.reject(new Error("config changed since apply"));
    this.reads.delete(path);
    return Promise.resolve();
  }
  backup(path: string, projectRoot: string): Promise<string> {
    this.backupCalls.push({ path, projectRoot });
    if (this.failBackupWith !== null) return Promise.reject(new Error(this.failBackupWith));
    const backup = `${path}.kodade-bak-mock`;
    const current = this.reads.get(path);
    if (current) this.reads.set(backup, current);
    return Promise.resolve(backup);
  }
  restore(path: string, backupPath: string, projectRoot: string): Promise<void> {
    this.restoreCalls.push({ path, backupPath, projectRoot });
    if (this.failRestoreWith !== null) return Promise.reject(new Error(this.failRestoreWith));
    const backup = this.reads.get(backupPath);
    if (backup) this.reads.set(path, backup);
    return Promise.resolve();
  }

  kodSkillsPackRead(): Promise<KodSkillsPackBundle> {
    return this.kodSkillsBundle
      ? Promise.resolve(this.kodSkillsBundle)
      : Promise.reject(new Error("KödSkills pack is not scripted"));
  }

  dirSnapshot(path: string, _projectRoot: string): Promise<ConfigDirSnapshot> {
    return Promise.resolve(this.dirSnapshots.get(path) ?? { status: "missing", path });
  }

  externalSkillSnapshot(path: string, _projectRoot: string): Promise<ConfigFileHash[]> {
    const snapshot = this.externalSkillSnapshots.get(path);
    return snapshot
      ? Promise.resolve(snapshot)
      : Promise.reject(new Error("external skill is unavailable"));
  }

  installDir(
    path: string,
    files: ConfigInstallFile[],
    expectedFiles: ConfigFileHash[] | null,
    projectRoot: string,
  ): Promise<string> {
    this.installDirCalls.push({ path, files, expectedFiles, projectRoot });
    const backupPath = expectedFiles ? `${path}.kodade-bak-mock` : "";
    if (expectedFiles) {
      this.dirSnapshots.set(backupPath, { status: "snapshot", path: backupPath, files: expectedFiles });
    }
    this.dirSnapshots.set(path, {
      status: "snapshot",
      path,
      files: files.map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 })),
    });
    return Promise.resolve(backupPath);
  }

  removeDir(
    path: string,
    expectedFiles: ConfigFileHash[],
    projectRoot: string,
    keepBackup: boolean,
  ): Promise<string> {
    this.removeDirCalls.push({ path, expectedFiles, projectRoot, keepBackup });
    const backupPath = keepBackup ? `${path}.kodade-bak-mock` : "";
    if (keepBackup) {
      this.dirSnapshots.set(backupPath, { status: "snapshot", path: backupPath, files: expectedFiles });
    }
    this.dirSnapshots.set(path, { status: "missing", path });
    return Promise.resolve(backupPath);
  }

  restoreDir(
    path: string,
    backupPath: string,
    expectedFiles: ConfigFileHash[] | null,
    projectRoot: string,
  ): Promise<void> {
    this.restoreDirCalls.push({ path, backupPath, expectedFiles, projectRoot });
    const backup = this.dirSnapshots.get(backupPath);
    if (backup?.status === "snapshot") {
      this.dirSnapshots.set(path, { status: "snapshot", path, files: backup.files });
    }
    return Promise.resolve();
  }

  // Move an entry in the in-memory model so a rescan reflects the rename: the
  // file content follows the path, and the containing dir's listing entry gets
  // its name/path rewritten (so scan.ts recomputes enabled from the suffix).
  private applyRename(from: string, to: string) {
    if (this.reads.has(from)) {
      this.reads.set(to, this.reads.get(from)!);
      this.reads.delete(from);
    }
    if (this.readFailPaths.has(from)) {
      this.readFailPaths.delete(from);
      this.readFailPaths.add(to);
    }
    const dir = nativeDirname(from);
    if (!dir) return;
    const scan = this.scans.get(dir);
    if (scan && scan.status === "listing") {
      for (const entry of scan.entries) {
        if (entry.path === from) {
          entry.path = to;
          entry.name = nativeBasename(to);
        }
      }
    }
  }
}

// In-memory mock of the SshIpc contract (M11a): a scriptable detect() result
// and a path -> file-contents map for readConfig(). A path absent from
// `configs` (and not in `readFailPaths`) resolves to null — the normal
// "file doesn't exist" state the store treats as "no hosts here".
export class MockSsh implements SshIpc {
  // When null, detect() rejects with detectFailure (ssh not found).
  detectResult: SshDetectResult | null = { path: "/usr/bin/ssh", version: "OpenSSH_9.6" };
  detectFailure = "ssh: not found";

  // path -> file contents readConfig() returns (undefined path key = "~/.ssh/config").
  configs = new Map<string | undefined, string>();
  // Paths readConfig() should reject for (guard rejection / genuine read failure).
  readFailPaths = new Set<string | undefined>();
  // dir path -> the file names listDir() returns (undefined key = "~/.ssh").
  // A dir absent from the map resolves null, like a missing directory.
  dirs = new Map<string | undefined, string[]>();
  // Dirs listDir() should reject for (guard rejection).
  listFailPaths = new Set<string | undefined>();

  // Recorded queries, for "which paths were read/listed" assertions.
  readQueries: (string | undefined)[] = [];
  listQueries: (string | undefined)[] = [];
  detectQueries = 0;

  // --- exec (M11c) ---
  // Recorded ssh_exec calls, plus a substring-keyed script so a test can set a
  // per-provider outcome without knowing how command.ts quotes argv: the store
  // probes `command -v <bin>`, so keying on the bare bin name (which survives
  // POSIX single-quoting) is the natural seam. "reject" simulates a hard
  // timeout / unsupported remote (the IPC call rejects). Unmatched argv default
  // to exit 127 / empty stdout — a clean "not installed on the remote".
  execCalls: { host: string; argv: string[]; timeoutMs: number }[] = [];
  execScript = new Map<string, SshExecResult | "reject">();
  execRejectReason = "ssh_exec timed out";
  // Optional per-call latency so a test can race a re-detect against an
  // in-flight probe (out-of-order guard).
  execLatencyMs = 0;

  async exec(host: string, argv: string[], timeoutMs: number): Promise<SshExecResult> {
    this.execCalls.push({ host, argv, timeoutMs });
    if (this.execLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.execLatencyMs));
    }
    const joined = argv.join(" ");
    for (const [needle, outcome] of this.execScript) {
      if (joined.includes(needle)) {
        if (outcome === "reject") throw new Error(this.execRejectReason);
        return outcome;
      }
    }
    return { status: 127, stdout: "", stderr: "", truncated: false };
  }

  detect(): Promise<SshDetectResult> {
    this.detectQueries++;
    if (!this.detectResult) return Promise.reject(new Error(this.detectFailure));
    return Promise.resolve(this.detectResult);
  }

  readConfig(path?: string): Promise<string | null> {
    this.readQueries.push(path);
    if (this.readFailPaths.has(path)) {
      return Promise.reject(new Error(`ssh_config_read ${path ?? "~/.ssh/config"}: rejected`));
    }
    return Promise.resolve(this.configs.get(path) ?? null);
  }

  listDir(path?: string): Promise<string[] | null> {
    this.listQueries.push(path);
    if (this.listFailPaths.has(path)) {
      return Promise.reject(new Error(`ssh_list_dir ${path ?? "~/.ssh"}: rejected`));
    }
    return Promise.resolve(this.dirs.get(path) ?? null);
  }
}

// Parent dir of an absolute native path (mirrors the store's parentDir).
function parentOf(path: string): string {
  return nativeDirname(path) ?? path;
}
// Final path component.
function baseName(path: string): string {
  return nativeBasename(path);
}
