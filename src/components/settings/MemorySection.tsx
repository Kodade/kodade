import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { MemoryIpc, MemoryWorkspace } from "../../ipc/contract";
import { memory as memoryIpc } from "../../ipc/transport";
import { nativeEquals } from "../../platform/native-path";
import { appStore, memoryStore } from "../../store/appStore";
import { MemoryPane } from "../MemoryPane";
import { KnowledgeSurfacePanel } from "./KnowledgeSurfacePanel";
import type { ProjectsVaultIpc } from "./ProjectsVaultSetup";

type SetupState = "checking" | "disabled" | "enabling" | "ready";

export type MemorySectionIpc = ProjectsVaultIpc & Pick<MemoryIpc, "databasePath">;

export function MemorySection({
  ipc = memoryIpc,
}: {
  ipc?: MemorySectionIpc;
} = {}) {
  const activeProjectId = useStore(appStore, (state) => state.activeProjectId);
  const projects = useStore(appStore, (state) => state.projects);
  const workspace = useStore(memoryStore, (state) => state.workspace);
  const knowledgeSurface = useStore(
    memoryStore,
    (state) => state.knowledgeSurface,
  );
  const knowledgeSurfaceError = useStore(
    memoryStore,
    (state) => state.knowledgeSurfaceError,
  );
  const error = useStore(memoryStore, (state) => state.error);
  const project =
    projects.find((candidate) => candidate.id === activeProjectId) ?? null;
  const workspaceMatches =
    project !== null &&
    workspace !== null &&
    nativeEquals(project.path, workspace.canonicalRoot);
  const [setupState, setSetupState] = useState<SetupState>(
    workspaceMatches ? "ready" : "checking",
  );
  const [databasePath, setDatabasePath] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [relinkOpen, setRelinkOpen] = useState(false);
  const [relinkCandidates, setRelinkCandidates] = useState<MemoryWorkspace[]>(
    [],
  );
  // The knowledge step is tracked separately from workspace registration: a
  // failure here must never make the workspace itself look unusable.
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [resolvedSurfaceFor, setResolvedSurfaceFor] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void ipc
      .databasePath()
      .then((path) => {
        if (!cancelled) setDatabasePath(path);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ipc]);

  // Read-only resolution of the existing surface. Workspaces registered before
  // local knowledge existed are never upgraded here — only by the explicit
  // action in the panel.
  useEffect(() => {
    if (!workspaceMatches || !workspace || setupState !== "ready") return;
    if (resolvedSurfaceFor === workspace.id) return;
    let cancelled = false;
    void memoryStore
      .getState()
      .loadKnowledgeSurface()
      .then(() => {
        if (!cancelled) setResolvedSurfaceFor(workspace.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceMatches, workspace?.id, setupState, resolvedSurfaceFor]);

  // Re-resolve after something else changed the surface: a saved vault mapping
  // turns a bare workspace into a vault one, and a failed resolve is retryable.
  const resolveSurface = async (workspaceId: string) => {
    await memoryStore.getState().loadKnowledgeSurface();
    setResolvedSurfaceFor(workspaceId);
  };

  useEffect(() => {
    if (!project) return;
    if (workspaceMatches) {
      setSetupState("ready");
      return;
    }

    let cancelled = false;
    setSetupState("checking");
    void (async () => {
      try {
        const resolved = await memoryStore
          .getState()
          .openWorkspace(project.path);
        if (cancelled) return;
        if (resolved) {
          setSetupState("ready");
          return;
        }
      } catch {
        if (cancelled) return;
      }
      const candidates = await memoryStore.getState().listWorkspaces();
      if (cancelled) return;
      setRelinkCandidates(
        candidates.filter(
          (candidate) =>
            !nativeEquals(candidate.canonicalRoot, project.path),
        ),
      );
      setSetupState("disabled");
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.id, project?.path, workspaceMatches]);

  // Enable + scaffold, the zero-setup default. Registration comes first so a
  // knowledge failure can never orphan it; the surface step is then retryable
  // from the panel and `enable_local_knowledge` is idempotent.
  const setUpKnowledge = async (workspaceId: string) => {
    setKnowledgeBusy(true);
    setKnowledgeError(null);
    const surface = await memoryStore.getState().setUpLocalKnowledge();
    if (!surface) {
      setKnowledgeError(
        memoryStore.getState().error ??
          "Setting up project knowledge failed. KödMem is still enabled for this project.",
      );
    }
    setResolvedSurfaceFor(workspaceId);
    setKnowledgeBusy(false);
  };

  const enable = async () => {
    if (!project || setupState === "enabling") return;
    setSetupState("enabling");
    let registered: MemoryWorkspace;
    try {
      registered = await memoryStore
        .getState()
        .createWorkspace(project.path, project.name, project.color ?? null);
    } catch {
      setSetupState("disabled");
      return;
    }
    setSetupState("ready");
    await setUpKnowledge(registered.id);
  };

  const switchToVault = async () => {
    if (!workspace || knowledgeBusy) return;
    setKnowledgeBusy(true);
    setKnowledgeError(null);
    const switched = await memoryStore.getState().turnOffLocalKnowledge();
    if (!switched) {
      setKnowledgeError(
        memoryStore.getState().error ?? "Switching to vault sync failed.",
      );
    }
    setKnowledgeBusy(false);
  };

  // Until the surface is resolved the panel shows a placeholder, so a local or
  // vault workspace never flashes the "no knowledge surface yet" copy.
  const knowledgePanel =
    workspaceMatches && workspace ? (
      <KnowledgeSurfacePanel
        workspace={workspace}
        surface={knowledgeSurface}
        busy={knowledgeBusy}
        loading={resolvedSurfaceFor !== workspace.id}
        error={knowledgeError}
        resolveError={knowledgeSurfaceError}
        onSetUpLocal={() => void setUpKnowledge(workspace.id)}
        onSwitchToVault={() => void switchToVault()}
        onRetryResolve={() => void resolveSurface(workspace.id)}
        onMappingChanged={() => void resolveSurface(workspace.id)}
        ipc={ipc}
      />
    ) : null;

  const relinkFrom = async (existing: MemoryWorkspace) => {
    if (!project || setupState === "enabling") return;
    setSetupError(null);
    if (
      !window.confirm(
        `Relink “${existing.displayName}” memory from ${existing.canonicalRoot} to ${project.path}?`,
      )
    ) {
      return;
    }
    setSetupState("enabling");
    try {
      await memoryStore.getState().load(existing.id);
      const relinked = await memoryStore
        .getState()
        .relinkWorkspace(project.path);
      setRelinkOpen(false);
      setSetupState(relinked ? "ready" : "disabled");
    } catch (relinkError) {
      setSetupError(
        relinkError instanceof Error ? relinkError.message : String(relinkError),
      );
      setSetupState("disabled");
    }
  };

  if (!project) {
    return (
      <div
        data-settings-memory="true"
        className="flex h-full min-h-0 flex-col"
      >
        <KnowledgeSurfacePanel workspace={null} surface={null} ipc={ipc} />
        <div className="flex flex-1 items-center justify-center text-xs text-text-dim">
          Open a project to set up KödMem.
        </div>
      </div>
    );
  }

  if (workspaceMatches && setupState === "ready") {
    return (
      <div data-settings-memory="true" className="flex h-full min-h-0 flex-col">
        {knowledgePanel}
        <div className="min-h-0 flex-1">
          <MemoryPane workspaceId={workspace.id} databasePath={databasePath} />
        </div>
      </div>
    );
  }

  return (
    <div
      data-settings-memory="true"
      className="flex h-full min-h-0 flex-col"
    >
      <KnowledgeSurfacePanel workspace={null} surface={null} ipc={ipc} />
      <div className="m-auto w-full max-w-lg rounded border border-border bg-surface p-5">
        <div className="text-sm font-medium text-text">{project.name}</div>
        <p className="mt-1 text-xs text-text-dim">
          Memory for this project. Stored outside the repo to keep it out of Git
          and sync. Enabling also sets up project knowledge in a git-ignored
          <code className="ml-1">.kodade/knowledge</code> directory.
        </p>
        <p className="mt-2 break-all font-mono text-[10px] text-text-dim">
          {databasePath ?? "Ködade app data/kodade-memory.sqlite3"}
        </p>
        {(setupError || error) && (
          <p role="alert" className="mt-3 text-xs text-[var(--kd-error)]">
            {setupError ?? error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={setupState === "checking" || setupState === "enabling"}
            onClick={() => void enable()}
            className="rounded border border-accent px-3 py-1.5 text-xs text-accent hover:bg-surface-hover disabled:cursor-wait disabled:opacity-50"
          >
            {setupState === "checking"
              ? "Checking…"
              : setupState === "enabling"
                ? "Working…"
                : "Enable KödMem"}
          </button>
          {relinkCandidates.length > 0 && (
            <button
              type="button"
              disabled={setupState === "checking" || setupState === "enabling"}
              onClick={() => setRelinkOpen((open) => !open)}
              className="rounded border border-border px-3 py-1.5 text-xs text-text-dim hover:bg-surface-hover hover:text-text disabled:cursor-wait disabled:opacity-50"
            >
              Relink existing…
            </button>
          )}
        </div>
        {relinkOpen && (
          <div className="mt-3 space-y-1 border-t border-border pt-3">
            {relinkCandidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => void relinkFrom(candidate)}
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-hover"
              >
                <span className="block text-xs text-text">
                  {candidate.displayName}
                </span>
                <span className="block truncate font-mono text-[10px] text-text-dim">
                  {candidate.canonicalRoot}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
