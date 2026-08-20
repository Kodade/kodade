// KödSSH's "Remote" sidebar section: host list, ad-hoc connections, pinned
// host paths, remote provider detection, and one-click launches over
// ssh_exec, and launch them one click into a remote session — all gated behind
// entitlements.hasFeature("ssh.pro"), with an honest lock row for free users.
// Connecting/launching reuse launchInSession exactly like every other launcher.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import {
  appStore,
  chatStore as defaultChatStore,
  filesStore as defaultFilesStore,
  sshStore as defaultSshStore,
} from "../store/appStore";
import {
  isChatSession,
  type ProjectsState,
  type SessionMeta,
} from "../store/projects";
import type { ChatState } from "../chat/store";
import type { FilesState } from "../store/files";
import type { DetectionState, SshState } from "../store/ssh";
import {
  buildRemoteProgramLaunch,
  buildSshLaunch,
  buildSshProjectLaunch,
  parseAdHocHost,
} from "../ssh/command";
import {
  isRemoteSession,
  remoteProjectId,
  remoteSessionBase,
  remoteTargetKey,
  type RemoteTarget,
  type SshHost,
} from "../ssh/model";
import {
  remoteTargetLabels,
  type RemoteTargetLabel,
} from "../ssh/labels";
import { AVAILABLE_PROVIDERS } from "../providers/catalog";
import {
  entitlements as defaultEntitlements,
  type Entitlements,
} from "../app/entitlements";
import { licenseStore } from "../license";
import { FEATURES } from "../license/features";
import { localBackendOptions, type LocalBackendOption } from "../local/models";
import { ChatThreadRow } from "./chat/ChatThreadsSection";

export function RemoteHostsSection({
  entitlements = defaultEntitlements,
  sshStore = defaultSshStore,
  projectsStore = appStore,
  filesStore = defaultFilesStore,
  chatThreadsStore = defaultChatStore,
  projectTree = false,
}: {
  entitlements?: Entitlements;
  // Injectable stores (same DI shape as HarnessPane's `store` prop): tests
  // pass fakes instead of the real Tauri-backed singletons so connect flows
  // never touch actual ssh/PTY IPC.
  sshStore?: StoreApi<SshState>;
  projectsStore?: StoreApi<ProjectsState>;
  // Opens the remote-files tab (M11d) — injected so tests can assert the
  // "browse files" affordance without a real files store/editor pane.
  filesStore?: StoreApi<FilesState>;
  chatThreadsStore?: StoreApi<ChatState>;
  // The sidebar presents pins as project groups with nested sessions. Settings
  // keeps the denser host-management cards.
  projectTree?: boolean;
}) {
  const state = useStore(sshStore);
  const sessions = useStore(projectsStore, (s) => s.sessions);
  const activeProjectId = useStore(projectsStore, (s) => s.activeProjectId);
  const activeSessionByProject = useStore(
    projectsStore,
    (s) => s.activeSessionByProject,
  );
  const expandedProjects = useStore(
    projectsStore,
    (s) => s.expandedProjects,
  );
  const remoteTargets = useStore(projectsStore, (s) => s.remoteTargets);
  const threads = useStore(chatThreadsStore, (s) => s.threads);
  const localModelPreferences = useStore(
    projectsStore,
    (s) => s.localModelPreferences,
  );
  const [adHoc, setAdHoc] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const targetLabels = useMemo(
    () => remoteTargetLabels(remoteTargets),
    [remoteTargets],
  );

  // Lazy hydration: the store does nothing until this section first renders
  // (mirrors HarnessPane's own rescan-on-mount posture — M11a deliberately
  // shipped no auto-init).
  useEffect(() => {
    if (!projectTree && state.status === "idle")
      void sshStore.getState().init();
  }, [projectTree, sshStore, state.status]);

  const entitled = entitlements.hasFeature("ssh.pro");
  // KödSSH predates the signed-token selector and still receives its own
  // injected `ssh.pro` entitlement. Multi-backend is newer and must use the
  // real selector so a free user cannot bypass its gate through a manually
  // persisted endpoint record.
  const hasMultiBox = useStore(licenseStore, (state) =>
    state.hasFeature(FEATURES.localMultiBox),
  );
  const localBackends = localBackendOptions(localModelPreferences, hasMultiBox);

  // Detect agent CLIs on any pinned target that hasn't been probed yet (Pro).
  // Reading detections via getState() keeps this from re-firing every time a
  // probe result lands — it only runs when the pinned list changes.
  useEffect(() => {
    if (!entitled || projectTree) return;
    for (const target of remoteTargets) {
      if (!sshStore.getState().detections[remoteTargetKey(target)]) {
        void sshStore.getState().detectTarget(target);
      }
    }
  }, [entitled, projectTree, remoteTargets, sshStore]);

  // Free-tier cap. The counted unit is the OPEN remote TAB, not a live
  // connection: when ssh exits the user lands back in their local shell but
  // the session (tab) stays open — and stays counted — until it's closed.
  // The lock-row copy states exactly that. isRemoteSession uses the durable
  // marker (#121), so a manually renamed remote tab still counts.
  const countRemoteTabs = (all: SessionMeta[]) =>
    all.filter((s) => !s.exited && isRemoteSession(s)).length;
  const limited = !entitled && countRemoteTabs(sessions) >= 1;

  // Shared launcher: builds nothing itself — the caller passes a ready command —
  // but centralizes the active-project check, the free-tier cap re-check, and
  // error surfacing that every connect/launch path needs.
  const dispatch = async (
    command: string,
    base: string,
    countsAgainstFreeCap: boolean,
    projectId?: string,
  ): Promise<boolean> => {
    setConnectError(null);
    if (countsAgainstFreeCap && !entitled) {
      // Re-derive the count from the store at click time, not from the render
      // closure — two rapid clicks in the same frame must not both slip past
      // the cap before React re-renders.
      if (countRemoteTabs(projectsStore.getState().sessions) >= 1) {
        setLimitHit(true);
        return false;
      }
    }
    setLimitHit(false);
    if (projectId && projectsStore.getState().activeProjectId !== projectId) {
      await projectsStore.getState().setActiveProject(projectId);
    }
    if (!projectsStore.getState().activeProjectId) {
      setConnectError("open a project first");
      return false;
    }
    try {
      await projectsStore.getState().launchInSession(command, base);
      return true;
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const connect = async (host: string | SshHost, label: string) => {
    let command: string;
    try {
      command = buildSshLaunch(host);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
      return;
    }
    const ok = await dispatch(command, remoteSessionBase(label), true);
    if (ok && typeof host === "string") setAdHoc("");
  };

  const adHocParsed = adHoc.trim() === "" ? null : parseAdHocHost(adHoc.trim());
  const adHocInvalid = adHoc.trim() !== "" && adHocParsed === null;
  const refreshHosts = () => {
    if (sshStore.getState().status === "loading") return;
    void sshStore.getState().init();
  };

  // The main sidebar is a project tree, not an SSH management surface.
  // Host discovery, ad-hoc connections, provider probes, and advanced target
  // actions stay in Settings → Advanced → KödSSH. Saved targets mirror the
  // KödChat project
  // groups above them and keep their chats/terminals nested in one place.
  if (projectTree) {
    return (
      <section
        className="mt-2 border-t border-border pt-2"
        aria-label="Remote projects"
      >
        <h2 className="px-2 pb-1 text-[11px] font-medium tracking-wide text-text-dim uppercase">
          Remote
        </h2>
        <div className="space-y-0.5">
          {remoteTargets.map((target) => (
            <RemoteTargetEntry
              key={remoteTargetKey(target)}
              target={target}
              label={targetLabels.get(remoteTargetKey(target))!}
              detection={undefined}
              sessions={sessions.filter(
                (session) => session.projectId === remoteProjectId(target),
              )}
              threads={threads}
              active={activeProjectId === remoteProjectId(target)}
              activeSessionId={
                activeSessionByProject[remoteProjectId(target)]
              }
              open={
                expandedProjects[remoteProjectId(target)] ??
                activeProjectId === remoteProjectId(target)
              }
              projectTree
              projectsStore={projectsStore}
              onOpen={() => undefined}
              onLaunchProvider={() => undefined}
              localBackends={localBackends}
              hasMultiBox={hasMultiBox}
              onRecheck={() => undefined}
              onBrowse={() => undefined}
              onUnpin={() => {
                projectsStore.getState().unpinRemoteTarget(target);
                sshStore.getState().clearDetections(target);
              }}
            />
          ))}
        </div>
      </section>
    );
  }

  // ssh itself is unusable — nothing else in this section can work either.
  if (state.status === "error" && !state.sshPath) {
    return (
      <div className="mt-2 border-t border-border pt-2">
        <SectionHeader
          refreshing={false}
          onRefresh={refreshHosts}
        />
        <p className="px-2 py-1 text-xs text-text-dim">
          ssh not found on PATH — install OpenSSH to connect to remote hosts.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      <SectionHeader
        refreshing={state.status === "loading"}
        onRefresh={refreshHosts}
      />

      {state.status === "loading" && (
        <p className="px-2 py-1 text-xs text-text-dim">loading hosts…</p>
      )}

      {/* A config read failure (not the same as "ssh missing") still leaves
          ad-hoc connect usable — only the parsed host list is degraded. */}
      {state.status === "error" && state.sshPath && (
        <p className="px-2 py-1 text-xs text-text-dim">
          could not read ssh config: {state.error}
        </p>
      )}

      {/* Pinned remote projects (Pro): detected agents + one-click launch. */}
      {entitled && remoteTargets.length > 0 && (
        <div className="mb-1 space-y-1">
          {remoteTargets.map((target) => (
            <RemoteTargetEntry
              key={remoteTargetKey(target)}
              target={target}
              label={targetLabels.get(remoteTargetKey(target))!}
              detection={state.detections[remoteTargetKey(target)]}
              sessions={sessions.filter(
                (session) => session.projectId === remoteProjectId(target),
              )}
              threads={threads}
              active={
                activeProjectId === remoteProjectId(target)
              }
              activeSessionId={
                activeSessionByProject[remoteProjectId(target)]
              }
              open={
                expandedProjects[remoteProjectId(target)] ??
                activeProjectId === remoteProjectId(target)
              }
              projectTree={false}
              projectsStore={projectsStore}
              onOpen={() =>
                void dispatch(
                  buildSshProjectLaunch(target),
                  remoteSessionBase(target.host),
                  false,
                )
              }
              onLaunchProvider={(providerId, launch) =>
                void dispatch(
                  buildSshProjectLaunch(target, launch),
                  remoteSessionBase(providerId),
                  false,
                )
              }
              localBackends={localBackends}
              hasMultiBox={hasMultiBox}
              onRecheck={() => void sshStore.getState().detectTarget(target)}
              onBrowse={() => {
                void (async () => {
                  const projectId = remoteProjectId(target);
                  await projectsStore.getState().setActiveProject(projectId);
                  await filesStore.getState().setRemoteScope(projectId);
                })();
              }}
              onUnpin={() => {
                projectsStore.getState().unpinRemoteTarget(target);
                sshStore.getState().clearDetections(target);
              }}
            />
          ))}
        </div>
      )}

      {state.hosts.length === 0 && state.status === "ready" && (
        <p className="px-2 py-1 text-xs text-text-dim">
          no hosts in ~/.ssh/config — connect ad-hoc below.
        </p>
      )}

      {state.hosts.length > 0 && (
        <div className="space-y-0.5">
          {state.hosts.map((host) => (
            <HostRow
              key={host.alias}
              host={host}
              entitled={entitled}
              alreadyPinned={(path) =>
                remoteTargets.some(
                  (t) =>
                    remoteTargetKey(t) ===
                    remoteTargetKey({ host: host.alias, path }),
                )
              }
              onConnect={() => void connect(host, host.alias)}
              onPin={(path) =>
                projectsStore
                  .getState()
                  .pinRemoteTarget({ host: host.alias, path })
              }
            />
          ))}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (adHocParsed) void connect(adHoc.trim(), adHoc.trim());
        }}
        className="mt-1 flex items-center gap-1 px-2"
      >
        <input
          value={adHoc}
          onChange={(event) => setAdHoc(event.target.value)}
          placeholder="user@host"
          aria-label="Ad-hoc remote host"
          aria-invalid={adHocInvalid}
          className={`h-7 min-w-0 flex-1 rounded bg-surface px-2 text-xs text-text outline-none ring-1 ${
            adHocInvalid
              ? "ring-[var(--kd-warning)]"
              : "ring-border focus:ring-accent"
          }`}
        />
        <button
          type="submit"
          disabled={!adHocParsed}
          title="Connect"
          aria-label="Connect ad-hoc host"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-dim"
        >
          →
        </button>
      </form>
      {adHocInvalid && (
        <p className="px-2 pt-0.5 text-[11px] text-[var(--kd-warning)]">
          invalid host
        </p>
      )}

      {connectError && (
        <p
          role="alert"
          className="px-2 pt-1 text-[11px] text-[var(--kd-warning)]"
        >
          {connectError}
        </p>
      )}

      {limitHit && (
        <p
          role="status"
          className="mx-2 mt-1 rounded border border-border bg-surface px-2 py-1 text-[11px] text-text-dim"
        >
          Pro unlocks unlimited remote sessions. Free keeps one remote tab open
          at a time.
        </p>
      )}

      {/* Honest free-tier lock row for remote projects: names a real host so the
          value is concrete, not boilerplate (same posture as HarnessPane). */}
      {!entitled && state.status === "ready" && (
        <p
          role="status"
          className="mx-2 mt-1 rounded border border-border bg-surface px-2 py-1 text-[11px] text-text-dim"
        >
          Ködade Pro can make {state.hosts[0]?.alias ?? "a host"} a project,
          detect its agent CLIs, and launch them remotely.
        </p>
      )}
    </div>
  );
}

function SectionHeader({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-medium tracking-wide text-text-dim uppercase">
      <div>Remote</div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh SSH hosts"
        title="Refresh ~/.ssh/config"
        className="flex h-6 w-6 items-center justify-center rounded text-sm font-normal normal-case hover:bg-surface-hover hover:text-text disabled:opacity-40"
      >
        ↻
      </button>
    </div>
  );
}

function RemoteProjectIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M3 4.5h4l1.2 1.4H13v6.6H3z" />
      <path d="M5.2 9.2h5.6M8 7.2v4" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="m5 6.5 2 1.5-2 1.5M8.5 10h2.5" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M2.5 4.5h4l1.2 1.4h5.8v6.6h-11z" />
    </svg>
  );
}

// Display-only wrapper around buildSshLaunch for the connect button's
// tooltip — never throws, since a malformed alias must not crash the row.
function sshLaunchTitle(host: SshHost): string {
  try {
    return buildSshLaunch(host);
  } catch {
    return `ssh -t ${host.alias}`;
  }
}

function HostRow({
  host,
  entitled,
  alreadyPinned,
  onConnect,
  onPin,
}: {
  host: SshHost;
  entitled: boolean;
  alreadyPinned: (path: string) => boolean;
  onConnect: () => void;
  onPin: (path: string) => void;
}) {
  const [pinning, setPinning] = useState(false);
  const [path, setPath] = useState("");
  const trimmed = path.trim();
  const canPin = trimmed !== "" && !alreadyPinned(trimmed);

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          onClick={onConnect}
          // Reuse the real choke point rather than hand-rolling the same
          // string a second time (M11e security sweep: every ssh command
          // string kodade builds lives in src/ssh/command.ts). Falls back to
          // the bare alias if it somehow fails the allowlist — a tooltip
          // must never throw during render.
          title={sshLaunchTitle(host)}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded px-2 text-left text-xs text-text-dim hover:bg-surface-hover hover:text-text"
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-dim"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{host.alias}</span>
          {host.hostName && (
            <span className="shrink-0 truncate text-[11px] opacity-60">
              {host.hostName}
            </span>
          )}
        </button>
        {entitled && (
          <button
            type="button"
            onClick={() => setPinning((v) => !v)}
            aria-label={`Actions for ${host.alias}`}
            aria-expanded={pinning}
            title="Remote project actions"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text"
          >
            <span aria-hidden="true">···</span>
          </button>
        )}
      </div>
      {entitled && pinning && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canPin) return;
            onPin(trimmed);
            setPath("");
            setPinning(false);
          }}
          className="mt-0.5 mb-1 flex items-center gap-1 pl-4 pr-2"
        >
          <span className="sr-only">Save a path as a remote project</span>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="~/code/project"
            aria-label={`Remote path on ${host.alias}`}
            className="h-6 min-w-0 flex-1 rounded bg-surface px-2 text-[11px] text-text outline-none ring-1 ring-border focus:ring-accent"
          />
          <button
            type="submit"
            disabled={!canPin}
            aria-label={`Confirm pin ${host.alias}`}
            title="Pin as project"
            className="flex h-6 shrink-0 items-center rounded border border-border px-2 text-[11px] text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-40"
          >
            save
          </button>
        </form>
      )}
    </div>
  );
}

function RemoteTargetEntry({
  target,
  label,
  detection,
  sessions,
  threads,
  active,
  activeSessionId,
  open,
  projectTree,
  projectsStore,
  ...actions
}: {
  target: RemoteTarget;
  label: RemoteTargetLabel;
  detection: Record<string, DetectionState> | undefined;
  sessions: SessionMeta[];
  threads: ChatState["threads"];
  active: boolean;
  activeSessionId: string | undefined;
  open: boolean;
  projectTree: boolean;
  projectsStore: StoreApi<ProjectsState>;
  onOpen: () => void;
  onLaunchProvider: (providerId: string, remoteCommand: string) => void;
  localBackends: LocalBackendOption[];
  hasMultiBox: boolean;
  onRecheck: () => void;
  onBrowse: () => void;
  onUnpin: () => void;
}) {
  if (!projectTree) {
    return (
      <PinnedTargetRow
        target={target}
        label={label}
        detection={detection}
        {...actions}
      />
    );
  }

  const projectId = remoteProjectId(target);
  const chats = sessions.filter(isChatSession);
  const terminals = sessions.filter((session) => !isChatSession(session));
  return (
    <div data-remote-project={projectId}>
      <div
        className={`group flex items-center gap-0.5 rounded px-1 ${
          active ? "bg-surface-hover" : "hover:bg-surface-hover"
        }`}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${label.primary} remote project`}
          onClick={() =>
            projectsStore.getState().toggleProjectExpanded(projectId)
          }
          className="flex h-5 w-4 shrink-0 items-center justify-center text-xs text-text-dim hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
        <button
          type="button"
          aria-label={`Open ${label.primary} remote project`}
          aria-current={active ? "page" : undefined}
          onClick={() => void projectsStore.getState().setActiveProject(projectId)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs text-text-dim hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <RemoteProjectIcon />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{label.primary}</span>
            <span className="block truncate text-[10px] opacity-70">
              {label.secondary}
            </span>
          </span>
          <span className="tabular-nums text-[10px]">
            {chats.length || ""}
          </span>
        </button>
        <button
          type="button"
          aria-label={`New chat in ${label.primary}`}
          title="New remote chat"
          onClick={() => {
            void (async () => {
              await projectsStore.getState().setActiveProject(projectId);
              projectsStore
                .getState()
                .addChatThread(projectId, projectsStore.getState().chatProvider);
            })();
          }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span aria-hidden="true" className="text-sm leading-none">+</span>
        </button>
        <button
          type="button"
          aria-label={`Remove ${label.primary} remote project`}
          title="Remove remote project"
          onClick={actions.onUnpin}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-dim opacity-0 hover:bg-surface-hover hover:text-text focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-accent group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      {open && (
        <ul className="ml-3 space-y-0.5 border-l border-border pl-2">
          {chats.map((session) => (
            <ChatThreadRow
              key={session.id}
              session={session}
              thread={threads[session.id]}
              selected={activeSessionId === session.id}
              onActivate={() => {
                void projectsStore
                  .getState()
                  .activateSession(projectId, session.id);
              }}
              onClose={() => {
                void projectsStore.getState().closeSession(session.id);
              }}
            />
          ))}
          {terminals.map((session) => (
            <li key={session.id} className="group/terminal relative">
              <button
                type="button"
                aria-current={activeSessionId === session.id ? "true" : undefined}
                onClick={() => {
                  void projectsStore
                    .getState()
                    .activateSession(projectId, session.id);
                }}
                className={`flex w-full items-center gap-1.5 rounded py-1 pl-1.5 pr-6 text-left text-xs focus:outline-none focus:ring-1 focus:ring-accent ${
                  activeSessionId === session.id
                    ? "bg-surface-hover text-text"
                    : "text-text-dim hover:bg-surface-hover hover:text-text"
                }`}
              >
                <TerminalIcon />
                <span className="min-w-0 flex-1 truncate">{session.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Close remote terminal ${session.name}`}
                onClick={() => {
                  void projectsStore.getState().closeSession(session.id);
                }}
                className="absolute right-0.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-text-dim opacity-0 hover:text-text focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-accent group-focus-within/terminal:opacity-100 group-hover/terminal:opacity-100"
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              aria-label={`New terminal in ${label.primary}`}
              title={`Open a clean terminal in ${label.full}`}
              onClick={() => {
                void (async () => {
                  await projectsStore.getState().setActiveProject(projectId);
                  projectsStore.getState().addSession(projectId);
                })();
              }}
              className="flex w-full items-center gap-1.5 rounded py-1 pl-1.5 pr-2 text-left text-xs text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <TerminalIcon />
              <span>New terminal</span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

function PinnedTargetRow({
  target,
  label,
  detection,
  detailsOnly = false,
  onOpen,
  onLaunchProvider,
  localBackends,
  hasMultiBox,
  onRecheck,
  onBrowse,
  onUnpin,
}: {
  target: RemoteTarget;
  label: RemoteTargetLabel;
  detection: Record<string, DetectionState> | undefined;
  detailsOnly?: boolean;
  onOpen: () => void;
  onLaunchProvider: (providerId: string, remoteCommand: string) => void;
  localBackends: LocalBackendOption[];
  hasMultiBox: boolean;
  onRecheck: () => void;
  onBrowse: () => void;
  onUnpin: () => void;
}) {
  const states = detection ?? {};
  const anyPending = AVAILABLE_PROVIDERS.some(
    (p) => states[p.id]?.status === "pending",
  );
  const ready = AVAILABLE_PROVIDERS.filter(
    (p) => states[p.id]?.status === "ready",
  );
  // Detection has run for this target and produced no usable agent CLI.
  const done = detection !== undefined && !anyPending;
  // Real probe errors (timeout, rejected exec — a slow/dead/non-POSIX remote)
  // vs. the plain "not found" every uninstalled provider reports. Only the
  // former is worth a dedicated line; "not found" is already implied by a
  // provider's absence from the launch-button row above.
  const failedWithReason = AVAILABLE_PROVIDERS.flatMap((p) => {
    const st = states[p.id];
    return st?.status === "failed" && st.reason !== "not found"
      ? [{ id: p.id, reason: st.reason }]
      : [];
  });

  return (
    <div className="mx-2 rounded border border-border bg-surface px-2 py-1.5">
      <div className="flex items-center gap-1">
        {detailsOnly ? (
          <button
            type="button"
            onClick={onOpen}
            title={`open a terminal in ${label.full}`}
            className="flex h-6 min-w-0 flex-1 items-center rounded px-1 text-left text-[11px] text-accent hover:bg-surface-hover"
          >
            + terminal
          </button>
        ) : (
          <button
            onClick={onOpen}
            title={`open a terminal in ${label.full}`}
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs text-text hover:text-accent"
          >
            <RemoteProjectIcon />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{label.primary}</span>
              <span className="block truncate text-[10px] text-text-dim">
                {label.secondary}
              </span>
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={onRecheck}
          aria-label={`Re-check agents on ${target.host}`}
          title="Re-check agents"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text"
        >
          ↻
        </button>
        {/* Remote file tree (M11d, Pro): opens the read-only browser tab —
            this row only renders inside `entitled && ...`, so the affordance
            is already Pro-gated by the parent's guard. */}
        <button
          type="button"
          onClick={onBrowse}
          aria-label={`Browse files on ${target.host}:${target.path}`}
          title="Browse remote files (read-only)"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text"
        >
          <FolderIcon />
        </button>
        <button
          type="button"
          onClick={onUnpin}
          aria-label={`Remove saved remote ${target.host}:${target.path}`}
          title="Remove saved remote project"
          className="flex h-6 shrink-0 items-center justify-center rounded px-1.5 text-[10px] text-text-dim hover:bg-surface-hover hover:text-text"
        >
          remove
        </button>
      </div>

      {/* Every remote call has a visible state: detecting, launch buttons, or a
          plain "nothing found" (covers not-installed and unsupported/dead
          remotes alike — a failed POSIX probe is never a crash). */}
      <div className="mt-1 flex flex-wrap items-center gap-1 pl-4">
        {anyPending && <span className="text-[11px] text-text-dim">detecting agents…</span>}
        {!anyPending &&
          ready.map((provider) =>
            provider.id === "kodade-local" ? (
              <RemoteLocalProviderLaunch
                key={provider.id}
                target={target}
                backends={localBackends}
                hasMultiBox={hasMultiBox}
                onLaunch={(backend) =>
                  onLaunchProvider(
                    provider.id,
                    buildRemoteProgramLaunch(
                      provider.remote?.launch ?? provider.launch,
                      ["--base-url", backend.baseURL],
                    ),
                  )
                }
              />
            ) : (
              <button
                key={provider.id}
                type="button"
                onClick={() =>
                  onLaunchProvider(
                    provider.id,
                    buildRemoteProgramLaunch(
                      provider.remote?.launch ?? provider.launch,
                    ),
                  )
                }
                title={`launch ${provider.name} on ${target.host}`}
                className="flex h-6 items-center rounded border border-accent px-2 text-[11px] text-accent hover:bg-surface-hover"
              >
                {provider.id}
              </button>
            ),
          )}
        {done && ready.length === 0 && (
          <span className="text-[11px] text-text-dim">no agent CLIs detected</span>
        )}
      </div>

      {/* Per-provider failure detail (M11e): a probe error (timeout, rejected
          exec — a slow/dead/non-POSIX remote) reads very differently from a
          clean "not found", so surface each failed provider's own reason
          instead of collapsing everything into the generic line above. */}
      {done && failedWithReason.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 pl-4">
          {failedWithReason.map(({ id, reason }) => (
            <li key={id} className="text-[11px] text-text-dim">
              {id}: {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RemoteLocalProviderLaunch({
  target,
  backends,
  hasMultiBox,
  onLaunch,
}: {
  target: RemoteTarget;
  backends: LocalBackendOption[];
  hasMultiBox: boolean;
  onLaunch: (backend: LocalBackendOption) => void;
}) {
  const [backendId, setBackendId] = useState("local");
  const backend =
    backends.find((candidate) => candidate.id === backendId) ?? backends[0];

  return (
    <div className="w-full rounded border border-accent/50 px-1.5 py-1">
      <label className="block text-[10px] text-text-dim">
        KödLocal backend
        <select
          aria-label={`KödLocal backend for ${target.host}`}
          value={backend.id}
          onChange={(event) => setBackendId(event.target.value)}
          className="mt-0.5 w-full rounded border border-border bg-bg px-1 py-0.5 text-[11px] text-text"
        >
          {backends.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      {!backend.local && (
        <p role="note" className="mt-1 text-[10px] text-text-dim">
          This remote project sends prompts and enabled agent requests to{" "}
          {backend.label}.
        </p>
      )}
      {!hasMultiBox && (
        <p className="mt-1 text-[10px] text-text-dim">
          Saved LAN/remote backends require KödLocal Pro.
        </p>
      )}
      <button
        type="button"
        onClick={() => onLaunch(backend)}
        title={`launch KödLocal on ${target.host} with ${backend.label}`}
        className="mt-1 flex h-6 rounded border border-accent px-2 text-[11px] text-accent hover:bg-surface-hover"
      >
        kodade-local
      </button>
    </div>
  );
}
