// Module-level registry owning every live terminal (xterm + PTY session +
// host DOM node). Sessions must survive project switches: xterm can't be
// reparented or rebuilt without losing scrollback and the running process, so
// hosts stay in the DOM and are shown/hidden. React components are thin views
// that call sync(); they never own terminals.
//
// Terminal construction is injected (TerminalFactory) so the registry's
// bookkeeping — open-once, close-once, show-only-active — tests headless.

import type { ITheme } from "@xterm/xterm";

export type TerminalHandle = {
  host: HTMLElement;
  ready: Promise<void>;
  focus(): void;
  paste(data: string): Promise<void>; // queueable user-style input (file drops)
  write(data: string): Promise<void>; // send a programmatic command into the PTY
  bracketedPasteMode(): boolean; // xterm DECSET 2004 state for safe multiline paste
  setTheme(theme: ITheme): void; // live re-skin: no restart, scrollback intact
  dispose(): Promise<void>; // kills the PTY and tears down xterm
};

export type TerminalFactory = (opts: { id: string; cwd: string }) => TerminalHandle;

export class SessionRegistry {
  private entries = new Map<string, TerminalHandle>();
  // The theme in effect. Held so terminals opened AFTER a theme change start in
  // the current theme instead of the factory's built-in default.
  private theme: ITheme | null = null;

  constructor(private factory: TerminalFactory) {}

  // Create a terminal for `id` (no-op if it already exists). New terminals
  // adopt the current theme immediately if one has been set.
  open(id: string, cwd: string): Promise<void> {
    const existing = this.entries.get(id);
    if (existing) return existing.ready;
    const handle = this.factory({ id, cwd });
    handle.host.dataset.terminalSessionId = id;
    if (this.theme) handle.setTheme(this.theme);
    this.entries.set(id, handle);
    return handle.ready;
  }

  // Re-skin every live terminal and remember the theme for future opens. This
  // is the M5 live-retheme path: xterm.options.theme is mutated in place, so
  // scrollback and the running process are untouched.
  setTheme(theme: ITheme): void {
    this.theme = theme;
    for (const entry of this.entries.values()) entry.setTheme(theme);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  // Is `node` inside any live terminal's host? The shortcut dispatcher uses this
  // to gate: while focus/the event target sits in a terminal, only app chords
  // fire and everything else falls through to the shell.
  containsNode(node: Node | null): boolean {
    if (!node) return false;
    for (const entry of this.entries.values()) {
      if (entry.host.contains(node)) return true;
    }
    return false;
  }

  // Programmatic launches must fail loudly if the session disappeared so the
  // calling UI can surface an inline error instead of reporting false success.
  ready(id: string): Promise<void> {
    return (
      this.entries.get(id)?.ready ??
      Promise.reject(new Error("terminal session is unavailable"))
    );
  }

  write(id: string, data: string): Promise<void> {
    return (
      this.entries.get(id)?.write(data) ??
      Promise.reject(new Error("terminal session is unavailable"))
    );
  }

  bracketedPasteMode(id: string): boolean {
    return this.entries.get(id)?.bracketedPasteMode() ?? false;
  }

  // File drops behave like user input: they may arrive while the shell is
  // starting, so preserve TerminalSession's queueing and benign exit-race
  // semantics. An already-gone session is a harmless no-op for a paste.
  paste(id: string, data: string): Promise<void> {
    return this.entries.get(id)?.paste(data) ?? Promise.resolve();
  }

  // Dispose a terminal exactly once (kills its process group via the session).
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id); // delete first: re-entrant close is a no-op
    entry.host.remove();
    await entry.dispose();
  }

  // Attach every host into `container` (idempotent) and show one or more ids.
  // Hidden hosts keep display:none but stay in the DOM — their shells run on.
  // The string form preserves the original single-terminal API.
  sync(
    container: HTMLElement,
    visible: string | string[] | null,
    activeId?: string | null,
  ): void {
    const visibleIds = new Set(
      Array.isArray(visible) ? visible : visible ? [visible] : [],
    );
    const focusedId =
      activeId === undefined
        ? Array.isArray(visible)
          ? (visible[0] ?? null)
          : visible
        : activeId;
    for (const [id, entry] of this.entries) {
      if (entry.host.parentElement !== container) container.appendChild(entry.host);
      entry.host.style.display = visibleIds.has(id) ? "" : "none";
      entry.host.dataset.terminalActive = String(id === focusedId);
    }
    if (focusedId) this.entries.get(focusedId)?.focus();
  }

  // Close everything (project removal sweeps, tests).
  async closeAll(): Promise<void> {
    const ids = [...this.entries.keys()];
    for (const id of ids) await this.close(id);
  }
}
