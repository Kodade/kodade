import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Pane } from "./Pane";
import { KodadeMark, KodadeWordmark } from "./KodadeBrand";
import { appStore, registry, voiceStore } from "../store/appStore";
import { isChatSession, type ProjectsState, type RegistryLike } from "../store/projects";
import { clearTerminalDropTarget, setTerminalDropTarget } from "../terminal/drop-target";
import { VoiceControls } from "../voice/VoiceControls";
import { RELEASE_MANIFEST } from "../release/manifest";
import {
  pruneTerminalLayout,
  removeTerminalLeaf,
  splitTerminalLeaf,
  terminalLeaf,
  terminalLeafIds,
  terminalLeafRects,
  type TerminalLeafRect,
  type TerminalLayoutNode,
  type TerminalSplitDirection,
} from "./terminal-layout";

const TERMINAL_LEAF_HEADER_HEIGHT = 24;

export type TerminalDisplayRegistry = RegistryLike & {
  sync(
    container: HTMLElement,
    visible: string | string[] | null,
    activeId?: string | null,
  ): void;
};

// Thin view over the session registry. A recursive split tree positions the
// registry-owned terminal hosts without rebuilding or reparenting xterm, so a
// split affects only the active leaf and never loses shell state or scrollback.
export function TerminalPane({
  projectsStore = appStore,
  terminalRegistry = registry,
  voiceControls,
}: {
  projectsStore?: StoreApi<ProjectsState>;
  terminalRegistry?: TerminalDisplayRegistry;
  voiceControls?: ReactNode;
}) {
  const hostsRef = useRef<HTMLDivElement>(null);
  const activeProjectId = useStore(projectsStore, (s) => s.activeProjectId);
  const sessions = useStore(projectsStore, (s) => s.sessions);
  // A KödChat thread is a session too, but it owns no PTY host — selecting one
  // must never make this pane try to display a terminal that doesn't exist.
  const selectedSessionId = useStore(projectsStore, (s) =>
    s.activeProjectId ? (s.activeSessionByProject[s.activeProjectId] ?? null) : null,
  );
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
  const latestProjectTerminalId =
    sessions
      .filter(
        (session) =>
          session.projectId === activeProjectId && !isChatSession(session),
      )
      .at(-1)?.id ?? null;
  const activeSessionId =
    selectedSession && !isChatSession(selectedSession)
      ? selectedSessionId
      : latestProjectTerminalId;
  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? null;
  const hasProject = activeProjectId !== null;
  const [layoutTree, setLayoutTree] = useState<TerminalLayoutNode | null>(() =>
    activeSessionId ? terminalLeaf(activeSessionId) : null,
  );
  const [maximizedSessionId, setMaximizedSessionId] = useState<string | null>(
    null,
  );

  const projectSessionIds = useMemo(
    () =>
      new Set(
        sessions
          .filter(
            (session) =>
              session.projectId === activeProjectId && !isChatSession(session),
          )
          .map((session) => session.id),
      ),
    [activeProjectId, sessions],
  );
  const displayedTree = useMemo(
    () =>
      pruneTerminalLayout(layoutTree, projectSessionIds) ??
      (activeSessionId ? terminalLeaf(activeSessionId) : null),
    [activeSessionId, layoutTree, projectSessionIds],
  );
  const treeSessionIds = useMemo(
    () => terminalLeafIds(displayedTree),
    [displayedTree],
  );
  const activeMaximizedSessionId =
    maximizedSessionId && treeSessionIds.includes(maximizedSessionId)
      ? maximizedSessionId
      : null;
  const renderedTree = useMemo(
    () =>
      activeMaximizedSessionId
        ? terminalLeaf(activeMaximizedSessionId)
        : displayedTree,
    [activeMaximizedSessionId, displayedTree],
  );
  const displayedSessionIds = useMemo(
    () => terminalLeafIds(renderedTree),
    [renderedTree],
  );
  const leafRects = useMemo(
    () => terminalLeafRects(renderedTree),
    [renderedTree],
  );
  const visibleKey = displayedSessionIds.join("\u0000");
  const geometryKey = leafRects
    .map(
      (rect) =>
        `${rect.sessionId}:${rect.left}:${rect.top}:${rect.width}:${rect.height}`,
    )
    .join("|");
  const displayedLayout =
    renderedTree?.kind === "split" ? renderedTree.direction : "single";

  // A project switch returns to one terminal. Sessions in the old project keep
  // running and remain available from their workspace cards.
  useEffect(() => {
    setLayoutTree(activeSessionId ? terminalLeaf(activeSessionId) : null);
    setMaximizedSessionId(null);
    // activeSessionId is intentionally read only at the project boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  // Sidebar selection focuses an existing split leaf. Selecting a different
  // workspace starts that workspace in one-pane view; its other shells keep
  // running and can be reintroduced with future persisted-layout work.
  useEffect(() => {
    if (!activeSessionId) {
      setLayoutTree((current) => pruneTerminalLayout(current, projectSessionIds));
      setMaximizedSessionId(null);
      return;
    }
    setLayoutTree((current) => {
      const valid = pruneTerminalLayout(current, projectSessionIds);
      return valid && terminalLeafIds(valid).includes(activeSessionId)
        ? valid
        : terminalLeaf(activeSessionId);
    });
    setMaximizedSessionId((current) =>
      current === activeSessionId && projectSessionIds.has(current)
        ? current
        : null,
    );
  }, [activeSessionId, projectSessionIds]);

  useEffect(() => {
    const container = hostsRef.current;
    if (!container) return;
    terminalRegistry.sync(container, displayedSessionIds, activeSessionId);
    const rectBySession = new Map(
      leafRects.map((rect) => [rect.sessionId, rect]),
    );
    for (const host of container.querySelectorAll<HTMLElement>(
      ":scope > [data-terminal-session-id]",
    )) {
      const sessionId = host.dataset.terminalSessionId;
      const rect = sessionId ? rectBySession.get(sessionId) : undefined;
      if (!rect) continue;
      host.style.position = "absolute";
      host.style.left = `calc(${rect.left}% + 1px)`;
      host.style.top = `calc(${rect.top}% + ${TERMINAL_LEAF_HEADER_HEIGHT}px)`;
      host.style.width = `calc(${rect.width}% - 1px)`;
      host.style.height = `calc(${rect.height}% - ${TERMINAL_LEAF_HEADER_HEIGHT + 1}px)`;
      host.style.boxSizing = "border-box";
    }
  }, [
    activeSessionId,
    geometryKey,
    leafRects,
    sessions.length,
    terminalRegistry,
    visibleKey,
  ]);

  // The native drop listener is app-wide, so register this content host for
  // position hit-testing instead of adding a competing DOM drag listener.
  useEffect(() => {
    const host = hostsRef.current;
    if (!host) return;
    setTerminalDropTarget(host);
    return () => clearTerminalDropTarget(host);
  }, []);

  const focusTerminal = (sessionId: string) => {
    if (!activeProjectId || !projectSessionIds.has(sessionId)) return;
    projectsStore.getState().setActiveSession(activeProjectId, sessionId);
  };

  const splitTerminal = (
    sessionId: string,
    direction: TerminalSplitDirection,
  ) => {
    const state = projectsStore.getState();
    const projectId = state.activeProjectId;
    if (!projectId) return;
    const current = state.sessions.find((session) => session.id === sessionId);
    if (!current || current.projectId !== projectId) return;
    const workspaceId = current.workspaceId ?? current.id;
    focusTerminal(sessionId);
    const newId = state.addTerminal(projectId, workspaceId);
    if (!newId) return;
    const currentTree = treeSessionIds.includes(sessionId)
      ? displayedTree
      : terminalLeaf(sessionId);
    if (!currentTree) return;
    setLayoutTree(
      splitTerminalLeaf(currentTree, sessionId, newId, direction),
    );
    setMaximizedSessionId(null);
  };

  const closeTerminal = (sessionId: string) => {
    const nextTree = removeTerminalLeaf(displayedTree, sessionId);
    const remainingIds = terminalLeafIds(nextTree);
    const state = projectsStore.getState();
    const projectId = state.activeProjectId;
    const selectedId = projectId
      ? (state.activeSessionByProject[projectId] ?? null)
      : null;
    const nextFocusedId =
      selectedId && selectedId !== sessionId && remainingIds.includes(selectedId)
        ? selectedId
        : (remainingIds[0] ?? null);
    setLayoutTree(nextTree);
    setMaximizedSessionId((current) =>
      current === sessionId ? null : current,
    );
    void state.closeSession(sessionId).then(() => {
      if (
        projectId &&
        nextFocusedId &&
        projectsStore
          .getState()
          .sessions.some(
            (session) =>
              session.projectId === projectId && session.id === nextFocusedId,
          )
      ) {
        projectsStore.getState().setActiveSession(projectId, nextFocusedId);
      }
    });
  };

  const toggleMaximizeTerminal = (sessionId: string) => {
    focusTerminal(sessionId);
    setMaximizedSessionId((current) =>
      current === sessionId ? null : sessionId,
    );
  };

  return (
    <Pane
      title={activeSession ? `terminal — ${activeSession.name}` : "terminal"}
      className="bg-bg"
    >
      <div className="flex h-full w-full flex-col">
        <div
          className="relative min-h-0 flex-1"
          onPointerDownCapture={(event) => {
            const target =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-terminal-session-id]")
                : null;
            const sessionId = target?.dataset.terminalSessionId;
            if (!sessionId) return;
            focusTerminal(sessionId);
          }}
        >
          <div
            ref={hostsRef}
            data-terminal-layout={displayedLayout}
            data-terminal-maximized={activeMaximizedSessionId ?? ""}
            data-terminal-leaf-count={displayedSessionIds.length}
            className="absolute inset-0 min-h-0 min-w-0 bg-border"
          />
          <div className="pointer-events-none absolute inset-0 z-10">
            {leafRects.map((rect) => {
              const session = sessions.find(
                (candidate) => candidate.id === rect.sessionId,
              );
              if (!session) return null;
              return (
                <TerminalLeafChrome
                  key={rect.sessionId}
                  rect={rect}
                  name={session.name}
                  active={activeSessionId === rect.sessionId}
                  maximized={activeMaximizedSessionId === rect.sessionId}
                  onFocus={() => focusTerminal(rect.sessionId)}
                  onSplit={(direction) =>
                    splitTerminal(rect.sessionId, direction)
                  }
                  onToggleMaximize={() =>
                    toggleMaximizeTerminal(rect.sessionId)
                  }
                  onClose={() => closeTerminal(rect.sessionId)}
                />
              );
            })}
          </div>
          {!hasProject && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center text-center text-text">
                <KodadeMark size={16} />
                <KodadeWordmark className="mt-3 text-lg" />
                <p className="mt-4 text-sm text-text-dim">
                  Add a project to open a terminal
                </p>
              </div>
            </div>
          )}
          {hasProject && !activeSessionId && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-center">
                <p className="text-sm text-text-dim">No terminal is open</p>
                <button
                  type="button"
                  aria-label="New terminal"
                  onClick={() => {
                    if (!activeProjectId) return;
                    projectsStore.getState().addSession(activeProjectId);
                  }}
                  className="rounded border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  New terminal
                </button>
              </div>
            </div>
          )}
          {RELEASE_MANIFEST.features.voice &&
            (voiceControls === undefined ? (
              <VoiceControls store={voiceStore} disabled={!activeSessionId} />
            ) : (
              voiceControls
            ))}
        </div>
      </div>
    </Pane>
  );
}

function TerminalLeafChrome({
  rect,
  name,
  active,
  maximized,
  onFocus,
  onSplit,
  onToggleMaximize,
  onClose,
}: {
  rect: TerminalLeafRect;
  name: string;
  active: boolean;
  maximized: boolean;
  onFocus(): void;
  onSplit(direction: TerminalSplitDirection): void;
  onToggleMaximize(): void;
  onClose(): void;
}) {
  return (
    <div
      data-terminal-leaf-id={rect.sessionId}
      data-terminal-left={rect.left}
      data-terminal-top={rect.top}
      data-terminal-width={rect.width}
      data-terminal-height={rect.height}
      className={`pointer-events-auto absolute flex h-[23px] items-center border-b border-border bg-surface px-1.5 text-[10px] text-text-dim ${
        active ? "text-text" : ""
      }`}
      style={{
        left: `calc(${rect.left}% + 1px)`,
        top: `calc(${rect.top}% + 1px)`,
        width: `calc(${rect.width}% - 1px)`,
      }}
      onPointerDown={onFocus}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <TerminalLeafAction
        label={`Split terminal ${name} vertically`}
        title="Split side by side"
        onClick={() => onSplit("vertical")}
      >
        <VerticalSplitIcon />
      </TerminalLeafAction>
      <TerminalLeafAction
        label={`Split terminal ${name} horizontally`}
        title="Split top and bottom"
        onClick={() => onSplit("horizontal")}
      >
        <HorizontalSplitIcon />
      </TerminalLeafAction>
      <TerminalLeafAction
        label={`${maximized ? "Restore" : "Maximize"} terminal ${name}`}
        title={maximized ? "Restore split layout" : "Maximize terminal"}
        onClick={onToggleMaximize}
      >
        <MaximizeTerminalIcon restored={maximized} />
      </TerminalLeafAction>
      <TerminalLeafAction
        label={`Close terminal ${name}`}
        title="Close terminal"
        onClick={onClose}
      >
        <span aria-hidden="true" className="text-sm leading-none">×</span>
      </TerminalLeafAction>
    </div>
  );
}

function TerminalLeafAction({
  label,
  title,
  onClick,
  children,
}: {
  label: string;
  title: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text"
    >
      {children}
    </button>
  );
}

function VerticalSplitIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M8 2.5v11" />
    </svg>
  );
}

function HorizontalSplitIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M2 8h12" />
    </svg>
  );
}

function MaximizeTerminalIcon({ restored }: { restored: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" aria-hidden="true">
      {restored && <path d="M5 3h8v8" />}
      <rect x={restored ? 3 : 2.5} y={restored ? 5 : 2.5} width="10" height="10" rx="1" />
    </svg>
  );
}
