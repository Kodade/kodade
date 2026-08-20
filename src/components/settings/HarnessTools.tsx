// Settings → Advanced → KödHarness: the tools that actually change something.
//
// The KödHarness inventory pane is retired (issue #63) — instruction files are
// the user's to edit in the editor, and Ködade's own guidance is the background
// prompt. What survives is the work you cannot do by opening a file: installing
// and updating the KödSkills pack, adding a project skill to the right target
// directories, and merging one MCP server into a detected config file. Each
// stages a plan and confirms it through the shared ChangeConfirmDialog.

import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { entitlements as defaultEntitlements, type Entitlements } from "../../app/entitlements";
import type { KodSkillsAction, KodSkillsCell } from "../../harness/kodskills";
import type { McpServerSpec } from "../../harness/merge";
import type { HarnessScope } from "../../harness/model";
import type { PlatformIpc } from "../../ipc/contract";
import { tauriPlatform } from "../../ipc/tauri";
import { FEATURES } from "../../license/features";
import { canPickFolder, capabilitiesStore } from "../../platform/capabilities";
import { appStore, harnessStore } from "../../store/appStore";
import {
  isPendingChangeOwned,
  type HarnessState,
  type McpTarget,
  type PendingChangeOwner,
} from "../../store/harness";
import { ChangeConfirmDialog, abbreviate } from "../ChangeConfirmDialog";
import { ProjectSkillsManager } from "../ProjectSkillsManager";

type ToolDialog = "kodskills" | "project-skill" | "add-server" | null;

export function HarnessTools({
  store = harnessStore,
  entitlements = defaultEntitlements,
  platform = tauriPlatform,
}: {
  store?: StoreApi<HarnessState>;
  entitlements?: Entitlements;
  platform?: Pick<PlatformIpc, "pickProjectSkill">;
} = {}) {
  const state = useStore(store);
  const activeProject = useStore(appStore, (s) =>
    s.projects.find((project) => project.id === s.activeProjectId),
  );
  const [dialog, setDialog] = useState<ToolDialog>(null);
  const entitled = entitlements.hasFeature(FEATURES.harnessPro);
  const projectSkillPickerAvailable = useStore(capabilitiesStore, (capabilityState) =>
    canPickFolder(capabilityState.capabilities),
  );

  if (!activeProject) {
    return (
      <section
        data-settings-harness="true"
        className="rounded-md border border-border bg-surface px-4 py-3 text-xs text-text-dim"
      >
        select a project to manage its skills and tools
      </section>
    );
  }

  const projectRoot = activeProject.path;
  const pendingOwner: PendingChangeOwner = { surface: "harness", scopeId: projectRoot };
  const pendingForProject = isPendingChangeOwned(state.pendingChange, pendingOwner)
    ? state.pendingChange
    : null;
  const busy = state.preparing || state.applying || state.pendingChange !== null;

  return (
    <section
      data-settings-harness="true"
      className="rounded-md border border-border bg-surface px-4 py-3"
    >
      <p className="text-xs text-text">Skills and tools</p>
      <p className="mt-0.5 text-[11px] text-text-dim">
        Install skills and register MCP servers for the CLIs detected in {activeProject.name}.
        Instruction files (CLAUDE.md, AGENTS.md) are yours to edit in the editor.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <ToolButton
          label="manage KödSkills…"
          disabled={busy}
          onClick={() => setDialog("kodskills")}
        />
        {projectSkillPickerAvailable && (
          <ToolButton
            label="+ add project skill…"
            disabled={busy}
            onClick={() => setDialog("project-skill")}
          />
        )}
        {entitled && (
          <ToolButton
            label="+ add mcp server…"
            disabled={busy}
            onClick={() => setDialog("add-server")}
          />
        )}
      </div>

      {!entitled && (
        <p role="status" className="mt-2 text-[11px] text-text-dim">
          Ködade Pro adds pack updates, the shared .agents/skills target, and MCP server merges.
        </p>
      )}

      {state.mutationError && !state.pendingChange && (
        <p role="alert" className="mt-2 text-[11px] text-[var(--kd-error)]">
          {state.mutationError}
        </p>
      )}

      {dialog === "kodskills" && (
        <HarnessDialog ariaLabel="Manage KödSkills" onClose={() => setDialog(null)}>
          <KodSkillsPicker
            store={store}
            projectRoot={projectRoot}
            pro={entitled}
            onClose={() => setDialog(null)}
          />
        </HarnessDialog>
      )}

      {dialog === "project-skill" && (
        <HarnessDialog ariaLabel="Manage project skills" onClose={() => setDialog(null)}>
          <ProjectSkillsManager
            store={store}
            platform={platform}
            projectRoot={projectRoot}
            pro={entitled}
            onClose={() => setDialog(null)}
          />
        </HarnessDialog>
      )}

      {dialog === "add-server" && (
        <HarnessDialog ariaLabel="Add MCP server" onClose={() => setDialog(null)}>
          <AddServerForm
            store={store}
            projectRoot={projectRoot}
            onClose={() => setDialog(null)}
          />
        </HarnessDialog>
      )}

      {pendingForProject && (
        <div className="mt-3">
          <ChangeConfirmDialog
            pending={pendingForProject}
            applying={state.applying}
            error={state.mutationError}
            projectRoot={projectRoot}
            onCancel={() => store.getState().cancelPendingChange(pendingOwner)}
            onConfirm={() => void store.getState().confirmPendingChange(pendingOwner)}
          />
        </div>
      )}
    </section>
  );
}

function ToolButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-border px-2 py-1 text-[11px] text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function HarnessDialog({
  ariaLabel,
  onClose,
  children,
}: {
  ariaLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className="max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-auto rounded shadow-2xl outline-none"
      >
        {children}
      </div>
    </div>
  );
}

// M15 KödSkills pack picker. It is deliberately a projection over the store's
// inspected model: checkboxes only select skill/physical-target ids, while all
// conflict, provenance, gating, and action eligibility stay in kodskills.ts.
function KodSkillsPicker({
  store,
  projectRoot,
  pro,
  onClose,
}: {
  store: StoreApi<HarnessState>;
  projectRoot: string;
  pro: boolean;
  onClose: () => void;
}) {
  const state = useStore(store);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());

  useEffect(() => {
    void store.getState().loadKodSkills(projectRoot);
  }, [store, projectRoot, pro]);

  useEffect(() => {
    if (!state.kodSkills) return;
    setSelectedSkills(new Set(state.kodSkills.pack.skills.map((skill) => skill.id)));
    setSelectedTargets(new Set(state.kodSkills.targets.map((target) => target.id)));
  }, [state.kodSkills]);

  const toggle = (set: Set<string>, value: string, update: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  const submit = async (action: KodSkillsAction) => {
    await store.getState().prepareKodSkills(
      action,
      [...selectedSkills],
      [...selectedTargets],
      projectRoot,
    );
    if (store.getState().pendingChange) onClose();
  };

  const model = state.kodSkills;
  const selectedCells = model?.cells.filter(
    (cell) => selectedSkills.has(cell.skillId) && selectedTargets.has(cell.targetId),
  ) ?? [];
  const hasInstall = selectedCells.some((cell) => cell.status === "ready");
  const hasUpdate = selectedCells.some((cell) => cell.status === "update");
  const hasUninstall = selectedCells.some(
    (cell) => cell.status === "installed" || cell.status === "update",
  );

  return (
    <section className="overflow-hidden rounded border border-border bg-surface" aria-label="KödSkills pack picker">
      <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-text-dim">
        <span>KödSkills</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close KödSkills picker"
          className="rounded px-1.5 hover:bg-surface-hover hover:text-text"
        >
          ×
        </button>
      </header>
      {state.kodSkillsLoading && <p className="px-3 py-4 text-xs text-text-dim">loading pack…</p>}
      {state.kodSkillsError && (
        <p role="alert" className="px-3 py-3 text-xs text-[var(--kd-error)]">
          {state.kodSkillsError}
        </p>
      )}
      {model && (
        <div className="p-3 text-xs">
          <div>
            <p className="text-sm text-text">
              {model.pack.name} <span className="text-text-dim">v{model.pack.version}</span>
            </p>
            <p className="mt-1 text-text-dim">{model.pack.description}</p>
          </div>

          <div className="mt-3 flex flex-wrap gap-3 rounded border border-border bg-bg px-2 py-2">
            {model.targets.map((target) => (
              <label key={target.id} className="flex items-center gap-1.5 text-text">
                <input
                  type="checkbox"
                  checked={selectedTargets.has(target.id)}
                  onChange={() => toggle(selectedTargets, target.id, setSelectedTargets)}
                />
                {target.clis.join(" + ")} · {abbreviate(target.path, projectRoot)}
              </label>
            ))}
          </div>
          {!pro && (
            <p className="mt-2 text-text-dim">
              Ködade Pro adds the shared .agents/skills target and pack updates.
            </p>
          )}

          <div className="mt-3 max-h-80 overflow-auto rounded border border-border">
            {model.pack.skills.map((skill) => (
              <div key={skill.id} className="border-b border-border p-2 last:border-b-0">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    aria-label={`select ${skill.id}`}
                    checked={selectedSkills.has(skill.id)}
                    onChange={() => toggle(selectedSkills, skill.id, setSelectedSkills)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-text">{skill.id}</span>
                    <span className="ml-2 text-text-dim">{skill.description}</span>
                  </span>
                </label>
                <div className="ml-5 mt-1 flex flex-wrap gap-2">
                  {model.targets.map((target) => {
                    const cell = model.cells.find(
                      (candidate) => candidate.skillId === skill.id && candidate.targetId === target.id,
                    );
                    return cell ? <KodSkillsBadge key={target.id} cell={cell} label={target.clis.join(" + ")} /> : null;
                  })}
                </div>
              </div>
            ))}
          </div>

          {state.mutationError && (
            <p role="alert" className="mt-2 text-[var(--kd-error)]">{state.mutationError}</p>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border px-3 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
            >
              cancel
            </button>
            {hasUninstall && (
              <button
                type="button"
                onClick={() => void submit("uninstall")}
                disabled={state.preparing}
                className="rounded border border-border px-3 py-1 text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
              >
                uninstall selected…
              </button>
            )}
            {pro && hasUpdate && (
              <button
                type="button"
                onClick={() => void submit("update")}
                disabled={state.preparing}
                className="rounded border border-accent px-3 py-1 text-accent hover:bg-surface-hover disabled:opacity-50"
              >
                update selected…
              </button>
            )}
            {hasInstall && (
              <button
                type="button"
                onClick={() => void submit("install")}
                disabled={state.preparing}
                className="rounded border border-accent px-3 py-1 text-accent hover:bg-surface-hover disabled:opacity-50"
              >
                install selected…
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function KodSkillsBadge({ cell, label }: { cell: KodSkillsCell; label: string }) {
  const tone = cell.status === "ready" || cell.status === "installed" || cell.status === "update"
    ? "text-text-dim"
    : "text-[var(--kd-warning)]";
  return (
    <span className={`rounded border border-border px-1.5 py-0.5 text-[10px] ${tone}`} title={cell.reason}>
      {label}: {cell.reason}
    </span>
  );
}

// "Add MCP server": pick a detected config file, name the server, and give it a
// command (stdio) or a URL (remote). On "review merge" it stages an
// add-mcp-server plan (running the format-preserving single-key merge), which
// opens the diff confirm dialog.
//
// Both scopes are listed in one select, because some CLIs only keep an MCP
// catalog in one of them — codex and grok have global config files only, while
// claude's .mcp.json is per project. The chosen target carries its own path and
// format, so the merge follows the selection, not an ambient scope.
type ScopedMcpTarget = { target: McpTarget; scope: HarnessScope };

function AddServerForm({
  store,
  projectRoot,
  onClose,
}: {
  store: StoreApi<HarnessState>;
  projectRoot: string;
  onClose: () => void;
}) {
  const [targets, setTargets] = useState<ScopedMcpTarget[] | null>(null);
  const [targetIndex, setTargetIndex] = useState(0);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const list = store.getState().listMcpTargets;
    void Promise.all([list("project", projectRoot), list("global", projectRoot)])
      .then(([project, global]) => {
        if (stopped) return;
        setTargets([
          ...project.map((target) => ({ target, scope: "project" as const })),
          ...global.map((target) => ({ target, scope: "global" as const })),
        ]);
      })
      .catch((err: unknown) => {
        if (!stopped) setFormError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stopped = true;
    };
  }, [store, projectRoot]);

  const submit = () => {
    setFormError(null);
    const target = targets?.[targetIndex]?.target;
    if (!target) {
      setFormError("no MCP config file detected to merge into");
      return;
    }
    if (!name.trim()) {
      setFormError("a server name is required");
      return;
    }
    // Build the server config: a command (with optional args) for a stdio server,
    // or a url for a remote one. The merge stores whatever shape we hand it.
    const config: Record<string, unknown> = {};
    if (command.trim()) {
      config.command = command.trim();
      const parsedArgs = args.trim() ? args.trim().split(/\s+/) : [];
      if (parsedArgs.length > 0) config.args = parsedArgs;
    } else if (url.trim()) {
      config.type = "http";
      config.url = url.trim();
    } else {
      setFormError("give the server a command or a url");
      return;
    }
    const spec: McpServerSpec = { name: name.trim(), config };
    void store.getState().prepareAddMcpServer(target, spec, projectRoot);
    onClose(); // the diff confirm dialog takes over from here
  };

  return (
    <section className="overflow-hidden rounded border border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-text-dim">
        <span>add mcp server</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close add server form"
          className="rounded px-1.5 hover:bg-surface-hover hover:text-text"
        >
          ×
        </button>
      </header>
      <div className="flex flex-col gap-2 p-3 text-xs">
        {targets && targets.length === 0 && (
          <p className="text-text-dim">no MCP config file detected for any installed cli.</p>
        )}
        {targets && targets.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-text-dim">config file</span>
            <select
              aria-label="target config file"
              value={targetIndex}
              onChange={(event) => setTargetIndex(Number(event.target.value))}
              className="rounded border border-border bg-bg px-2 py-1 text-text"
            >
              {targets.map((entry, i) => (
                <option key={entry.target.path} value={i}>
                  {entry.target.cli} · {abbreviate(entry.target.path, projectRoot)}
                  {entry.scope === "global" ? " (global)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-text-dim">server name</span>
          <input
            aria-label="server name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-text-dim">command (stdio)</span>
          <input
            aria-label="command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="kodade-mcp"
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
        <label className="flex flex-col gap-1">
          <span className="text-text-dim">or url (remote)</span>
          <input
            aria-label="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…"
            className="rounded border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
        {formError && (
          <p role="alert" className="text-[var(--kd-error)]">
            {formError}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded border border-accent px-3 py-1 text-accent hover:bg-surface-hover"
          >
            review merge…
          </button>
        </div>
      </div>
    </section>
  );
}
