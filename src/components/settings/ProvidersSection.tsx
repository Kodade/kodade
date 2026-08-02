// Providers: the installed agent CLIs, their versions, and one-click launch.
// Ported from the old title-bar settings popover — same store wiring, same
// launch guards, laid out for the full page.

import { useState } from "react";
import { useStore } from "zustand";
import {
  appStore,
  providersStore,
} from "../../store/appStore";
import { settingsViewStore } from "../../store/settingsView";
import { licenseStore } from "../../license";
import { FEATURES } from "../../license/features";
import { localBackendOptions } from "../../local/models";
import type { Provider } from "../../providers/catalog";
import type { ProviderLaunchOptions } from "../../providers/store";
import { SettingsCard } from "./SettingsCard";

export function ProvidersSection({
  onLaunch = (providerId, options) =>
    void providersStore.getState().launch(providerId, options),
  onManageHarness = () => settingsViewStore.getState().open("harness"),
}: {
  onLaunch?: (providerId: string, options?: ProviderLaunchOptions) => void;
  onManageHarness?: () => void;
} = {}) {
  const providers = useStore(providersStore, (state) => state.providers);
  const statuses = useStore(providersStore, (state) => state.statuses);
  const detecting = useStore(providersStore, (state) => state.detecting);
  const launchingProviderId = useStore(
    providersStore,
    (state) => state.launchingProviderId,
  );
  const launchError = useStore(providersStore, (state) => state.launchError);
  const hasProject = useStore(
    appStore,
    (state) => state.activeProjectId !== null,
  );

  return (
    <div className="space-y-4 text-xs">
      <SettingsCard>
        <div className="flex items-center justify-between px-4 py-2.5">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-text">agent CLIs</h3>
            <p className="mt-0.5 text-[11px] text-text-dim">
              Ködade launches the official CLIs you already have installed.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void providersStore.getState().detectAll()}
            disabled={detecting}
            title="Re-check installed agent CLIs"
            className="shrink-0 rounded px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
          >
            {detecting ? "checking…" : "refresh"}
          </button>
        </div>
        <div className="space-y-1.5 px-4 py-3">
          {providers.map((provider) => {
            const status = statuses[provider.id] ?? {
              status: "unknown" as const,
              version: null,
            };
            const content = (
              <>
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    status.status === "installed"
                      ? "bg-accent"
                      : "border border-text-dim opacity-60"
                  }`}
                />
                <span className="min-w-0 flex-1 text-text-dim">
                  {provider.name}
                </span>
                <span className="text-[10px] tabular-nums text-text-dim opacity-70">
                  {status.status === "installed"
                    ? status.version
                    : status.status === "unknown"
                      ? "checking…"
                      : "not installed"}
                </span>
              </>
            );
            if (status.status !== "installed") {
              return (
                <div
                  key={provider.id}
                  title={
                    status.status === "unknown"
                      ? `Checking for ${provider.name}…`
                      : `${provider.name} not installed — ${provider.install}`
                  }
                  className="flex items-center gap-2 rounded px-2 py-1"
                >
                  {content}
                </div>
              );
            }

            const launching = launchingProviderId === provider.id;
            if (provider.id === "kodade-local") {
              return (
                <LocalProviderLaunch
                  key={provider.id}
                  provider={provider}
                  launching={launching}
                  disabled={!hasProject || launchingProviderId !== null}
                  onLaunch={onLaunch}
                />
              );
            }
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => onLaunch(provider.id)}
                disabled={!hasProject || launchingProviderId !== null}
                title={
                  hasProject
                    ? `Start ${provider.name} in a new terminal`
                    : "Open a project first"
                }
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {content}
                <span className="text-[10px] text-accent">
                  {launching ? "starting…" : "start"}
                </span>
              </button>
            );
          })}
          {launchError && (
            <p
              role="alert"
              className="mt-2 rounded border border-border bg-bg px-2 py-1.5 text-[11px] text-text"
            >
              {launchError}
            </p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard>
        <div className="flex items-center justify-between gap-6 px-4 py-3">
          <div className="min-w-0">
            <div className="text-xs text-text">Project harness</div>
            <p className="mt-0.5 text-[11px] text-text-dim">
              See exactly what the agent CLIs read in this project.
            </p>
          </div>
          <button
            type="button"
            onClick={onManageHarness}
            disabled={!hasProject}
            title={
              hasProject
                ? "See what claude code reads in this project"
                : "Open a project first"
            }
            className="shrink-0 rounded border border-border px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            manage harness…
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}

// KödLocal launches with a per-session backend choice; saved LAN/remote
// endpoints stay behind the Pro gate.
function LocalProviderLaunch({
  provider,
  launching,
  disabled,
  onLaunch,
}: {
  provider: Provider;
  launching: boolean;
  disabled: boolean;
  onLaunch: (providerId: string, options?: ProviderLaunchOptions) => void;
}) {
  const preferences = useStore(
    appStore,
    (state) => state.localModelPreferences,
  );
  const hasMultiBox = useStore(licenseStore, (state) =>
    state.hasFeature(FEATURES.localMultiBox),
  );
  const endpoints = localBackendOptions(preferences, hasMultiBox);
  const [endpointId, setEndpointId] = useState("local");
  const endpoint =
    endpoints.find((candidate) => candidate.id === endpointId) ?? endpoints[0];

  return (
    <div className="rounded border border-border px-2 py-1.5">
      <div className="flex items-center gap-2 text-text-dim">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        />
        <span className="min-w-0 flex-1">{provider.name}</span>
        <span className="text-[10px] text-accent">
          {launching ? "starting…" : "ready"}
        </span>
      </div>
      <label className="mt-1 block text-[10px] text-text-dim">
        Backend for this session
        <select
          aria-label="KödLocal backend for this session"
          value={endpoint.id}
          onChange={(event) => setEndpointId(event.target.value)}
          disabled={disabled}
          className="mt-1 w-full rounded border border-border bg-bg px-1 py-1 text-text disabled:opacity-50"
        >
          {endpoints.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      {!endpoint.local && (
        <p role="note" className="mt-1 text-[10px] text-warning">
          Remote backend: your prompts, project context, and enabled agent
          requests leave this machine for {endpoint.label}.
        </p>
      )}
      {!hasMultiBox && (
        <p className="mt-1 text-[10px] text-text-dim">
          Saved LAN/remote backends require KödLocal Pro.
        </p>
      )}
      <button
        type="button"
        onClick={() => onLaunch(provider.id, { localBackend: endpoint })}
        disabled={disabled}
        title={
          disabled
            ? "Open a project first"
            : `Start ${provider.name} with ${endpoint.label}`
        }
        className="mt-1 w-full rounded px-1 py-1 text-left text-[10px] text-accent hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {launching ? "starting…" : "start KödLocal"}
      </button>
    </div>
  );
}
