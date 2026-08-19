// The v2 shell's Code tab (issue #62, slice c): a chat window and a terminal
// window side by side.
//
// Both windows are ALWAYS mounted. Hiding one, or expanding the other to fill
// the tab, only changes CSS and panel sizes — never the React tree. The
// terminal hosts xterm canvases owned by the session registry, and unmounting
// or reparenting them mid-session loses scrollback and risks a WKWebView/WebGL
// crash (the same invariant KeepAliveTabs exists to protect).
//
// "Expand to full" covers the tab content area only. The sidebar and the title
// bar are the app frame and stay put, so there is always a way back out.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
  type Layout,
  type LayoutChangedMeta,
} from "react-resizable-panels";
import { useStore } from "zustand";
import { TerminalPane } from "../TerminalPane";
import { ChatPane } from "../chat/ChatPane";
import { appStore } from "../../store/appStore";
import type { CodeExpandTarget, CodePaneMode } from "./shell-layout";

// Same separator styling as the rest of the shell.
const SEP =
  "w-px cursor-col-resize bg-border transition-colors data-[active]:bg-accent hover:bg-accent";

// Neither window may be dragged to a sliver the user can't drag back. Matches
// shell-layout's SPLIT_MIN/SPLIT_MAX so a persisted 10% renders honestly
// instead of snapping to a wider floor on the way in.
const WINDOW_MIN = "10%";
const SPLIT_MIN = 10;
const SPLIT_MAX = 90;

export function CodeTab({ active }: { active: boolean }) {
  const shellLayout = useStore(appStore, (s) => s.shellLayout);
  const { mode, chatPct, expanded } = shellLayout.code;
  const groupRef = useRef<GroupImperativeHandle | null>(null);

  const chatOpen = expanded ? expanded === "chat" : mode !== "terminal";
  const terminalOpen = expanded ? expanded === "terminal" : mode !== "chat";
  const both = chatOpen && terminalOpen;

  // Mount-time geometry only. The Code tab mounts LAZILY, so the saved split is
  // already correct on its first frame; later changes go through setLayout.
  const [defaultLayout] = useState<Layout>(() =>
    splitLayout(chatOpen, terminalOpen, chatPct),
  );

  // Reassert sizes when a window is hidden, shown, or expanded. Keyed on
  // visibility alone: a drag already moved the panels, and re-applying the
  // store's (debounced) chatPct on every drag frame would fight the user. The
  // saved split is read from the store here rather than tracked in a ref, so a
  // drag never re-runs this effect.
  //
  // The next-frame repeat is the same hazard App.tsx documents for its rails:
  // react-resizable-panels re-registers the un-hidden panel's constraints in a
  // layout effect AFTER this parent effect, so the first setLayout is still
  // clamped by the stale `maxSize: 0` and would strand the restored window at
  // its minimum. Reasserting once the constraint is gone lands the saved split.
  useEffect(() => {
    const target = splitLayout(
      chatOpen,
      terminalOpen,
      appStore.getState().shellLayout.code.chatPct,
    );
    groupRef.current?.setLayout(target);
    const frame = requestAnimationFrame(() =>
      groupRef.current?.setLayout(target),
    );
    return () => cancelAnimationFrame(frame);
  }, [chatOpen, terminalOpen]);

  // Coming back to this tab, put the caret back in the terminal the user left
  // running. Bumping the nonce re-runs TerminalPane's registry sync, which
  // focuses the active session. Sizing self-heals through xterm's own
  // ResizeObserver, so focus is the only gap worth closing here.
  //
  // Never on first run, and never while the terminal window is hidden: KödChat
  // is the primary surface, so booting (or returning to a chat-only Code tab)
  // must not pull the caret into an xterm the user can't even see.
  const [focusNonce, setFocusNonce] = useState(0);
  const focusReady = useRef(false);
  useEffect(() => {
    const first = !focusReady.current;
    focusReady.current = true;
    if (first || !active || !terminalOpen) return;
    setFocusNonce((current) => current + 1);
  }, [active, terminalOpen]);

  const update = (code: Partial<typeof shellLayout.code>) => {
    appStore.getState().setShellLayout({
      ...shellLayout,
      code: { ...shellLayout.code, ...code },
    });
  };

  const setMode = (next: CodePaneMode) => update({ mode: next, expanded: null });
  const setExpanded = (next: CodeExpandTarget) => update({ expanded: next });

  // Only user drags write geometry; programmatic setLayout above reports
  // isUserInteraction=false, and a split with a hidden window is not a width
  // the user chose.
  const onLayoutChanged = (next: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction || !both) return;
    const pct = next.chat;
    if (typeof pct !== "number" || !Number.isFinite(pct)) return;
    // Clamped to the same bounds shell-layout enforces on load, so what we
    // write is always what a reload will give back.
    update({ chatPct: round2(Math.min(Math.max(pct, SPLIT_MIN), SPLIT_MAX)) });
  };

  return (
    <Group
      groupRef={groupRef}
      className="min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <Panel
        id="chat"
        minSize={chatOpen ? (both ? WINDOW_MIN : 0) : 0}
        maxSize={chatOpen ? undefined : 0}
        collapsible={false}
      >
        <CodeWindow
          name="chat"
          hidden={!chatOpen}
          controls={
            <WindowControls
              self="chat"
              other="terminal"
              expanded={expanded}
              both={both}
              onHide={() => setMode("terminal")}
              onShowOther={() => setMode("both")}
              onExpand={() => setExpanded("chat")}
              onRestore={() => setExpanded(null)}
            />
          }
        >
          {/* The v2 Code tab already owns a terminal window, so KödChat's own
              terminal split would be a second, competing shell surface. When
              the chat needs a real shell anyway — the provider login escape
              hatch — it asks, and the terminal window comes back. */}
          <ChatPane
            showTerminalToggle={false}
            onTerminalRequest={() => update({ mode: "both", expanded: null })}
          />
        </CodeWindow>
      </Panel>
      <Separator
        className={both ? SEP : "hidden"}
        disabled={!both}
        disableDoubleClick={!both}
      />
      <Panel
        id="terminal"
        minSize={terminalOpen ? (both ? WINDOW_MIN : 0) : 0}
        maxSize={terminalOpen ? undefined : 0}
        collapsible={false}
      >
        <CodeWindow
          name="terminal"
          hidden={!terminalOpen}
          controls={
            <WindowControls
              self="terminal"
              other="chat"
              expanded={expanded}
              both={both}
              onHide={() => setMode("chat")}
              onShowOther={() => setMode("both")}
              onExpand={() => setExpanded("terminal")}
              onRestore={() => setExpanded(null)}
            />
          }
        >
          <TerminalPane focusNonce={focusNonce} />
        </CodeWindow>
      </Panel>
    </Group>
  );
}

// One window of the Code tab. Hiding is `display: none` on this wrapper and
// nothing else: everything below it — including registry-owned xterm hosts —
// keeps its element identity and its place in the document.
function CodeWindow({
  name,
  hidden,
  controls,
  children,
}: {
  name: "chat" | "terminal";
  hidden: boolean;
  controls: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-code-window={name}
      data-code-window-hidden={String(hidden)}
      className="relative h-full min-h-0 min-w-0"
      style={hidden ? { display: "none" } : undefined}
    >
      {/* Controls float over the pane's own 38px header row rather than adding
          a second strip: one header per window, progressive disclosure kept. */}
      <div className="pointer-events-none absolute right-1.5 top-0 z-20 flex h-[38px] items-center gap-1">
        {controls}
      </div>
      {children}
    </div>
  );
}

// Hide / expand / restore for one window. Deliberately few affordances: while
// both windows are open you can hide or expand; while one is hidden the
// survivor offers to bring it back; while one is expanded it offers the split.
function WindowControls({
  self,
  other,
  expanded,
  both,
  onHide,
  onShowOther,
  onExpand,
  onRestore,
}: {
  self: "chat" | "terminal";
  other: "chat" | "terminal";
  expanded: CodeExpandTarget;
  both: boolean;
  onHide(): void;
  onShowOther(): void;
  onExpand(): void;
  onRestore(): void;
}) {
  if (expanded) {
    return (
      <ControlPill
        testId={`code-restore-${self}`}
        label={`Restore the ${self} and ${other} split`}
        onClick={onRestore}
      >
        <CollapseIcon />
      </ControlPill>
    );
  }

  if (!both) {
    return (
      <ControlPill
        testId={`code-show-${other}`}
        label={`Show ${other}`}
        onClick={onShowOther}
      >
        <SplitIcon />
      </ControlPill>
    );
  }

  return (
    <>
      <ControlPill
        testId={`code-hide-${self}`}
        label={`Hide ${self}`}
        onClick={onHide}
      >
        <span aria-hidden="true" className="text-sm leading-none">
          ×
        </span>
      </ControlPill>
      <ControlPill
        testId={`code-expand-${self}`}
        label={`Expand ${self} to fill the tab`}
        onClick={onExpand}
      >
        <ExpandIcon />
      </ControlPill>
    </>
  );
}

function ControlPill({
  testId,
  label,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
    >
      {children}
    </button>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M6.5 2.5H2.5v4M9.5 13.5h4v-4" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2.5 6.5h4v-4M13.5 9.5h-4v4" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M8 2.5v11" />
    </svg>
  );
}

// A hidden window is sized to 0 rather than removed: its panel, its subtree and
// its terminal hosts all stay exactly where they are.
function splitLayout(
  chatOpen: boolean,
  terminalOpen: boolean,
  chatPct: number,
): Layout {
  if (chatOpen && terminalOpen)
    return { chat: chatPct, terminal: round2(100 - chatPct) };
  return chatOpen ? { chat: 100, terminal: 0 } : { chat: 0, terminal: 100 };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
