// Wiring between a terminal surface (an xterm-like write sink) and the PtyIpc.
// This is the unit under test: it owns no rendering, just the data plumbing —
// spawn, decode output → sink, forward input/resize → IPC, teardown on exit.
//
// Lifecycle is an explicit state machine (new → starting → live → exited /
// disposed) and startup/teardown are cancellation-safe: React StrictMode's
// mount → unmount → remount must never let a stale mount's kill or exit land
// on a newer session (each mount also uses a fresh unique id).

import { toBase64, fromBase64 } from "./base64";
import type { ExitEvent, OutputEvent, PtyIpc, Unlisten } from "../ipc/contract";

// Minimal slice of xterm's API the session needs — keeps tests free of xterm.
// xterm's Terminal.write accepts string | Uint8Array; we feed it raw bytes.
export interface TermSink {
  write(data: Uint8Array): void;
}

export type SessionState = "new" | "starting" | "live" | "exited" | "disposed";

export type SessionOpts = {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  onExit?: (code: number | null) => void;
  // Activity receives only that output happened, never the decoded terminal
  // bytes. This preserves the no-transcript privacy boundary.
  onOutput?: () => void;
};

export class TerminalSession {
  private unlisteners: Unlisten[] = [];
  private _state: SessionState = "new";
  private spawnCompleted = false; // a PTY exists in Rust and may need killing
  private pendingResize: { cols: number; rows: number } | null = null;
  private pendingInput: string | null = null; // typed before the shell was live
  readonly id: string;

  constructor(
    private ipc: PtyIpc,
    private term: TermSink,
    private opts: SessionOpts,
  ) {
    this.id = opts.id;
  }

  get state(): SessionState {
    return this._state;
  }

  private get disposed(): boolean {
    return this._state === "disposed";
  }

  // Subscribe to events, then spawn the shell. Every await is followed by a
  // disposed check so a dispose() racing with start() always wins cleanly.
  async start(): Promise<void> {
    if (this._state !== "new") return;
    this._state = "starting";

    const offOutput = await this.ipc.onOutput((e: OutputEvent) => {
      if (e.id !== this.id || this.disposed) return; // never write a disposed xterm
      this.opts.onOutput?.();
      this.term.write(fromBase64(e.data));
    });
    if (this.disposed) {
      offOutput();
      return;
    }
    this.unlisteners.push(offOutput);

    const offExit = await this.ipc.onExit((e: ExitEvent) => {
      if (e.id !== this.id || this.disposed) return;
      this._state = "exited"; // sticks even if start() is still mid-flight
      this.opts.onExit?.(e.code);
    });
    if (this.disposed) {
      offExit();
      return;
    }
    this.unlisteners.push(offExit);

    try {
      await this.ipc.spawn({
        id: this.id,
        cwd: this.opts.cwd,
        cols: this.opts.cols,
        rows: this.opts.rows,
      });
    } catch (err) {
      // Failed spawn = the session is dead on arrival: mark exited and tell
      // the exit listener (code null), so UIs treat it like any dead shell.
      if (!this.disposed) {
        this._state = "exited";
        this.opts.onExit?.(null);
      }
      throw err;
    }
    this.spawnCompleted = true;

    // Disposed while spawn was in flight: the PTY exists but nobody wants it.
    if (this.disposed) {
      await this.killQuietly();
      return;
    }

    if (this._state === "starting") {
      // Replay the newest resize seen during startup so xterm and the PTY
      // can't disagree about dimensions. A resize failure is benign (the
      // ResizeObserver will right-size again) — it must not abort start()
      // or lose the queued input below.
      if (this.pendingResize) {
        const { cols, rows } = this.pendingResize;
        this.pendingResize = null;
        await this.ipc
          .resize({ id: this.id, cols, rows })
          .catch((err) => this.reportUnlessGone(err));
      }
      // Drain input queued while the shell was starting (e.g. a provider
      // launch command typed the instant the session was created) BEFORE
      // going live — a fresh keystroke can never overtake queued input.
      // The loop covers input that arrives during the awaits.
      while (this.pendingInput && (this._state as SessionState) === "starting") {
        const data = this.pendingInput;
        this.pendingInput = null;
        await this.ipc
          .write({ id: this.id, data: toBase64(data) })
          .catch((err) => this.reportUnlessGone(err));
      }
      // An exit observed mid-start sticks; only an untouched start goes live.
      if ((this._state as SessionState) === "starting") this._state = "live";
    }
  }

  // User keystrokes → base64 → PTY. Queued (in order) while the session is
  // still starting; dropped once it's exited/disposed.
  // Never rejects: a keystroke racing natural exit is benign, not an error.
  input(data: string): Promise<void> {
    if (this._state === "new" || this._state === "starting") {
      this.pendingInput = (this.pendingInput ?? "") + data;
      return Promise.resolve();
    }
    if (this._state !== "live") return Promise.resolve();
    return this.ipc
      .write({ id: this.id, data: toBase64(data) })
      .catch((err) => this.reportUnlessGone(err));
  }

  // Programmatic commands (provider launches) need failure feedback at the UI
  // seam. Unlike ordinary keystrokes, reject when the live PTY write fails so
  // the launch surface can show a useful inline note.
  command(data: string): Promise<void> {
    if (this._state !== "live") {
      return Promise.reject(new Error("terminal session is not ready"));
    }
    return this.ipc.write({ id: this.id, data: toBase64(data) });
  }

  // Container/pane resize → PTY reflow. Queued (newest wins) until live.
  // Never rejects, for the same exit-race reason as input().
  resize(cols: number, rows: number): Promise<void> {
    if (this._state !== "live") {
      this.pendingResize = { cols, rows };
      return Promise.resolve();
    }
    return this.ipc
      .resize({ id: this.id, cols, rows })
      .catch((err) => this.reportUnlessGone(err));
  }

  // "no such pty" just means the shell exited between our check and the IPC
  // call landing — swallow it. Anything else is a real failure worth logging.
  private reportUnlessGone(err: unknown): void {
    if (String(err).includes("no such pty")) return;
    console.error(`kodade: pty ${this.id}:`, err);
  }

  // Tear down listeners and kill the shell. Only kills if a PTY was actually
  // spawned; a start() still awaiting its spawn will observe `disposed` after
  // the await and kill the fresh PTY itself.
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this._state = "disposed";
    for (const off of this.unlisteners) off();
    this.unlisteners = [];
    if (this.spawnCompleted) await this.killQuietly();
  }

  // Kill the PTY, tolerating "already dead" errors from the backend.
  private async killQuietly(): Promise<void> {
    try {
      await this.ipc.kill({ id: this.id });
    } catch {
      // PTY already gone (natural exit raced the kill) — nothing to do.
    }
  }
}
