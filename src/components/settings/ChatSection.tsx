// KödChat settings: which CLIs can answer a chat thread, whether they're
// installed and signed in, and which one new threads start on.
//
// The login button is the same affordance as the transcript's auth card: it
// opens a real terminal running the provider's own login command. Kodade wraps
// that flow and never sees or stores the credential.

import { useStore } from "zustand";
import { appStore, chatStore, providersStore } from "../../store/appStore";
import type { ChatState } from "../../chat/store";
import type { StoreApi } from "zustand/vanilla";
import { isChatSession } from "../../store/projects";
import {
  AVAILABLE_PROVIDERS,
  isOllamaChat,
  supportsChat,
} from "../../providers/catalog";
import { SettingsCard, SettingsRow } from "./SettingsCard";

export function ChatSection({
  onLogin = (launch, providerId) =>
    appStore
      .getState()
      .launchInSession(launch, providerId)
      .catch((error) => {
        console.error("kodade: KödChat login terminal failed", error);
      }),
  onRefresh = () => providersStore.getState().detectAll(),
  chatThreadsStore = chatStore,
}: {
  onLogin?: (launch: string, providerId: string) => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  chatThreadsStore?: StoreApi<ChatState>;
} = {}) {
  const statuses = useStore(providersStore, (state) => state.statuses);
  const detecting = useStore(providersStore, (state) => state.detecting);
  const chatProvider = useStore(appStore, (state) => state.chatProvider);
  const activeProjectId = useStore(appStore, (state) => state.activeProjectId);
  const hasActiveChat = useStore(appStore, (state) => {
    const projectId = state.activeProjectId;
    if (!projectId) return false;
    const sessionId = state.activeSessionByProject[projectId];
    return state.sessions.some(
      (session) =>
        session.id === sessionId &&
        session.projectId === projectId &&
        isChatSession(session),
    );
  });
  const ollama = useStore(chatThreadsStore, (state) => state.ollama);

  const chatProviders = AVAILABLE_PROVIDERS.filter(supportsChat);

  return (
    <div className="space-y-4 text-xs">
      <SettingsCard
        title="agents that can chat"
        action={
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={detecting}
            title="Re-check installed agent CLIs"
            className="rounded px-2 py-1 text-[10px] text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
          >
            {detecting ? "checking…" : "refresh agents"}
          </button>
        }
      >
        {AVAILABLE_PROVIDERS.map((provider) => {
          const capable = supportsChat(provider);
          const ollamaChat = isOllamaChat(provider);
          const status = statuses[provider.id] ?? {
            status: "unknown" as const,
            version: null,
          };
          const installed = status.status === "installed";
          return (
            <SettingsRow
              key={provider.id}
              name={provider.name}
              description={
                ollamaChat
                  ? ollama.status === "ready"
                    ? ollama.models.length
                      ? `${ollama.models.length} local model${ollama.models.length === 1 ? "" : "s"} available`
                      : "Ollama is running, but no local models are installed yet"
                    : ollama.status === "loading"
                      ? "Checking 127.0.0.1:11434…"
                      : (ollama.message ?? "Ollama is not running on this Mac")
                  : capable
                  ? installed
                    ? `Installed${status.version ? ` · ${status.version}` : ""}`
                    : status.status === "unknown"
                      ? detecting
                        ? "Checking…"
                        : "Not detected yet"
                      : "Not installed"
                  : "Not yet supported in KödChat — available in a terminal."
              }
            >
              {ollamaChat ? (
                <div className="flex max-w-52 flex-col items-end gap-1">
                  <span className="flex items-center gap-2">
                    {ollama.status !== "ready" && ollama.status !== "loading" && (
                      <button
                        type="button"
                        onClick={() => {
                          void Promise.resolve()
                            .then(() => onLogin("ollama serve", provider.id))
                            .then(() => chatThreadsStore.getState().refreshOllama())
                            .catch((error) => {
                              console.error("kodade: Ollama start terminal failed", error);
                            });
                        }}
                        disabled={!hasActiveChat}
                        aria-describedby={
                          hasActiveChat ? undefined : `chat-login-guidance-${provider.id}`
                        }
                        title={
                          hasActiveChat
                            ? "Open a terminal to start Ollama"
                            : activeProjectId
                              ? "Select a KödChat thread first"
                              : "Open a project and select a KödChat thread first"
                        }
                        className="rounded border border-border px-2 py-1 text-text hover:bg-surface-hover disabled:opacity-40"
                      >
                        start Ollama
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void chatThreadsStore.getState().refreshOllama()
                      }
                      disabled={ollama.status === "loading"}
                      className="rounded border border-border px-2 py-1 text-text hover:bg-surface-hover disabled:opacity-40"
                    >
                      refresh models
                    </button>
                    <a
                      href={provider.install}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-accent hover:underline"
                    >
                      install
                    </a>
                  </span>
                  {!hasActiveChat &&
                    ollama.status !== "ready" &&
                    ollama.status !== "loading" && (
                      <span
                        id={`chat-login-guidance-${provider.id}`}
                        className="text-right text-[10px] text-text-dim"
                      >
                        {activeProjectId
                          ? "Select a KödChat thread before opening an Ollama terminal."
                          : "Open a project and select a KödChat thread before opening an Ollama terminal."}
                      </span>
                    )}
                </div>
              ) : capable && installed ? (
                <div className="flex max-w-52 flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={() => onLogin(provider.launch, provider.id)}
                    disabled={!hasActiveChat}
                    aria-describedby={
                      hasActiveChat ? undefined : `chat-login-guidance-${provider.id}`
                    }
                    title={
                      hasActiveChat
                        ? `Open a terminal running ${provider.launch}`
                        : activeProjectId
                          ? "Select a KödChat thread first"
                          : "Open a project and select a KödChat thread first"
                    }
                    className="rounded border border-border px-2 py-1 text-text hover:bg-surface-hover disabled:opacity-40"
                  >
                    open a terminal to log in
                  </button>
                  {!hasActiveChat && (
                    <span
                      id={`chat-login-guidance-${provider.id}`}
                      className="text-right text-[10px] text-text-dim"
                    >
                      {activeProjectId
                        ? "Select a KödChat thread before opening a login terminal."
                        : "Open a project and select a KödChat thread before opening a login terminal."}
                    </span>
                  )}
                </div>
              ) : (
                <span
                  data-testid={capable ? undefined : "chat-unsupported"}
                  className="text-[10px] text-text-dim opacity-70"
                >
                  {capable ? "—" : "terminal only"}
                </span>
              )}
            </SettingsRow>
          );
        })}
      </SettingsCard>

      <SettingsCard title="new chats">
        <SettingsRow
          name="Default provider"
          description="Which agent a new KödChat thread starts on. Existing threads keep the provider they were created with."
        >
          <select
            aria-label="Default provider for new chats"
            value={chatProvider}
            onChange={(event) =>
              appStore.getState().setChatProvider(event.target.value)
            }
            className="rounded border border-border bg-bg px-1.5 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {chatProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsCard>

      <p className="px-1 text-[11px] text-text-dim">
        KödChat runs CLI agents headlessly and reads their structured output.
        Each thread's access level — picked in the composer, from plan-only to
        full access — controls what a turn may read, edit, and run. Turns
        inherit the sign-in you already did in that CLI. Ollama is different:
        it uses only your local HTTP chat service and cannot read files or run tools.
      </p>
    </div>
  );
}
