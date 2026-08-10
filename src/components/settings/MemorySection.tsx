import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { MemoryWorkspace } from "../../ipc/contract";
import { memory as memoryIpc } from "../../ipc/transport";
import { nativeEquals } from "../../platform/native-path";
import { appStore, memoryStore } from "../../store/appStore";
import { MemoryPane } from "../MemoryPane";
import { ProjectsVaultSetup } from "./ProjectsVaultSetup";

type SetupState = "checking" | "disabled" | "enabling" | "ready";

export function MemorySection() {
  const activeProjectId = useStore(appStore, (state) => state.activeProjectId);
  const projects = useStore(appStore, (state) => state.projects);
  const workspace = useStore(memoryStore, (state) => state.workspace);
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

  useEffect(() => {
    let cancelled = false;
    void memoryIpc
      .databasePath()
      .then((path) => {
        if (!cancelled) setDatabasePath(path);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  const enable = async () => {
    if (!project || setupState === "enabling") return;
    setSetupState("enabling");
    try {
      await memoryStore
        .getState()
        .createWorkspace(project.path, project.name, project.color ?? null);
      setSetupState("ready");
    } catch {
      setSetupState("disabled");
    }
  };

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
        <ProjectsVaultSetup workspace={null} />
        <div className="flex flex-1 items-center justify-center text-xs text-text-dim">
          Open a project to set up KödMem.
        </div>
      </div>
    );
  }

  if (workspaceMatches && setupState === "ready") {
    return (
      <div data-settings-memory="true" className="flex h-full min-h-0 flex-col">
        <ProjectsVaultSetup workspace={workspace} />
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
      <ProjectsVaultSetup workspace={null} />
      <div className="m-auto w-full max-w-lg rounded border border-border bg-surface p-5">
        <div className="text-sm font-medium text-text">{project.name}</div>
        <p className="mt-1 text-xs text-text-dim">
          Memory for this project. Stored outside the repo to keep it out of Git
          and sync.
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
