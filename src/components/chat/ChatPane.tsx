// KödChat: the workspace's primary agent surface (panel 2 in App.tsx).
//
// The terminal is not gone — it moved. A header toggle opens a horizontal
// split at the bottom that hosts the EXISTING TerminalPane unchanged, so the
// registry keeps owning its xterm hosts and a live shell is never reparented.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Pane } from "../Pane";
import { KodadeMark, KodadeWordmark } from "../KodadeBrand";
import { TerminalPane } from "../TerminalPane";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript } from "./ChatTranscript";
import { appStore, chatStore, providersStore } from "../../store/appStore";
import type { ChatState } from "../../chat/store";
import { clearChatDropTarget, setChatDropTarget } from "../../chat/drop-target";
import type { ProjectsState } from "../../store/projects";
import { isChatSession } from "../../store/projects";
import type { ProvidersState } from "../../providers/store";
import { AVAILABLE_PROVIDERS } from "../../providers/catalog";
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
}: {
  projectsStore?: StoreApi<ProjectsState>;
  chatThreadsStore?: StoreApi<ChatState>;
  providers?: StoreApi<ProvidersState>;
} = {}) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Files dropped on the pane, waiting to ride along with the next message.
  const [attachments, setAttachments] = useState<string[]>([]);
  const dropRegion = useRef<HTMLDivElement | null>(null);
  const activeProjectId = useStore(projectsStore, (s) => s.activeProjectId);
  const sessions = useStore(projectsStore, (s) => s.sessions);
  const activeSessionId = useStore(projectsStore, (s) =>
    s.activeProjectId ? (s.activeSessionByProject[s.activeProjectId] ?? null) : null,
  );
  const threads = useStore(chatThreadsStore, (s) => s.threads);
  const catalog = useStore(providers, (s) => s.providers);

  // The selected session is a chat thread only when it was created as one.
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const threadId = activeSession && isChatSession(activeSession) ? activeSession.id : null;
  const thread = threadId ? (threads[threadId] ?? null) : null;

  // Register + lazily load the transcript whenever a chat thread is selected.
  useEffect(() => {
    if (!threadId || !activeProjectId) return;
    void chatThreadsStore
      .getState()
      .openThread(threadId, activeProjectId, providerForSession(activeSession));
  }, [activeProjectId, activeSession, chatThreadsStore, threadId]);

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

  // A terminal row is a distinct project child, not a chat with a terminal
  // attached. Selecting it should therefore use the full work pane for the
  // terminal instead of leaving an empty KödChat surface above it.
  if (activeSession && !isChatSession(activeSession)) {
    return <TerminalPane projectsStore={projectsStore} />;
  }

  return (
    <Pane
      title={title}
      className="bg-bg"
      headerAction={
        <TerminalToggle open={terminalOpen} onToggle={() => setTerminalOpen((v) => !v)} />
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div ref={dropRegion} className="flex min-h-0 flex-1 flex-col">
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
                  onOpenLoginTerminal={() => {
                    setTerminalOpen(true);
                    void openLoginTerminal(projectsStore, thread.providerId);
                  }}
                />
              </div>
              <ChatComposer
                providers={providerList}
                providerId={thread.providerId}
                model={thread.model}
                access={thread.access}
                attachments={attachments}
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
                onRemoveAttachment={(path) =>
                  setAttachments((current) => current.filter((entry) => entry !== path))
                }
                onSend={(text) => {
                  setAttachments([]);
                  void chatThreadsStore
                    .getState()
                    .send(thread.id, withAttachments(text, attachments))
                    .then(() => {
                      // The first user message becomes the thread's sidebar
                      // name. This is the only place transcript-derived text
                      // leaves the chat store, and it stops at the projects
                      // store — renameSession emits no Activity fact, so
                      // KödMem never sees it.
                      const title = chatThreadsStore.getState().threads[thread.id]?.title;
                      if (title) projectsStore.getState().renameSession(thread.id, title);
                    });
                }}
                onCancel={() => void chatThreadsStore.getState().cancel(thread.id)}
              />
            </>
          )}
        </div>
        {terminalOpen && (
          // The full terminal system, unchanged, in the bottom half. Mounting
          // the real TerminalPane keeps the session registry the sole owner of
          // every xterm host — nothing here rebuilds or reparents one.
          <div
            data-testid="chat-terminal-split"
            className="h-1/2 min-h-0 shrink-0 border-t border-border"
          >
            <TerminalPane />
          </div>
        )}
      </div>
    </Pane>
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
  onToggle,
}: {
  open: boolean;
  onToggle(): void;
}) {
  const label = open ? "Hide terminal" : "Show terminal";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      aria-label={label}
      title={label}
      className="flex h-7 items-center gap-1.5 rounded px-1.5 text-[10px] tracking-[0.12em] text-text-dim hover:bg-surface hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
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
