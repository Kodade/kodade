// Provider detection + launch store (Zustand vanilla, headless-testable).
// Deps are injected — the detection IPC and a launch callback — so tests drive
// it against mocks. Detection runs once at app start (see appStore.initApp)
// and on an explicit refresh; results are cached in this store.

import { createStore } from "zustand/vanilla";
import type { LocalIpc, ProviderIpc } from "../ipc/contract";
import { FEATURES } from "../license/features";
import {
  DEFAULT_LOCAL_ENDPOINT,
  normalizeEndpointBaseURL,
  type LocalBackendOption,
} from "../local/models";
import { PROVIDERS, versionToken, type Provider } from "./catalog";

// A provider's live detection result. `version` is the short token when
// installed; null status means "not installed" (or detection failed/errored).
export type ProviderStatus = {
  status: "unknown" | "installed" | "missing";
  version: string | null;
};

// Launches a CLI: opens a provider-named session in the active project and
// types the command in. Injected so the store never imports the projects store
// directly (keeps the dependency one-way and the store unit-testable).
export type LaunchFn = (command: string, base: string) => Promise<void>;

export type ProviderLaunchOptions = {
  // Chosen afresh for this terminal only. It deliberately does not update
  // persisted preferences, so one session cannot reroute another.
  localBackend?: LocalBackendOption;
};

export type ProviderDeps = {
  ipc: ProviderIpc;
  // KödLocal detection needs more than a PATH probe: Node launches the CLI,
  // while a bundled/reachable model daemon makes the provider usable.
  local?: Pick<LocalIpc, "start" | "status">;
  launch: LaunchFn;
  // Defaults closed when omitted so a caller cannot accidentally expose a Pro
  // backend by constructing the store without the real entitlement selector.
  hasFeature?: (feature: string) => boolean;
  providers?: Provider[]; // overridable for tests; defaults to the full catalog
  // Desktop has bundled KödLocal helpers; KödSSH targets instead need the
  // user's `kodade-local` CLI on their own PATH.
  isDesktop?: boolean;
  // The active KödSSH project also uses the remote CLI path even though the
  // Kodade UI itself is the desktop build.
  isRemoteProject?: () => boolean;
};

export type ProvidersState = {
  providers: Provider[];
  statuses: Record<string, ProviderStatus>; // keyed by provider id
  detecting: boolean;
  launchingProviderId: string | null;
  launchError: string | null;

  detectAll(): Promise<void>;
  launch(id: string, options?: ProviderLaunchOptions): Promise<void>;
};

export function createProvidersStore(deps: ProviderDeps) {
  const providers = deps.providers ?? PROVIDERS;
  const isDesktop = deps.isDesktop ?? true;
  const hasFeature = deps.hasFeature ?? (() => false);
  // Monotonic run token: only the NEWEST detection pass may publish results,
  // so a slow older run can't overwrite a fresher one or clear `detecting`.
  let detectRun = 0;

  return createStore<ProvidersState>((set, get) => ({
    providers,
    // Everything starts "unknown" until the first detection pass resolves.
    statuses: Object.fromEntries(
      providers.map((p) => [
        p.id,
        { status: "unknown", version: null } as ProviderStatus,
      ]),
    ),
    detecting: false,
    launchingProviderId: null,
    launchError: null,

    // Probe every provider concurrently and cache the results. Called once at
    // startup and again on a manual refresh; a probe that throws is treated as
    // "missing" so one broken CLI can't stall the Settings surface.
    async detectAll() {
      const run = ++detectRun;
      set({ detecting: true });
      const results = await Promise.all(
        providers.map(async (p): Promise<[string, ProviderStatus]> => {
          try {
            const bin = !isDesktop && p.remote ? p.remote.bin : p.bin;
            const raw = await deps.ipc.detect(bin);
            if (p.id === "kodade-local") {
              if (!isDesktop) {
                return raw
                  ? [p.id, { status: "installed", version: versionToken(raw) }]
                  : [p.id, { status: "missing", version: null }];
              }
              const daemon = await deps.local?.status();
              const usableDaemon =
                (daemon?.running || daemon?.binaryPath) && daemon?.cliPath;
              return raw && usableDaemon
                ? [
                    p.id,
                    {
                      status: "installed",
                      version: `node ${versionToken(raw)}`,
                    },
                  ]
                : [p.id, { status: "missing", version: null }];
            }
            return raw
              ? [p.id, { status: "installed", version: versionToken(raw) }]
              : [p.id, { status: "missing", version: null }];
          } catch {
            return [p.id, { status: "missing", version: null }];
          }
        }),
      );
      if (run !== detectRun) return; // superseded by a newer run
      set({ statuses: Object.fromEntries(results), detecting: false });
    },

    // One-click launch. Only launches a provider detected as installed —
    // clicking a missing one is a no-op here (the UI shows the not-installed
    // state); this guards against launching a CLI that isn't on PATH.
    async launch(id: string, options?: ProviderLaunchOptions) {
      const provider = get().providers.find((p) => p.id === id);
      if (!provider) return;
      if (get().statuses[id]?.status !== "installed") return;
      const selectedLocalBackend =
        provider.id === "kodade-local"
          ? (options?.localBackend ?? DEFAULT_LOCAL_ENDPOINT)
          : null;
      if (
        selectedLocalBackend &&
        !selectedLocalBackend.local &&
        !hasFeature(FEATURES.localMultiBox)
      ) {
        set({
          launchingProviderId: null,
          launchError:
            "Remote KödLocal backends require Ködade Pro (local.multibox).",
        });
        return;
      }
      set({ launchingProviderId: id, launchError: null });
      try {
        if (provider.id === "kodade-local") {
          const selected = selectedLocalBackend ?? DEFAULT_LOCAL_ENDPOINT;
          const baseURL = normalizeEndpointBaseURL(selected.baseURL);
          if (!baseURL) throw new Error("KödLocal backend URL is invalid");

          let command: string;
          if (!isDesktop || deps.isRemoteProject?.()) {
            const remoteLaunch = provider.remote?.launch ?? provider.launch;
            command = `${remoteLaunch} --base-url ${quoteForTerminal(baseURL)}`;
          } else {
            const current = await deps.local?.status();
            const daemon = selected.local
              ? current?.running
                ? current
                : await deps.local?.start()
              : current;
            if (!daemon?.cliPath)
              throw new Error("KödLocal chat CLI bundle was not found");
            const resolvedBaseURL = selected.local
              ? `http://127.0.0.1:${daemon.port}`
              : baseURL;
            command = `node ${quoteForTerminal(daemon.cliPath)} --base-url ${quoteForTerminal(resolvedBaseURL)}`;
          }
          await deps.launch(command, provider.id);
        } else {
          await deps.launch(provider.launch, provider.id);
        }
        set({ launchingProviderId: null });
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "";
        set({
          launchingProviderId: null,
          launchError:
            provider.id === "kodade-local" && detail
              ? `Could not start ${provider.name}. ${detail}`
              : `Could not start ${provider.name}. Try again or open a terminal and run ${provider.launch}.`,
        });
      }
    },
  }));
}

// PTY launches are typed into the user's login shell. Double quotes preserve
// normal app paths (including spaces); quote the only interpolation character
// so a deliberately unusual install path cannot alter the command.
function quoteForTerminal(path: string): string {
  return `"${path.replace(/([\\"`$])/g, "\\$1")}"`;
}
