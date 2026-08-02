// The real TerminalFactory: builds an xterm terminal in its own host div and
// wires it to the Rust PTY through a TerminalSession. Hosts are created
// detached — the registry appends them into the terminal pane — so the
// renderer attach and first fit are deferred until the host has real size.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { PtyIpc } from "../ipc/contract";
import { attachRenderer } from "./renderer";
import { TerminalSession } from "./session";
import type { TerminalFactory } from "./registry";
import { shouldInterceptXtermKey } from "../shortcuts/interception";
import { monoFontFamily } from "../platform/fonts";

export type XtermFactoryOpts = {
  // Called when a session's shell dies (natural exit or failed spawn), so the
  // store can mark it exited and the sidebar can dim it.
  onSessionDead?: (id: string, code: number | null) => void;
  // Receives only a session id when bytes arrive; raw terminal output stays in
  // xterm and is never copied into the activity model.
  onSessionOutput?: (id: string) => void;
};

export function createXtermFactory(
  ipc: PtyIpc,
  opts: XtermFactoryOpts = {},
): TerminalFactory {
  return ({ id, cwd }) => {
    const host = document.createElement("div");
    host.className = "h-full w-full p-2";

    // 10k scrollback. Theme starts at a neutral dark and is immediately set to
    // the active theme by the registry on open() (and updated live on change).
    const term = new Terminal({
      scrollback: 10000,
      // Brand default face (DESIGN.md §3), self-hosted; fallback keeps the
      // previous ui-monospace chain if the font ever fails to load.
      fontFamily: monoFontFamily(),
      fontSize: 13,
      theme: { background: "#0c0c0f" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // Let app command chords (Mod+T/S, session/project switching) bubble to the
    // window dispatcher instead of being consumed by xterm in WKWebView.
    // Returning false tells xterm to ignore the key; only the exact table combos
    // are excluded, so the shell still owns every other keystroke (including
    // Ctrl-combos and bare keys).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && shouldInterceptXtermKey(e)) return false;
      return true;
    });

    term.open(host);

    const session = new TerminalSession(ipc, term, {
      id,
      cwd,
      cols: term.cols,
      rows: term.rows,
      onExit: (code) => {
        // code === null covers failed spawns; the start() catch below adds the
        // human-readable reason in that case.
        if (code !== null) term.write("\r\n[process exited]\r\n");
        opts.onSessionDead?.(id, code);
      },
      onOutput: () => opts.onSessionOutput?.(id),
    });

    // Keystrokes → PTY.
    const dataSub = term.onData((data) => void session.input(data));
    const ready = session.start();
    void ready.catch((err) => {
      console.error("kodade: shell failed to start:", err);
      if (session.state === "disposed") return; // torn down mid-start; term is gone
      term.write(
        `\r\ncould not start shell in ${cwd || "home"} — folder missing or unreadable\r\n(${String(err)})\r\n`,
      );
    });

    // Observe host resize → refit → tell the PTY the new size. Coalesced into
    // a rAF so a fit that nudges layout can't spin the observer; zero-size
    // hosts (detached or display:none) are skipped. The WebGL renderer is
    // attached on the first real layout so it never initializes at 0x0.
    let rafId = 0;
    let rendererAttached = false;
    const ro = new ResizeObserver(() => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        if (!rendererAttached) {
          rendererAttached = true;
          attachRenderer(term); // WebGL, falling back to canvas/DOM
        }
        fit.fit();
        void session.resize(term.cols, term.rows);
      });
    });
    ro.observe(host);

    // Re-measure once the bundled mono face is actually loaded: xterm snapshots
    // cell metrics at open(), and a cold launch can beat the woff2 — leaving
    // glyphs clipped and the PTY sized to fallback-font metrics. Re-setting
    // fontFamily rebuilds the glyph atlas; then refit and resize the PTY.
    let fontDisposed = false;
    void document.fonts.load('13px "JetBrains Mono"').then(() => {
      if (fontDisposed || host.clientWidth === 0) return;
      // eslint-disable-next-line no-self-assign
      term.options.fontFamily = term.options.fontFamily; // setter re-measures
      fit.fit();
      void session.resize(term.cols, term.rows);
    });

    return {
      host,
      ready,
      focus: () => term.focus(),
      // File drops keep user-input queueing while the shell starts.
      paste: (data: string) => session.input(data),
      // Programmatic launch commands surface write failures to their caller.
      write: (data: string) => session.command(data),
      // DECSET 2004 tells a shell/TUI that a multiline paste is one atomic
      // operation. KödWhisper reads this live state before writing its text.
      bracketedPasteMode: () => term.modes.bracketedPasteMode,
      // Live re-skin: mutate the palette in place — scrollback and the running
      // process are untouched (xterm repaints from the new theme).
      setTheme: (theme) => {
        term.options.theme = theme;
      },
      dispose: async () => {
        fontDisposed = true;
        if (rafId) cancelAnimationFrame(rafId);
        ro.disconnect();
        dataSub.dispose();
        await session.dispose(); // kills the process group
        term.dispose();
      },
    };
  };
}
