// The Connections manager (#64, Phase 4 slice 4). A registry surface for MCP
// connections: browse the curated catalog, add a custom server, see where each
// connection is already installed, and install one into a detected CLI config —
// always through the guarded KödHarness review flow (prepareAddMcpServer +
// ChangeConfirmDialog), never a silent write.
//
// BYOK discipline: there are NO credential fields here. A catalog entry's auth
// note is display-only; the user sets keys in their own CLI config or keychain.
// Enabling a connection is an explicit, confirmed config change — nothing is
// written at spawn time or otherwise.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { AgentConnection, ConnectionInput } from "../../agents/connection";
import type { ConnectionScope } from "../../agents/connection-store";
import type { ConnectionsState } from "../../agents/connections-store";
import {
  CONNECTIONS_CATALOG,
  type ConnectionCatalogEntry,
} from "../../agents/connections-catalog";
import {
  mapConnectionToTarget,
  probesFromInventory,
} from "../../agents/connection-install";
import { connectionStore as defaultConnectionStore } from "../../store/appStore";
import type { ConnectionStore } from "../../agents/connection-store";
import {
  isPendingChangeOwned,
  type HarnessState,
  type McpTarget,
  type PendingChangeOwner,
} from "../../store/harness";
import type { HarnessScope } from "../../harness/model";
import { ChangeConfirmDialog, abbreviate } from "../ChangeConfirmDialog";

type ScopedMcpTarget = { target: McpTarget; scope: HarnessScope };

// A pending-change owner unique to the Connections surface, so an install here
// never collides with a KödHarness- or KödMem-owned staged change.
function connectionsOwner(projectRoot: string): PendingChangeOwner {
  return { surface: "connections", scopeId: projectRoot };
}

export function ConnectionsManager({
  connections,
  harness,
  source = defaultConnectionStore,
  scope,
  projectRoot,
  onClose,
}: {
  connections: StoreApi<ConnectionsState>;
  harness: StoreApi<HarnessState>;
  source?: ConnectionStore;
  scope: ConnectionScope;
  projectRoot: string;
  onClose: () => void;
}) {
  const state = useStore(connections);
  const [view, setView] = useState<"list" | "catalog" | "custom">("list");
  const [targets, setTargets] = useState<ScopedMcpTarget[] | null>(null);

  const inventory = useStore(harness, (s) => s.inventory);
  const probes = useMemo(() => probesFromInventory(inventory), [inventory]);
  const pendingOwner = connectionsOwner(projectRoot);
  const harnessPending = useStore(harness, (s) => s.pendingChange);
  const preparing = useStore(harness, (s) => s.preparing);
  const applying = useStore(harness, (s) => s.applying);
  const mutationError = useStore(harness, (s) => s.mutationError);
  const ownPending = isPendingChangeOwned(harnessPending, pendingOwner) ? harnessPending : null;
  // An install is in flight (staging the plan) or already staged for review.
  const installBusy = preparing || applying || ownPending !== null;

  // Detected MCP config targets across both scopes (same source as the KödHarness
  // add-server form). Install-state probes come from the inventory the persona
  // editor already scanned, and confirmPendingChange rescans after an install, so
  // the manager deliberately does NOT trigger its own scan here (no double scan).
  useEffect(() => {
    let stopped = false;
    const list = harness.getState().listMcpTargets;
    void Promise.all([list("project", projectRoot), list("global", projectRoot)])
      .then(([project, global]) => {
        if (stopped) return;
        setTargets([
          ...project.map((target) => ({ target, scope: "project" as const })),
          ...global.map((target) => ({ target, scope: "global" as const })),
        ]);
      })
      .catch(() => {
        if (!stopped) setTargets([]);
      });
    return () => {
      stopped = true;
    };
  }, [harness, projectRoot]);

  const list = state.connectionsFor(scope);

  const addCatalog = async (entry: ConnectionCatalogEntry, transportIndex: number) => {
    const input: ConnectionInput = {
      name: entry.name,
      source: "catalog",
      catalogId: entry.id,
      transport: entry.transports[transportIndex] ?? entry.transports[0],
      authNote: entry.authNote,
    };
    const made = await connections.getState().createConnection(scope, input);
    if (made) setView("list");
  };

  return (
    <section className="overflow-hidden rounded border border-border bg-surface" aria-label="Connections manager">
      <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-text-dim">
        <span>Connections</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close connections manager"
          className="rounded px-1.5 hover:bg-surface-hover hover:text-text"
        >
          ×
        </button>
      </header>

      <div className="p-3 text-xs">
        {!state.storageReadable && (
          <p role="alert" className="mb-2 text-[11px] text-[var(--kd-error)]">
            Connection storage is unreadable, so connections can't be saved. Resolve the on-disk
            connections document, then reopen this manager.
          </p>
        )}

        <div className="mb-3 flex flex-wrap gap-2">
          <TabButton label="Registered" active={view === "list"} onClick={() => setView("list")} />
          <TabButton label="Add from catalog" active={view === "catalog"} onClick={() => setView("catalog")} />
          <TabButton label="Add custom" active={view === "custom"} onClick={() => setView("custom")} />
        </div>

        {view === "list" && (
          <RegisteredList
            list={list}
            source={source}
            probes={probes}
            targets={targets}
            projectRoot={projectRoot}
            installBusy={installBusy}
            onRemove={(id) => void connections.getState().removeConnection(scope, id)}
            onInstall={(connection, scoped) => {
              const mapping = mapConnectionToTarget(connection, scoped.target);
              if (!mapping.ok) return;
              void harness
                .getState()
                .prepareAddMcpServer(scoped.target, mapping.spec, projectRoot, pendingOwner);
            }}
          />
        )}

        {view === "catalog" && (
          <CatalogBrowser onAdd={(entry, idx) => void addCatalog(entry, idx)} />
        )}

        {view === "custom" && (
          <CustomForm
            onCreate={async (input) => {
              const made = await connections.getState().createConnection(scope, input);
              if (made) setView("list");
            }}
          />
        )}

        {state.mutationError && (
          <p role="alert" className="mt-2 text-[11px] text-[var(--kd-error)]">
            {state.mutationError}
          </p>
        )}

        {/* An install that failed to even stage (e.g. the server name already
            exists in the target config) sets mutationError but leaves no pending
            change, so it would otherwise be invisible. Surface it here, the same
            way HarnessTools does. */}
        {mutationError && !ownPending && (
          <p
            role="alert"
            data-testid="connection-install-error"
            className="mt-2 text-[11px] text-[var(--kd-error)]"
          >
            {mutationError}
          </p>
        )}

        {ownPending && (
          <div className="mt-3">
            <ChangeConfirmDialog
              pending={ownPending}
              applying={applying}
              error={mutationError}
              projectRoot={projectRoot}
              onCancel={() => harness.getState().cancelPendingChange(pendingOwner)}
              onConfirm={() => void harness.getState().confirmPendingChange(pendingOwner)}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded border px-2 py-1 text-[11px] ${
        active
          ? "border-accent text-accent"
          : "border-border text-text-dim hover:bg-surface-hover hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

// --- Registered connections + per-target install ---

function RegisteredList({
  list,
  source,
  probes,
  targets,
  projectRoot,
  installBusy,
  onRemove,
  onInstall,
}: {
  list: AgentConnection[];
  source: ConnectionStore;
  probes: ReturnType<typeof probesFromInventory>;
  targets: ScopedMcpTarget[] | null;
  projectRoot: string;
  installBusy: boolean;
  onRemove: (id: string) => void;
  onInstall: (connection: AgentConnection, target: ScopedMcpTarget) => void;
}) {
  // Which connection's remove button is armed (first click), so removal takes
  // two clicks — the same confirm discipline the persona editor uses.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (list.length === 0) {
    return <p className="text-text-dim">No connections yet. Add one from the catalog or a custom server.</p>;
  }
  return (
    <ul className="space-y-2">
      {list.map((connection) => {
        const installs = source.installedState(connection, probes);
        const arming = confirmingId === connection.id;
        return (
          <li key={connection.id} className="rounded border border-border bg-bg p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-text">
                  {connection.name}
                  <span className="ml-2 text-[10px] text-text-dim">
                    {connection.source === "catalog" ? "catalog" : "custom"} ·{" "}
                    {connection.transport.kind === "http" ? "remote" : "stdio"}
                  </span>
                </p>
                <p className="mt-0.5 truncate text-[10px] text-text-dim">
                  {connection.transport.kind === "http"
                    ? connection.transport.url
                    : [connection.transport.command, ...connection.transport.args].join(" ")}
                </p>
                {connection.authNote && (
                  <p className="mt-0.5 text-[10px] text-text-dim">Auth: {connection.authNote}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {arming && (
                  <button
                    type="button"
                    onClick={() => setConfirmingId(null)}
                    className="rounded px-1.5 py-0.5 text-[10px] text-text-dim hover:text-text"
                  >
                    cancel
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (!arming) {
                      setConfirmingId(connection.id);
                      return;
                    }
                    setConfirmingId(null);
                    onRemove(connection.id);
                  }}
                  aria-label={arming ? `confirm remove ${connection.name}` : `remove ${connection.name}`}
                  className={`rounded border px-2 py-0.5 text-[10px] ${
                    arming
                      ? "border-[color-mix(in_srgb,var(--kd-error)_55%,transparent)] text-[var(--kd-error)] hover:bg-[color-mix(in_srgb,var(--kd-error)_12%,transparent)]"
                      : "border-border text-text-dim hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {arming ? "confirm remove" : "remove"}
                </button>
              </div>
            </div>

            {installs.length > 0 && (
              <p className="mt-1 text-[10px] text-[var(--kd-success)]">
                Installed in: {installs.map((i) => `${i.cli} (${abbreviate(i.path, projectRoot)})`).join(", ")}
              </p>
            )}

            <TargetInstaller
              connection={connection}
              targets={targets}
              projectRoot={projectRoot}
              installBusy={installBusy}
              onInstall={onInstall}
            />
          </li>
        );
      })}
    </ul>
  );
}

function TargetInstaller({
  connection,
  targets,
  projectRoot,
  installBusy,
  onInstall,
}: {
  connection: AgentConnection;
  targets: ScopedMcpTarget[] | null;
  projectRoot: string;
  installBusy: boolean;
  onInstall: (connection: AgentConnection, target: ScopedMcpTarget) => void;
}) {
  const [index, setIndex] = useState(0);
  if (!targets) return null;
  if (targets.length === 0) {
    return <p className="mt-1 text-[10px] text-text-dim">No MCP config file detected for any installed CLI.</p>;
  }
  const scoped = targets[index];
  const mapping = scoped ? mapConnectionToTarget(connection, scoped.target) : null;
  const disabled = !mapping?.ok || installBusy;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select
        aria-label={`install target for ${connection.name}`}
        value={index}
        onChange={(event) => setIndex(Number(event.target.value))}
        className="rounded border border-border bg-surface px-2 py-1 text-[11px] text-text"
      >
        {targets.map((entry, i) => (
          <option key={`${entry.target.path}:${entry.scope}`} value={i}>
            {entry.target.cli} · {abbreviate(entry.target.path, projectRoot)}
            {entry.scope === "global" ? " (global)" : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={disabled}
        title={mapping && !mapping.ok ? mapping.reason : undefined}
        onClick={() => scoped && onInstall(connection, scoped)}
        className="rounded border border-accent px-2 py-1 text-[11px] text-accent hover:bg-surface-hover disabled:cursor-not-allowed disabled:border-border disabled:text-text-dim"
      >
        {installBusy ? "Installing…" : "Install to CLI config…"}
      </button>
      {mapping && !mapping.ok && (
        <span className="text-[10px] text-[var(--kd-warning)]">{mapping.reason}</span>
      )}
    </div>
  );
}

// --- Catalog browser ---

function CatalogBrowser({
  onAdd,
}: {
  onAdd: (entry: ConnectionCatalogEntry, transportIndex: number) => void;
}) {
  return (
    <ul className="space-y-2">
      {CONNECTIONS_CATALOG.map((entry) => (
        <li key={entry.id} className="rounded border border-border bg-bg p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-text">
                {entry.name}
                <span className="ml-2 text-[10px] text-text-dim">{entry.provenance}</span>
              </p>
              <p className="mt-0.5 text-[10px] text-text-dim">{entry.summary}</p>
            </div>
            <a
              href={entry.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-[10px] text-accent hover:underline"
            >
              docs
            </a>
          </div>
          {entry.badges?.map((badge) => (
            <p key={badge} className="mt-1 rounded bg-[color-mix(in_srgb,var(--kd-warning)_12%,transparent)] px-1.5 py-0.5 text-[10px] text-[var(--kd-warning)]">
              {badge}
            </p>
          ))}
          <p className="mt-1 text-[10px] text-text-dim">Auth: {entry.authNote}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {entry.transports.map((transport, i) => (
              <button
                key={`${entry.id}:${i}`}
                type="button"
                onClick={() => onAdd(entry, i)}
                className="rounded border border-border px-2 py-1 text-[11px] text-text-dim hover:bg-surface-hover hover:text-text"
              >
                Add {transport.kind === "http" ? "remote" : "stdio"}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

// --- Custom server form ---

function CustomForm({ onCreate }: { onCreate: (input: ConnectionInput) => Promise<void> }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [authNote, setAuthNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    if (!name.trim()) {
      setError("a connection name is required");
      return;
    }
    const transport =
      kind === "http"
        ? { kind: "http" as const, url: url.trim() }
        : {
            kind: "stdio" as const,
            command: command.trim(),
            args: args.trim() ? args.trim().split(/\s+/) : [],
          };
    if (kind === "http" ? !transport.url : !("command" in transport && transport.command)) {
      setError(kind === "http" ? "give the server a url" : "give the server a command");
      return;
    }
    void onCreate({ name: name.trim(), source: "custom", transport, authNote: authNote.trim() });
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-text-dim">connection name</span>
        <input
          aria-label="connection name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded border border-border bg-bg px-2 py-1 text-text"
        />
      </label>
      <div className="flex gap-2">
        <label className="flex items-center gap-1 text-text">
          <input type="radio" checked={kind === "stdio"} onChange={() => setKind("stdio")} /> stdio
        </label>
        <label className="flex items-center gap-1 text-text">
          <input type="radio" checked={kind === "http"} onChange={() => setKind("http")} /> remote (http)
        </label>
      </div>
      {kind === "stdio" ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-text-dim">command</span>
            <input
              aria-label="command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npx"
              className="rounded border border-border bg-bg px-2 py-1 text-text"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-dim">args (space-separated, optional)</span>
            <input
              aria-label="args"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              className="rounded border border-border bg-bg px-2 py-1 text-text"
            />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-text-dim">url</span>
          <input
            aria-label="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…"
            className="rounded border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-text-dim">auth note (display-only, optional)</span>
        <input
          aria-label="auth note"
          value={authNote}
          onChange={(event) => setAuthNote(event.target.value)}
          placeholder="e.g. sets MY_TOKEN in your own environment"
          className="rounded border border-border bg-bg px-2 py-1 text-text"
        />
        <span className="text-[10px] text-text-dim">
          Notes only — never paste keys or secrets. Ködade doesn't store credentials.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-[var(--kd-error)]">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          className="rounded border border-accent px-3 py-1 text-accent hover:bg-surface-hover"
        >
          Add connection
        </button>
      </div>
    </div>
  );
}
