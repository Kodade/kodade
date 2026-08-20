import { useState } from "react";
import type {
  MemoryWorkspace,
  WorkspaceKnowledgeSurface,
} from "../../ipc/contract";
import { ProjectsVaultSetup, type ProjectsVaultIpc } from "./ProjectsVaultSetup";

// Confirmation shown before a local → vault switch. The switch turns the local
// surface off first, so the copy has to say what happens to the files.
export const SWITCH_TO_VAULT_CONFIRM =
  "Switch project knowledge to an Obsidian projects vault? Ködade stops using local project knowledge for this project. Files already in .kodade/knowledge are left on disk.";

/**
 * The KödMem knowledge surface, shown above the memory dashboard.
 *
 * - vault workspaces render their existing projects-vault setup unchanged;
 * - local workspaces get a plain statement of where knowledge lives, with the
 *   vault as a collapsed, explicit opt-in;
 * - workspaces registered before local knowledge existed get a one-click
 *   "set up project knowledge" action — never an automatic one.
 *
 * "Not resolved yet" and "resolving failed" are distinct from "no surface":
 * neither may show the bare-cohort copy or its setup action.
 */
export function KnowledgeSurfacePanel({
  workspace,
  surface,
  busy = false,
  loading = false,
  error = null,
  resolveError = null,
  onSetUpLocal,
  onSwitchToVault,
  onRetryResolve,
  onMappingChanged,
  ipc,
  confirm = (message: string) => window.confirm(message),
}: {
  workspace: MemoryWorkspace | null;
  surface: WorkspaceKnowledgeSurface | null;
  busy?: boolean;
  loading?: boolean;
  error?: string | null;
  resolveError?: string | null;
  onSetUpLocal?: () => void;
  onSwitchToVault?: () => void;
  onRetryResolve?: () => void;
  onMappingChanged?: () => void;
  ipc?: ProjectsVaultIpc;
  confirm?: (message: string) => boolean;
}) {
  // Opened by hand, or automatically right after a confirmed switch so the
  // vault mapping form is where the user is already looking.
  const [vaultOpen, setVaultOpen] = useState(false);

  // A vault-mapped workspace is already in its mode: show it as today, not as
  // an option it has missed.
  if (surface?.mode === "vault") {
    return (
      <ProjectsVaultSetup
        workspace={workspace}
        ipc={ipc}
        onMappingChanged={onMappingChanged}
      />
    );
  }

  if (resolveError) {
    return (
      <section
        aria-label="Project knowledge"
        data-knowledge-surface="error"
        className="shrink-0 border-b border-border bg-surface/60 px-4 py-3"
      >
        <div className="text-xs font-medium text-text">Project knowledge</div>
        <p role="alert" className="mt-1 text-[11px] text-[var(--kd-error)]">
          Ködade could not read this project's knowledge surface: {resolveError}
        </p>
        {onRetryResolve && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onRetryResolve()}
            className="memory-action mt-2"
          >
            Retry
          </button>
        )}
      </section>
    );
  }

  if (loading) {
    return (
      <section
        aria-label="Project knowledge"
        data-knowledge-surface="loading"
        className="shrink-0 border-b border-border bg-surface/60 px-4 py-3"
      >
        <div className="text-xs font-medium text-text">Project knowledge</div>
        <p className="mt-0.5 text-[11px] text-text-dim">Checking…</p>
      </section>
    );
  }

  const isLocal = surface?.mode === "local";
  const switchToVault = () => {
    if (busy || !onSwitchToVault) return;
    if (!confirm(SWITCH_TO_VAULT_CONFIRM)) return;
    setVaultOpen(true);
    onSwitchToVault();
  };

  return (
    <section
      aria-label="Project knowledge"
      data-knowledge-surface={surface?.mode ?? "none"}
      className="shrink-0 border-b border-border bg-surface/60 px-4 py-3"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-48 flex-1">
          <div className="text-xs font-medium text-text">Project knowledge</div>
          {isLocal ? (
            <>
              <p className="mt-0.5 text-[11px] text-text-dim">
                Project knowledge lives in{" "}
                <code>.kodade/knowledge</code> (git-ignored). Nothing to set up
                and nothing to sync.
              </p>
              <p className="mt-1 truncate font-mono text-[10px] text-text-dim">
                {surface.knowledgeRoot}
              </p>
            </>
          ) : workspace ? (
            <p className="mt-0.5 text-[11px] text-text-dim">
              This project has no knowledge surface yet. Ködade can keep it in a
              git-ignored <code>.kodade/knowledge</code> directory inside the
              project.
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] text-text-dim">
              Enable KödMem for this project to set up project knowledge.
            </p>
          )}
        </div>
        {workspace && onSetUpLocal && (!isLocal || error) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetUpLocal()}
            className="memory-action"
          >
            {busy
              ? "Setting up…"
              : isLocal
                ? "Retry knowledge files"
                : "Set up project knowledge"}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--kd-error)]">
          {error}
        </p>
      )}

      <details
        open={vaultOpen}
        onToggle={(event) => setVaultOpen(event.currentTarget.open)}
        className="mt-3 border-t border-border pt-3"
      >
        <summary className="cursor-pointer text-[11px] text-text-dim">
          Sync with an Obsidian projects vault
        </summary>
        {isLocal ? (
          <div className="mt-2">
            <p className="text-[11px] text-text-dim">
              This project uses local knowledge. Switching stores it in a shared
              Obsidian projects vault instead; the files already in{" "}
              <code>.kodade/knowledge</code> are left on disk.
            </p>
            <button
              type="button"
              disabled={busy || !onSwitchToVault}
              onClick={switchToVault}
              className="memory-action mt-2"
            >
              Switch to vault sync…
            </button>
          </div>
        ) : (
          <div className="mt-2 -mx-4 -mb-3">
            <ProjectsVaultSetup
              workspace={workspace}
              ipc={ipc}
              onMappingChanged={onMappingChanged}
            />
          </div>
        )}
      </details>
    </section>
  );
}
