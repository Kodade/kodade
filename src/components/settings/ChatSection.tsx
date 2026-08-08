// KödChat settings: which CLIs can answer a chat thread, whether they're
// installed and signed in, and which one new threads start on.
//
// The login button is the same affordance as the transcript's auth card: it
// opens a real terminal running the provider's own login command. Kodade wraps
// that flow and never sees or stores the credential.

import { useStore } from "zustand";
import { appStore, providersStore } from "../../store/appStore";
import { isChatSession } from "../../store/projects";
import {
  AVAILABLE_PROVIDERS,
  supportsChat,
} from "../../providers/catalog";
import { SettingsCard, SettingsRow } from "./SettingsCard";

export function ChatSection({
  onLogin = (launch, providerId) =>
    void appStore
      .getState()
      .launchInSession(launch, providerId)
      .catch((error) => {
        console.error("kodade: KödChat login terminal failed", error);
      }),
}: {
  onLogin?: (launch: string, providerId: string) => void;
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

  const chatProviders = AVAILABLE_PROVIDERS.filter(supportsChat);

  return (
    <div className="space-y-4 text-xs">
      <SettingsCard title="agents that can chat">
        {AVAILABLE_PROVIDERS.map((provider) => {
          const capable = supportsChat(provider);
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
                capable
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
              {capable && installed ? (
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
        KödChat runs each turn headlessly and reads the CLI's structured output.
        Each thread's access level — picked in the composer, from plan-only to
        full access — controls what a turn may read, edit, and run. Turns
        inherit the sign-in you already did in that CLI.
      </p>
    </div>
  );
}
