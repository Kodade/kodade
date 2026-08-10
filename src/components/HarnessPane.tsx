import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { appStore, filesStore, harnessStore } from "../store/appStore";
import {
  isPendingChangeOwned,
  type HarnessState,
  type McpTarget,
  type PendingChange,
  type PendingChangeOwner,
} from "../store/harness";
import type { ConfigChange } from "../harness/contract";
import type { McpServerSpec } from "../harness/merge";
import type { ArtifactKind, HarnessArtifact, HarnessScope } from "../harness/model";
import { projectMatrix, type MatrixRow } from "../harness/matrix";
import { AVAILABLE_PROVIDERS } from "../providers/catalog";
import { entitlements as defaultEntitlements, type Entitlements } from "../app/entitlements";
import { renderMarkdown } from "../markdown/render";
import { FEATURES } from "../license/features";
import type { KodSkillsAction, KodSkillsCell } from "../harness/kodskills";
import type { PlatformIpc } from "../ipc/contract";
import { tauriPlatform } from "../ipc/tauri";
import { canPickFolder, capabilitiesStore } from "../platform/capabilities";
import { settingsViewStore } from "../store/settingsView";
import { ProjectSkillsManager } from "./ProjectSkillsManager";

// KödHarness's inspector pane. M10b shipped the free read-only slice (project
// scope, claude only); M10c widens it to the full multi-CLI matrix + global
// scope, both gated behind hasFeature("harness.pro"). Free keeps the M10b
// one-column inspector and can additionally manage KödSkills for Claude Code.
const SECTIONS: { kind: ArtifactKind; label: string }[] = [
  { kind: "instruction", label: "instructions" },
  { kind: "skill", label: "skills" },
  { kind: "subagent", label: "subagents" },
  { kind: "mcp-server", label: "mcp servers" },
];

// Every CLI kodade knows how to inspect, in catalog order — the Pro matrix's
// full column roster. Free entitlement narrows this to just ["claude"].
const ALL_CLIS = AVAILABLE_PROVIDERS.filter((provider) => provider.harness).map(
  (provider) => provider.id,
);

// Global scope has no live fs watcher (unlike the project tree), so it
// rescans on tab focus plus this light interval per the plan.
const AUTO_RESCAN_MS = 120_000;

type PreviewStatus = "loading" | "loaded" | "error";
type Preview = {
  artifact: HarnessArtifact;
  path: string;
  status: PreviewStatus;
  content: string | null;
  error: string | null;
};

export function HarnessPane({
  scope,
  store = harnessStore,
  entitlements = defaultEntitlements,
  platform = tauriPlatform,
  onScopeChange,
}: {
  scope: HarnessScope;
  store?: StoreApi<HarnessState>;
  entitlements?: Entitlements;
  platform?: Pick<PlatformIpc, "pickProjectSkill">;
  onScopeChange: (scope: HarnessScope) => void;
}) {
  const state = useStore(store);
  const activeProject = useStore(appStore, (s) =>
    s.projects.find((project) => project.id === s.activeProjectId),
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  // M10e: the instruction file currently open in the inline editor, and whether
  // the "add MCP server" form is open. Both are Pro-only mutation surfaces.
  const [editing, setEditing] = useState<HarnessArtifact | null>(null);
  const [addingServer, setAddingServer] = useState(false);
  const [skillsDialog, setSkillsDialog] = useState<"global" | "project" | null>(null);
  const entitled = entitlements.hasFeature(FEATURES.harnessPro);
  const projectSkillPickerAvailable = useStore(capabilitiesStore, (state) =>
    canPickFolder(state.capabilities),
  );

  // Rescan on mount/scope/project change, on window focus, and on a light
  // interval — global scope has no fs watcher to lean on, and project scope
  // gets the same treatment for one consistent rescan story. Every adapter in
  // the roster always scans (so the free lock row can honestly name detected
  // CLIs); only rendering is entitlement-gated.
  useEffect(() => {
    if (!activeProject) return;
    if (scope === "global" && !entitled) return; // nothing to scan or show
    let stopped = false;
    const rescan = () => {
      if (!stopped) void store.getState().rescanScope(scope, activeProject.path);
    };
    rescan();
    window.addEventListener("focus", rescan);
    const interval = setInterval(rescan, AUTO_RESCAN_MS);
    return () => {
      stopped = true;
      window.removeEventListener("focus", rescan);
      clearInterval(interval);
    };
  }, [store, activeProject?.id, activeProject?.path, scope, entitled]);

  if (!activeProject) {
    return <Centered>select a project to view its harness</Centered>;
  }
  if (scope === "global" && !entitled) {
    // Kept honest in case an entitlement changes while global scope is open.
    return <Centered>global harness scope requires kodade pro</Centered>;
  }

  const artifacts = state.inventory?.artifacts ?? [];
  const errors = state.inventory?.errors ?? [];
  const projectRoot = activeProject.path;
  const pendingOwner: PendingChangeOwner = { surface: "harness", scopeId: projectRoot };
  const pendingForProject = isPendingChangeOwned(state.pendingChange, pendingOwner)
    ? state.pendingChange
    : null;
  const columns = entitled ? ALL_CLIS : ["claude"];
  // Mutation is Pro (harness.pro). A change already in flight disables further
  // toggles until it settles.
  const mutable = entitled;
  const busy = state.preparing || state.applying || state.pendingChange !== null;
  const detectedOthers = ALL_CLIS.filter(
    (cli) => cli !== "claude" && artifacts.some((artifact) => artifact.cli === cli),
  );
  const scopeToggle = entitled ? (
    <ScopeToggle scope={scope} onSelect={onScopeChange} />
  ) : null;

  const viewArtifact = async (artifact: HarnessArtifact, path: string) => {
    setPreview({ artifact, path, status: "loading", content: null, error: null });
    try {
      const read = await store.getState().readArtifact(path, projectRoot);
      if (read.kind === "text") {
        setPreview({ artifact, path, status: "loaded", content: read.content, error: null });
      } else {
        setPreview({ artifact, path, status: "error", content: null, error: "file is not text" });
      }
    } catch (err) {
      setPreview({
        artifact,
        path,
        status: "error",
        content: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div data-settings-harness="true" className="min-h-full bg-bg">
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs text-text-dim">
            {scope === "global"
              ? "Global instructions and tools available across projects."
              : `Instructions and tools available in ${activeProject.name}.`}
          </p>
          {scopeToggle}
        </div>

        {SECTIONS.map(({ kind, label }) => (
          <ArtifactSection
            key={kind}
            label={label}
            columns={columns}
            artifacts={artifacts.filter((artifact) => artifact.kind === kind)}
            projectRoot={projectRoot}
            mutable={mutable}
            busy={busy}
            onOpen={(artifact) => {
              void filesStore.getState().selectFile(artifact.path).then(() => {
                settingsViewStore.getState().close();
              });
            }}
            onView={(artifact, path) => void viewArtifact(artifact, path)}
            onToggle={(artifact) =>
              void store.getState().prepareToggle(artifact.id, projectRoot)
            }
            onEdit={(artifact) => setEditing(artifact)}
            onAddServer={kind === "mcp-server" ? () => setAddingServer(true) : undefined}
            skillsActions={kind === "skill"
              ? [
                  ...(scope === "global"
                    ? [{
                        label: "manage KödSkills…",
                        onClick: () => setSkillsDialog("global" as const),
                      }]
                    : projectSkillPickerAvailable
                      ? [{
                          label: "+ add project skill…",
                          onClick: () => setSkillsDialog("project" as const),
                        }]
                      : []),
                  ...(scope === "project" && !entitled
                    ? [{
                        label: "install global starter pack…",
                        onClick: () => setSkillsDialog("global" as const),
                      }]
                    : []),
                ]
              : []}
          />
        ))}

        {state.mutationError && !state.pendingChange && (
          <p
            role="alert"
            className="rounded border border-[color-mix(in_srgb,var(--kd-error)_45%,transparent)] bg-[color-mix(in_srgb,var(--kd-error)_10%,transparent)] px-3 py-2 text-xs text-[var(--kd-error)]"
          >
            {state.mutationError}
          </p>
        )}

        {state.scanning && <p className="text-xs text-text-dim">scanning…</p>}
        {!state.scanning && state.lastScannedAt != null && (
          <RescanFooter
            lastScannedAt={state.lastScannedAt}
            onRefresh={() => void store.getState().rescanScope(scope, projectRoot)}
          />
        )}

        {preview && (
          <HarnessDialog ariaLabel={`Preview ${preview.artifact.name}`} onClose={() => setPreview(null)}>
            <PreviewPanel preview={preview} onClose={() => setPreview(null)} />
          </HarnessDialog>
        )}

        {editing && (
          <InstructionEditor
            artifact={editing}
            store={store}
            projectRoot={projectRoot}
            onClose={() => setEditing(null)}
          />
        )}

        {addingServer && (
          <AddServerForm
            store={store}
            scope={scope}
            projectRoot={projectRoot}
            onClose={() => setAddingServer(false)}
          />
        )}

        {skillsDialog === "global" && (
          <HarnessDialog ariaLabel="Manage KödSkills" onClose={() => setSkillsDialog(null)}>
            <KodSkillsPicker
              store={store}
              projectRoot={projectRoot}
              pro={entitled}
              onClose={() => setSkillsDialog(null)}
            />
          </HarnessDialog>
        )}

        {skillsDialog === "project" && (
          <HarnessDialog
            ariaLabel="Manage project skills"
            onClose={() => setSkillsDialog(null)}
          >
            <ProjectSkillsManager
              store={store}
              platform={platform}
              projectRoot={projectRoot}
              pro={entitled}
              onClose={() => setSkillsDialog(null)}
            />
          </HarnessDialog>
        )}

        {pendingForProject && (
          <ChangeConfirmDialog
            pending={pendingForProject}
            applying={state.applying}
            error={state.mutationError}
            projectRoot={projectRoot}
            onCancel={() => store.getState().cancelPendingChange(pendingOwner)}
            onConfirm={() => void store.getState().confirmPendingChange(pendingOwner)}
          />
        )}

        {!entitled && (
          <p role="status" className="rounded border border-border bg-surface px-3 py-2 text-xs text-text-dim">
            {lockMessage(detectedOthers)}
          </p>
        )}

        {(state.scanError || errors.length > 0) && (
          <div
            role="alert"
            className="rounded border border-[color-mix(in_srgb,var(--kd-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--kd-warning)_10%,transparent)] px-3 py-2 text-xs text-[var(--kd-warning)]"
          >
            {state.scanError && <p>could not scan: {state.scanError}</p>}
            {errors.map((error, i) => (
              <p key={i}>
                {error.kind} unreadable at {abbreviate(error.path, projectRoot)} — {error.message}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// The honest free-tier lock row: names only the CLIs actually detected in
// this scan, never a speculative "codex and grok" boilerplate.
function lockMessage(detectedOthers: string[]): string {
  const base = "unlock the full matrix, global scope, and editing with kodade pro.";
  if (detectedOthers.length === 0) return `Ködade Pro — ${base}`;
  const names =
    detectedOthers.length === 1
      ? detectedOthers[0]
      : `${detectedOthers.slice(0, -1).join(", ")} and ${detectedOthers[detectedOthers.length - 1]}`;
  return `Ködade Pro — ${names} also detected. ${base}`;
}

function ScopeToggle({
  scope,
  onSelect,
}: {
  scope: "global" | "project";
  onSelect: (scope: "global" | "project") => void;
}) {
  return (
    <div className="flex shrink-0 gap-1 text-[11px] text-text-dim">
      {(["project", "global"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onSelect(option)}
          aria-pressed={scope === option}
          className={`rounded border border-border px-2 py-1 ${
            scope === option
              ? "bg-surface-hover text-text"
              : "text-text-dim hover:bg-surface-hover hover:text-text"
          }`}
        >
          {option === "project" ? "this project" : "global"}
        </button>
      ))}
    </div>
  );
}

function RescanFooter({
  lastScannedAt,
  onRefresh,
}: {
  lastScannedAt: number;
  onRefresh: () => void;
}) {
  const minutes = Math.max(0, Math.floor((Date.now() - lastScannedAt) / 60_000));
  const label = minutes < 1 ? "rescanned just now" : `rescanned ${minutes}m ago`;
  return (
    <p className="flex items-center gap-2 text-xs text-text-dim">
      <span>{label}</span>
      <button type="button" onClick={onRefresh} className="underline hover:text-text">
        refresh
      </button>
    </p>
  );
}

function ArtifactSection({
  label,
  columns,
  artifacts,
  projectRoot,
  mutable,
  busy,
  onOpen,
  onView,
  onToggle,
  onEdit,
  onAddServer,
  skillsActions,
}: {
  label: string;
  columns: string[];
  artifacts: HarnessArtifact[];
  projectRoot: string;
  mutable: boolean;
  busy: boolean;
  onOpen: (artifact: HarnessArtifact) => void;
  onView: (artifact: HarnessArtifact, path: string) => void;
  onToggle: (artifact: HarnessArtifact) => void;
  onEdit: (artifact: HarnessArtifact) => void;
  onAddServer?: () => void;
  skillsActions: { label: string; onClick: () => void }[];
}) {
  const rows = projectMatrix(artifacts, columns);
  const gridTemplateColumns = `minmax(12rem, 1fr) repeat(${columns.length}, 4rem) 6rem`;
  return (
    <section
      aria-label={`${label} harness inventory`}
      className="overflow-x-auto rounded border border-border bg-surface"
    >
      <header
        data-harness-grid="header"
        className="grid items-center border-b border-border px-3 py-2 text-[11px] font-semibold tracking-[0.12em] text-text-dim"
        style={{ gridTemplateColumns }}
      >
        <span>{label}</span>
        {columns.map((cli) => (
          <span key={cli} className="text-center leading-tight normal-case tracking-normal">
            {cliLabel(cli)}
          </span>
        ))}
        <span className="text-right normal-case tracking-normal">state</span>
      </header>
      {rows.length === 0 && <p className="px-3 py-3 text-xs text-text-dim">no {label} found</p>}
      {rows.map((row) => (
        <ArtifactRow
          key={row.identity}
          row={row}
          columns={columns}
          projectRoot={projectRoot}
          mutable={mutable}
          busy={busy}
          onOpen={onOpen}
          onView={onView}
          onToggle={onToggle}
          onEdit={onEdit}
          gridTemplateColumns={gridTemplateColumns}
        />
      ))}
      {skillsActions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
          {skillsActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              disabled={busy}
              className="rounded border border-border px-2 py-1 text-xs text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {/* The "+ add server…" affordance (Pro): merges one entry into a detected
          MCP config through the format-preserving safe merge. */}
      {mutable && onAddServer && (
        <div className="border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={onAddServer}
            disabled={busy}
            className="rounded border border-border px-2 py-1 text-xs text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
          >
            + add server…
          </button>
        </div>
      )}
    </section>
  );
}

// Skills and subagent files share the same `.disabled` rename mechanic, so both
// get the on/off toggle; instructions and mcp servers have no disable switch.
// A broken/malformed entry can't be toggled — its rename would be meaningless.
function canToggle(artifact: HarnessArtifact): boolean {
  return (
    (artifact.kind === "skill" || artifact.kind === "subagent") &&
    artifact.status === "ok"
  );
}

function ArtifactRow({
  row,
  columns,
  projectRoot,
  mutable,
  busy,
  onOpen,
  onView,
  onToggle,
  onEdit,
  gridTemplateColumns,
}: {
  row: MatrixRow;
  columns: string[];
  projectRoot: string;
  mutable: boolean;
  busy: boolean;
  onOpen: (artifact: HarnessArtifact) => void;
  onView: (artifact: HarnessArtifact, path: string) => void;
  onToggle: (artifact: HarnessArtifact) => void;
  onEdit: (artifact: HarnessArtifact) => void;
  gridTemplateColumns: string;
}) {
  const artifact = row.representative;
  const viewPath =
    artifact.kind === "skill" && artifact.detail?.kind === "skill"
      ? artifact.detail.manifestPath
      : artifact.kind === "subagent"
        ? artifact.path
        : null;
  const togglable = mutable && row.paths.length === 1 && canToggle(artifact);
  // Instruction files edit through the adapter contract (M10e) — the safe path
  // for a global-scope CLAUDE.md that sits outside the project root and so can't
  // go through the pathguard-confined file editor. A malformed file isn't offered.
  const editable = mutable && artifact.kind === "instruction" && artifact.status === "ok";

  return (
    <div
      data-harness-grid="row"
      className="grid items-center border-b border-border px-3 py-2.5 text-xs last:border-b-0"
      style={{ gridTemplateColumns }}
    >
      <div className="min-w-0 pr-3">
        <div className="min-w-0">
          <span className="text-text">{artifact.name}</span>
          {artifact.kind === "instruction" && artifact.source.via === "symlink" && (
            <span className="ml-2 text-text-dim" title={`symlink → ${artifact.source.target}`}>
              ⇲ {abbreviate(artifact.source.target, projectRoot)}
            </span>
          )}
          {artifact.kind === "instruction" && (
            <span className="ml-2 text-text-dim">{locationSummary(artifact, projectRoot)}</span>
          )}
        </div>
        {(artifact.kind === "instruction" || editable || viewPath) && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {artifact.kind === "instruction" && (
              <button
                type="button"
                onClick={() => onOpen(artifact)}
                className="rounded border border-border px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
              >
                open
              </button>
            )}
            {editable && (
              <button
                type="button"
                onClick={() => onEdit(artifact)}
                disabled={busy}
                className="rounded border border-border px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
              >
                edit
              </button>
            )}
            {viewPath && (
              <button
                type="button"
                onClick={() => onView(artifact, viewPath)}
                className="rounded border border-border px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
              >
                view
              </button>
            )}
          </div>
        )}
      </div>

      {columns.map((cli) => (
        <span
          key={cli}
          title={row.cells[cli] ? `detected by ${cliLabel(cli)}` : `not detected by ${cliLabel(cli)}`}
          className="text-center text-text-dim"
        >
          {row.cells[cli] ? "●" : "–"}
        </span>
      ))}

      {togglable ? (
        <span className="text-right">
          <button
            type="button"
            onClick={() => onToggle(artifact)}
            disabled={busy}
            aria-pressed={artifact.enabled}
            title={artifact.enabled ? "disable this skill" : "enable this skill"}
            className={`rounded border px-2 py-1 disabled:opacity-50 ${
              artifact.enabled
                ? "border-accent text-accent hover:bg-surface-hover"
                : "border-border text-text-dim hover:bg-surface-hover hover:text-text"
            }`}
          >
            {artifact.enabled ? "on" : "off"}
          </button>
        </span>
      ) : (
        <span className="text-right text-text-dim">
          {row.paths.length > 1 ? "shared" : statusText(artifact)}
        </span>
      )}
    </div>
  );
}

// The plan → apply confirm dialog. Says what will happen, shows the exact change
// (a rename for a skill toggle, or a diff for an instruction edit / MCP merge),
// and offers [cancel] [apply]. Follows SettingsPopover's focus/Escape/click-away
// discipline — focus moves in on open, Escape and an outside pointer both cancel.
export function ChangeConfirmDialog({
  pending,
  applying,
  error,
  projectRoot,
  onCancel,
  onConfirm,
}: {
  pending: PendingChange;
  applying: boolean;
  error: string | null;
  projectRoot: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { change, title } = pending;
  const items = pending.items ?? [{ cli: pending.cli, title, change, artifact: pending.artifact }];
  const isBatch = items.length > 1;
  const isRename = !isBatch && change.format === "dir-rename";

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !applying) onCancel();
    };
    const onPointer = (event: PointerEvent) => {
      if (!applying && !dialogRef.current?.contains(event.target as Node)) onCancel();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [applying, onCancel]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="rounded border border-border bg-surface p-4 text-xs shadow-lg"
    >
      {isBatch ? (
        <BatchSummary items={items} projectRoot={projectRoot} />
      ) : isRename ? (
        <RenameSummary pending={pending} projectRoot={projectRoot} />
      ) : change.format === "skill-dir" ? (
        <SkillDirSummary title={title} change={change} projectRoot={projectRoot} />
      ) : (
        <MergeSummary change={change} projectRoot={projectRoot} />
      )}
      {error && (
        <p role="alert" className="mt-2 text-[var(--kd-error)]">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={applying}
          className="rounded border border-border px-3 py-1 text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={applying}
          className="rounded border border-accent px-3 py-1 text-accent hover:bg-surface-hover disabled:opacity-50"
        >
          {applying
            ? "applying…"
            : isBatch
              ? "apply batch"
              : change.format === "dir-rename"
                ? "apply"
                : change.format === "skill-dir"
                  ? "apply"
                  : "apply merge"}
        </button>
      </div>
    </div>
  );
}

function BatchSummary({
  items,
  projectRoot,
}: {
  items: NonNullable<PendingChange["items"]>;
  projectRoot: string;
}) {
  return (
    <>
      <p className="text-text">
        Ködade will apply {items.length} changes as one reversible batch.
      </p>
      <div className="mt-2 max-h-80 space-y-2 overflow-auto">
        {items.map((item, index) => (
          <details key={`${item.change.path}:${index}`} className="rounded border border-border bg-bg p-2">
            <summary className="cursor-pointer text-text">
              {item.title} · {abbreviate(item.change.path, projectRoot)}
            </summary>
            <DiffView diff={item.change.diff} />
          </details>
        ))}
      </div>
      <p className="mt-2 text-text-dim">
        Each change is verified; any failure restores already-applied changes in reverse order.
      </p>
    </>
  );
}

function SkillDirSummary({
  title,
  change,
  projectRoot,
}: {
  title: string;
  change: ConfigChange;
  projectRoot: string;
}) {
  return (
    <>
      <p className="text-text">
        {title} · <span className="text-text-dim">{abbreviate(change.path, projectRoot)}</span>
      </p>
      <DiffView diff={change.diff} />
      <p className="mt-2 text-text-dim">
        {change.skillOperation === "install"
          ? "the target must be absent; verify failure removes the new directory."
          : "the current files must match provenance; a backup is kept for restore."}
      </p>
    </>
  );
}

// The M10d rename preview: old path → new path, with the symlink caveat.
function RenameSummary({ pending, projectRoot }: { pending: PendingChange; projectRoot: string }) {
  const { change, artifact } = pending;
  const disabling = artifact?.enabled ?? false;
  return (
    <>
      <p className="text-text">
        kodade will {disabling ? "disable" : "enable"}{" "}
        <span className="font-semibold">{artifact?.name ?? change.after}</span> by renaming it on disk.
        {artifact?.source.via === "symlink" && " the symlink entry is renamed, not its target."}
      </p>
      <div className="mt-2 space-y-0.5 text-text-dim">
        <p>{abbreviate(change.before, projectRoot)}</p>
        <p>→ {abbreviate(change.after, projectRoot)}</p>
      </div>
      <p className="mt-2 text-text-dim">
        {disabling
          ? "it disappears from the cli's effective set; re-enable restores it."
          : "it returns to the cli's effective set."}
      </p>
    </>
  );
}

// The M10e byte-write preview: the file, the exact key(s) touched, a diff, and
// the backup/restore promise. For an MCP merge this is the "your other servers
// are untouched" reassurance the plan's mockup calls for.
function MergeSummary({ change, projectRoot }: { change: ConfigChange; projectRoot: string }) {
  const isMerge = change.touchedKeys != null && change.touchedKeys.length > 0;
  const operation = change.mcpOperation === "update" ? "update" : "merge";
  return (
    <>
      <p className="text-text">
        {isMerge
          ? `kodade will ${operation} one entry. your other servers are untouched.`
          : "kodade will save this file."}{" "}
        <span className="text-text-dim">{abbreviate(change.path, projectRoot)}</span>
      </p>
      {isMerge && (
        <p className="mt-1 text-text-dim">
          {change.mcpOperation === "update" ? "updated" : "added"}: <span className="text-text">{change.touchedKeys!.join(", ")}</span>
        </p>
      )}
      <DiffView diff={change.diff} />
      <p className="mt-2 text-text-dim">
        {change.isNewFile
          ? "this creates a new file — there is no prior version to restore."
          : "a timestamped backup is written first; a failed verify auto-restores it."}
      </p>
    </>
  );
}

// A compact unified diff: removed lines (−) then added lines (+) per hunk. Purely
// presentational over the ConfigChange.diff the plan produced.
function DiffView({ diff }: { diff: ConfigChange["diff"] }) {
  if (diff.length === 0) {
    return <p className="mt-2 text-text-dim">no textual change</p>;
  }
  return (
    <pre className="mt-2 max-h-64 overflow-auto rounded border border-border bg-bg p-2 text-[11px] leading-relaxed">
      {diff.map((hunk, i) => (
        <div key={i}>
          {hunk.context && <div className="text-text-dim">@ {hunk.context}</div>}
          {hunk.before
            ? hunk.before.split("\n").map((line, j) => (
                <div key={`b${j}`} className="text-[var(--kd-error)]">
                  - {line}
                </div>
              ))
            : null}
          {hunk.after
            ? hunk.after.split("\n").map((line, j) => (
                <div key={`a${j}`} className="text-[var(--kd-success,#4ade80)]">
                  + {line}
                </div>
              ))
            : null}
        </div>
      ))}
    </pre>
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

function PreviewPanel({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  const isMarkdown = /\.mdx?$/i.test(preview.path);
  return (
    <section className="overflow-hidden rounded border border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-text-dim">
        <span>
          previewing <span className="text-text">{preview.artifact.name}</span> · read-only
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close preview"
          className="rounded px-1.5 hover:bg-surface-hover hover:text-text"
        >
          ×
        </button>
      </header>
      {preview.status === "loading" && (
        <p className="px-3 py-4 text-xs text-text-dim">loading…</p>
      )}
      {preview.status === "error" && (
        <p role="alert" className="px-3 py-4 text-xs text-[var(--kd-error)]">
          could not load preview: {preview.error}
        </p>
      )}
      {preview.status === "loaded" && preview.content !== null && (
        <div className="max-h-96 overflow-auto px-3 py-3">
          {isMarkdown ? (
            <article
              className="markdown-view"
              // A read-only preview of the artifact's own file — same sanitized
              // renderer as the editor's Markdown view; never editable here.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.content) }}
            />
          ) : (
            <pre className="whitespace-pre-wrap text-[11px] text-text">{preview.content}</pre>
          )}
        </div>
      )}
    </section>
  );
}

// M10e instruction editor: loads the file's current text through the same
// guarded ConfigIpc the scan uses, lets the user edit it, and on "review
// changes" stages an `edit` plan (which opens the diff confirm dialog). It edits
// through the adapter contract — not the pathguard file editor — so a global
// CLAUDE.md outside the project root is editable too.
function InstructionEditor({
  artifact,
  store,
  projectRoot,
  onClose,
}: {
  artifact: HarnessArtifact;
  store: StoreApi<HarnessState>;
  projectRoot: string;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    void store
      .getState()
      .readArtifact(artifact.path, projectRoot)
      .then((read) => {
        if (stopped) return;
        setText(read.kind === "text" ? read.content : "");
        if (read.kind !== "text") setLoadError("this file is not editable as text");
      })
      .catch((err: unknown) => {
        if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stopped = true;
    };
  }, [store, artifact.path, projectRoot]);

  const review = () => {
    if (text === null) return;
    void store.getState().prepareEdit(artifact.id, text, projectRoot);
    onClose(); // the diff confirm dialog takes over from here
  };

  return (
    <section className="overflow-hidden rounded border border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-text-dim">
        <span>
          editing <span className="text-text">{artifact.name}</span> · {artifact.scope}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close editor"
          className="rounded px-1.5 hover:bg-surface-hover hover:text-text"
        >
          ×
        </button>
      </header>
      {loadError && (
        <p role="alert" className="px-3 py-3 text-xs text-[var(--kd-error)]">
          {loadError}
        </p>
      )}
      {text !== null && !loadError && (
        <div className="p-3">
          <textarea
            aria-label={`edit ${artifact.name}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            className="h-64 w-full resize-y rounded border border-border bg-bg p-2 font-mono text-[12px] text-text"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border px-3 py-1 text-xs text-text-dim hover:bg-surface-hover hover:text-text"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={review}
              className="rounded border border-accent px-3 py-1 text-xs text-accent hover:bg-surface-hover"
            >
              review changes…
            </button>
          </div>
        </div>
      )}
    </section>
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

// M10e "add MCP server" form: pick a detected config file, name the server, and
// give it a command (stdio) or a URL (remote). On "review merge" it stages an
// add-mcp-server plan (running the format-preserving single-key merge), which
// opens the diff confirm dialog. Deliberately minimal — enough to exercise the
// full merge → preview → apply path end to end.
function AddServerForm({
  store,
  scope,
  projectRoot,
  onClose,
}: {
  store: StoreApi<HarnessState>;
  scope: "global" | "project";
  projectRoot: string;
  onClose: () => void;
}) {
  const [targets, setTargets] = useState<McpTarget[] | null>(null);
  const [targetIndex, setTargetIndex] = useState(0);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    void store
      .getState()
      .listMcpTargets(scope, projectRoot)
      .then((found) => {
        if (!stopped) setTargets(found);
      })
      .catch((err: unknown) => {
        if (!stopped) setFormError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stopped = true;
    };
  }, [store, scope, projectRoot]);

  const submit = () => {
    setFormError(null);
    const target = targets?.[targetIndex];
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
          <p className="text-text-dim">no MCP config file detected for this scope.</p>
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
              {targets.map((target, i) => (
                <option key={target.path} value={i}>
                  {target.cli} · {abbreviate(target.path, projectRoot)}
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-settings-harness="true"
      className="flex min-h-64 items-center justify-center text-sm text-text-dim"
    >
      {children}
    </div>
  );
}

// A location's status in one word: broken/unreadable/malformed states win over
// the enabled/disabled mechanic (a `.disabled` rename is moot if the target is
// gone anyway). Instructions and mcp servers have no disable mechanic, so a
// healthy one renders blank rather than a meaningless "enabled".
function statusText(artifact: HarnessArtifact): string {
  if (artifact.status === "orphaned-symlink") return "broken symlink";
  if (artifact.status === "unreadable") return "unreadable";
  if (artifact.status === "malformed") return "malformed";
  if (artifact.kind === "instruction" || artifact.kind === "mcp-server") return "";
  return artifact.enabled ? "enabled" : "disabled";
}

function cliLabel(cli: string): string {
  if (cli === "claude") return "Claude";
  return AVAILABLE_PROVIDERS.find((provider) => provider.id === cli)?.name ?? cli;
}

// Instructions show "<scope> · N lines" per the plan's mockup; everything else
// shows its path relative to the project root (no tilde abbreviation yet —
// abbreviate() only shortens paths under the active project root).
function locationSummary(artifact: HarnessArtifact, projectRoot: string): string {
  if (artifact.kind === "instruction" && artifact.detail?.kind === "instruction") {
    const { lines } = artifact.detail;
    return lines != null ? `${artifact.scope} · ${lines} lines` : artifact.scope;
  }
  return abbreviate(artifact.path, projectRoot);
}

function abbreviate(path: string, projectRoot: string): string {
  if (path === projectRoot) return ".";
  if (path.startsWith(projectRoot)) {
    const rest = path.slice(projectRoot.length).replace(/^[/\\]/, "");
    return rest || ".";
  }
  return path;
}
