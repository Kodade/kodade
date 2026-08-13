// KödChat: the workspace's primary agent surface (panel 2 in App.tsx).
//
// The terminal is not gone — it moved. A header toggle opens a horizontal
// split at the bottom and scopes the existing TerminalPane to this chat thread,
// so the registry keeps owning its xterm hosts without changing the sidebar.

import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Pane } from "../Pane";
import { KodadeMark, KodadeWordmark } from "../KodadeBrand";
import { TerminalPane, type TerminalDisplayRegistry } from "../TerminalPane";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript } from "./ChatTranscript";
import {
  appStore,
  chatStore,
  filesStore,
  providersStore,
  reviewStore as defaultReviewStore,
  workingTreeSummaryStore as defaultWorkingTreeSummaryStore,
} from "../../store/appStore";
import { providerModelKey, type ChatState } from "../../chat/store";
import type {
  WorkingTreeSummary,
  WorkingTreeSummaryState,
} from "../../chat/working-tree";
import type { ReviewState } from "../../store/review";
import { DEFAULT_TITLE } from "../../chat/model";
import { clearChatDropTarget, setChatDropTarget } from "../../chat/drop-target";
import type { ProjectsState } from "../../store/projects";
import { isChatSession } from "../../store/projects";
import type { ProvidersState } from "../../providers/store";
import { AVAILABLE_PROVIDERS, isOllamaChat } from "../../providers/catalog";
import { buildRemoteProgramLaunch } from "../../ssh/command";
import {
  remoteSessionBase,
  remoteTargetForProjectId,
} from "../../ssh/model";

// Falls back only when a thread's own provider can't be determined; the
// user's chosen default (settings) drives NEW threads.
const FALLBACK_PROVIDER_ID = "claude";

export function ChatPane({
  projectsStore = appStore,
  chatThreadsStore = chatStore,
  providers = providersStore,
  review = defaultReviewStore,
  workingTree = defaultWorkingTreeSummaryStore,
  terminalRegistry,
}: {
  projectsStore?: StoreApi<ProjectsState>;
  chatThreadsStore?: StoreApi<ChatState>;
  providers?: StoreApi<ProvidersState>;
  review?: StoreApi<ReviewState>;
  workingTree?: StoreApi<WorkingTreeSummaryState>;
  terminalRegistry?: TerminalDisplayRegistry;
} = {}) {
  // Terminal visibility belongs to the chat that owns the PTY. Switching
  // threads must never reveal another thread's shell below the transcript.
  const [terminalOpenByThread, setTerminalOpenByThread] = useState<Record<string, boolean>>({});
  // Files dropped on the pane, waiting to ride along with the next message.
  const [attachments, setAttachments] = useState<string[]>([]);
  // Composer drafts are transient, but owned by the thread they belong to.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const dropRegion = useRef<HTMLDivElement | null>(null);
  const activeProjectId = useStore(projectsStore, (s) => s.activeProjectId);
  const sessions = useStore(projectsStore, (s) => s.sessions);
  const remoteTargets = useStore(projectsStore, (s) => s.remoteTargets);
  const activeSessionId = useStore(projectsStore, (s) =>
    s.activeProjectId ? (s.activeSessionByProject[s.activeProjectId] ?? null) : null,
  );
  const threads = useStore(chatThreadsStore, (s) => s.threads);
  const ollama = useStore(chatThreadsStore, (s) => s.ollama);
  const providerModels = useStore(chatThreadsStore, (s) => s.providerModels);
  const catalog = useStore(providers, (s) => s.providers);
  const summaryProjectRoot = useStore(workingTree, (s) => s.projectRoot);
  const workingTreeSummary = useStore(workingTree, (s) => s.summary);
  const summaryLoading = useStore(workingTree, (s) => s.loading);
  const summaryLoaded = useStore(workingTree, (s) => s.loaded);
  const summaryError = useStore(workingTree, (s) => s.error);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const owningChat =
    activeSession && !isChatSession(activeSession) && activeSession.workspaceId
      ? (sessions.find(
          (session) =>
            session.projectId === activeSession.projectId &&
            session.id === activeSession.workspaceId &&
            isChatSession(session),
        ) ?? null)
      : null;
  const activeChat =
    activeSession && isChatSession(activeSession) ? activeSession : owningChat;
  const threadId = activeChat?.id ?? null;
  const thread = threadId ? (threads[threadId] ?? null) : null;
  const terminalOpen = threadId ? (terminalOpenByThread[threadId] ?? false) : false;
  const activeProjectIsRemote = activeProjectId
    ? remoteTargetForProjectId(remoteTargets, activeProjectId) !== null
    : false;

  // A generic terminal creator selects the new PTY as part of its lifecycle.
  // If that child belongs to a local chat, repair the selection immediately;
  // the render below already uses the owner so no full-pane terminal flashes.
  useEffect(() => {
    if (!activeProjectId || !owningChat || activeSessionId === owningChat.id) return;
    projectsStore.getState().setActiveSession(activeProjectId, owningChat.id);
  }, [activeProjectId, activeSessionId, owningChat, projectsStore]);

  // Register + lazily load the transcript whenever a chat thread is selected.
  useEffect(() => {
    if (!threadId || !activeProjectId) return;
    void chatThreadsStore
      .getState()
      .openThread(threadId, activeProjectId, providerForSession(activeChat));
  }, [activeChat, activeProjectId, chatThreadsStore, threadId]);

  // Once a turn settles, refresh KödChat's dedicated read-only projection.
  // This reports the workspace's current diff, not agent attribution, and
  // cannot disturb whichever branch/PR scope the user left open in KödPR.
  useEffect(() => {
    if (!thread || thread.status !== "idle" || thread.entries.length === 0) return;
    const root = filesStore.getState().rootPath;
    if (!root) return;
    void workingTree.getState().load(root);
  }, [workingTree, thread?.entries.length, thread?.id, thread?.status, thread?.updatedAt]);

  const showWorkingTreeSummary =
    !!thread &&
    thread.status === "idle" &&
    summaryProjectRoot === filesStore.getState().rootPath &&
    summaryLoaded &&
    !summaryLoading &&
    !summaryError &&
    !!workingTreeSummary &&
    workingTreeSummary.files > 0;

  const providerList = useMemo(
    () => (catalog.length > 0 ? catalog : AVAILABLE_PROVIDERS),
    [catalog],
  );

  // Register the chat column as a drop target so dropped files become
  // attachments (drop-routing.ts). Re-registered per thread; attachments are
  // per-composer, so switching threads clears them.
  useEffect(() => {
    setAttachments([]);
    const element = dropRegion.current;
    if (!element || !threadId) return;
    setChatDropTarget(element, (paths) => {
      setAttachments((current) => [
        ...current,
        ...paths.filter((path) => !current.includes(path)),
      ]);
    });
    return () => clearChatDropTarget(element);
  }, [threadId]);

  const title = thread ? `KödChat — ${thread.title}` : "KödChat";

  const toggleTerminal = () => {
    if (!activeProjectId || !threadId) return;
    if (terminalOpen) {
      setTerminalOpenByThread((current) => ({ ...current, [threadId]: false }));
      return;
    }

    const state = projectsStore.getState();
    const existing = state.sessions.find(
      (session) =>
        session.projectId === activeProjectId &&
        !isChatSession(session) &&
        session.workspaceId === threadId,
    );
    if (!existing) state.addTerminal(activeProjectId, threadId);
    // addTerminal selects the new PTY by default. This terminal is embedded
    // in the thread, so keep the chat selected and visible above it.
    projectsStore.getState().setActiveSession(activeProjectId, threadId);
    setTerminalOpenByThread((current) => ({ ...current, [threadId]: true }));
  };

  // Pinned SSH projects keep their standalone terminal workflow. Local PTYs
  // are never root workspaces in the chat-first app, including stale/unowned
  // selections that bypassed the store's navigation guard.
  if (activeSession && !isChatSession(activeSession) && activeProjectIsRemote) {
    return (
      <TerminalPane
        projectsStore={projectsStore}
        terminalRegistry={terminalRegistry}
      />
    );
  }

  const chatSurface = (
    <div ref={dropRegion} className="flex h-full min-h-0 flex-col">
          {!activeProjectId ? (
            <EmptyWorkspace />
          ) : !thread ? (
            <NoThreadSelected
              onNewChat={() => startThread(projectsStore, activeProjectId)}
            />
          ) : (
            <>
              <div className="min-h-0 flex-1">
                <ChatTranscript
                  thread={thread}
                  onOpenLink={(url) => {
                    filesStore.getState().openBrowserTab();
                    filesStore.getState().setBrowserUrl(url);
                  }}
                  onOpenLoginTerminal={() => {
                    if (!threadId) return;
                    setTerminalOpenByThread((current) => ({ ...current, [threadId]: true }));
                    void openLoginTerminal(projectsStore, thread.providerId);
                  }}
                />
              </div>
              {showWorkingTreeSummary && (
                <EditedFilesCard
                  summary={workingTreeSummary}
                  onReview={() => {
                    const root = filesStore.getState().rootPath;
                    if (!root) return;
                    void review.getState().openWorktree(root);
                    filesStore.getState().openReviewTab();
                  }}
                />
              )}
              <ChatComposer
                providers={providerList}
                providerId={thread.providerId}
                model={thread.model}
                access={thread.access}
                thinking={thread.thinking}
                speed={thread.speed}
                ollama={ollama}
                providerModels={
                  activeProjectIsRemote || !activeProjectId
                    ? undefined
                    : providerModels[providerModelKey(thread.providerId, activeProjectId)]
                }
                attachments={attachments}
                draft={drafts[thread.id] ?? ""}
                working={thread.status === "working"}
                onProviderChange={(id) =>
                  chatThreadsStore.getState().setProvider(thread.id, id)
                }
                onModelChange={(model) =>
                  chatThreadsStore.getState().setModel(thread.id, model)
                }
                onAccessChange={(access) =>
                  chatThreadsStore.getState().setAccess(thread.id, access)
                }
                onThinkingChange={(thinking) =>
                  chatThreadsStore.getState().setThinking(thread.id, thinking)
                }
                onSpeedChange={(speed) =>
                  chatThreadsStore.getState().setSpeed(thread.id, speed)
                }
                onRemoveAttachment={(path) =>
                  setAttachments((current) => current.filter((entry) => entry !== path))
                }
                onDraftChange={(draft) =>
                  setDrafts((current) => ({ ...current, [thread.id]: draft }))
                }
                onSend={(text) => {
                  setAttachments([]);
                  setDrafts((current) => ({ ...current, [thread.id]: "" }));
                  // Captured BEFORE send: only the FIRST message titles the
                  // thread, so later turns never re-push a stale title over a
                  // manual rename.
                  const firstMessage = !thread.entries.some(
                    (entry) => entry.kind === "message",
                  );
                  void chatThreadsStore
                    .getState()
                    .send(
                      thread.id,
                      isOllamaChat(providerList.find((provider) => provider.id === thread.providerId))
                        ? text
                        : withAttachments(text, attachments),
                    )
                    .then(() => {
                      // The first user message becomes the thread's sidebar
                      // name. This is the only place transcript-derived text
                      // leaves the chat store, and it stops at the projects
                      // store — renameSession emits no Activity fact, so
                      // KödMem never sees it.
                      if (!firstMessage) return;
                      const session = projectsStore
                        .getState()
                        .sessions.find((entry) => entry.id === thread.id);
                      // A manual rename locks the name; never overwrite it.
                      if (session?.nameLocked) return;
                      const title = chatThreadsStore.getState().threads[thread.id]?.title;
                      if (title && title !== DEFAULT_TITLE) {
                        projectsStore.getState().renameSession(thread.id, title);
                      }
                    });
                }}
                onCancel={() => void chatThreadsStore.getState().cancel(thread.id)}
                onRefreshOllama={() =>
                  void chatThreadsStore.getState().refreshOllama()
                }
                onRefreshProviderModels={() =>
                  activeProjectId
                    ? void chatThreadsStore
                        .getState()
                        .refreshProviderModels(thread.providerId, activeProjectId)
                    : undefined
                }
              />
            </>
          )}
    </div>
  );

  return (
    <Pane
      title={title}
      className="bg-bg"
      headerAction={
        <TerminalToggle
          open={terminalOpen}
          disabled={!threadId}
          onToggle={toggleTerminal}
        />
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {terminalOpen ? (
          // This nested group is intentionally transient. Root pane sizes have
          // a durable four-slot contract; a thread-local split must not alter it.
          <Group
            id="chat-terminal-group"
            orientation="vertical"
            defaultLayout={{ chat: 55, terminal: 45 }}
            className="min-h-0 flex-1"
          >
            <Panel id="chat" minSize="30%" className="min-h-0">
              {chatSurface}
            </Panel>
            <Separator
              id="chat-terminal-resize-handle"
              aria-label="Resize chat and terminal"
              className="group relative h-2 shrink-0 cursor-row-resize focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <span
                data-testid="chat-terminal-resize-line"
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
              />
            </Separator>
            <Panel id="terminal" minSize="20%" className="min-h-0">
              <div data-testid="chat-terminal-split" className="h-full min-h-0">
                <TerminalPane
                  projectsStore={projectsStore}
                  terminalRegistry={terminalRegistry}
                  workspaceId={threadId ?? undefined}
                />
              </div>
            </Panel>
          </Group>
        ) : (
          chatSurface
        )}
      </div>
    </Pane>
  );
}

function EditedFilesCard({
  summary,
  onReview,
}: {
  summary: WorkingTreeSummary;
  onReview(): void;
}) {
  return (
    <button
      type="button"
      data-testid="chat-edited-files"
      onClick={onReview}
      aria-label="Review current working-tree changes"
      className="group mx-3 mb-2 flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2 text-left text-xs hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
    >
      <span data-testid="chat-edited-files-copy" className="min-w-0">
        <span className="block text-text">
          Edited {summary.files} file{summary.files === 1 ? "" : "s"}
        </span>
        <span className="mt-0.5 block text-[11px] text-text-dim">
          Current working tree ·{" "}
          <span data-testid="chat-additions" className="text-[var(--kd-success)]">
            +{summary.adds}
          </span>{" "}
          <span data-testid="chat-deletions" className="text-[var(--kd-error)]">
            −{summary.dels}
          </span>
        </span>
      </span>
      <span
        data-testid="chat-review-affordance"
        className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-text-dim group-hover:text-text"
      >
        Review
      </span>
    </button>
  );
}

// Attached paths ride inside the prompt: agent CLIs take no file arguments in
// headless mode, but every one of them can Read a path it is told about.
function withAttachments(text: string, attachments: string[]): string {
  if (attachments.length === 0) return text;
  const list = attachments.map((path) => `- ${path}`).join("\n");
  const body = text.trim();
  return `${body ? `${body}\n\n` : ""}Attached files (read them as needed):\n${list}`;
}

// A chat session's provider comes from its name ("claude 1"), the same
// creation-time convention the terminal launcher uses.
function providerForSession(session: { name: string } | null): string {
  if (!session) return FALLBACK_PROVIDER_ID;
  const base = session.name.replace(/\s+\d+$/, "");
  return AVAILABLE_PROVIDERS.some((provider) => provider.id === base)
    ? base
    : FALLBACK_PROVIDER_ID;
}

function startThread(store: StoreApi<ProjectsState>, projectId: string): void {
  store.getState().addChatThread(projectId, store.getState().chatProvider);
}

// The auth escape hatch: open a real terminal running the provider's own login
// flow. Kodade wraps that flow; it never sees or stores the credential.
async function openLoginTerminal(
  store: StoreApi<ProjectsState>,
  providerId: string,
): Promise<void> {
  const provider = AVAILABLE_PROVIDERS.find(
    (candidate) => candidate.id === providerId,
  );
  if (!provider) return;
  try {
    const state = store.getState();
    const target = state.activeProjectId
      ? remoteTargetForProjectId(state.remoteTargets, state.activeProjectId)
      : null;
    await state.launchInSession(
      target
        ? buildRemoteProgramLaunch(
            provider.remote?.launch ?? provider.launch,
          )
        : provider.launch,
      target ? remoteSessionBase(provider.id) : provider.id,
    );
  } catch (error) {
    console.error("kodade: KödChat login terminal failed", error);
  }
}

function TerminalToggle({
  open,
  disabled = false,
  onToggle,
}: {
  open: boolean;
  disabled?: boolean;
  onToggle(): void;
}) {
  const label = open ? "Hide terminal" : "Show terminal";
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={open}
      aria-label={label}
      title={label}
      className="flex h-7 items-center gap-1.5 rounded px-1.5 text-[10px] tracking-[0.12em] text-text-dim hover:bg-surface hover:text-text focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="2" y="2.5" width="12" height="11" rx="1" />
        <path d="M2 9h12" />
      </svg>
      {label}
    </button>
  );
}

function EmptyWorkspace() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center text-center text-text">
        <KodadeMark size={16} />
        <KodadeWordmark className="mt-3 text-lg" />
        <p className="mt-4 text-sm text-text-dim">Add a project to start a chat</p>
      </div>
    </div>
  );
}

function NoThreadSelected({ onNewChat }: { onNewChat(): void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-text-dim">Send a message to start the conversation.</p>
      <button
        type="button"
        onClick={onNewChat}
        className="rounded border border-border px-2.5 py-1 text-xs text-text hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
      >
        New chat
      </button>
    </div>
  );
}
