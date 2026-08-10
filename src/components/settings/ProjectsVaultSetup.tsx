import { useEffect, useState } from "react";
import type {
  MemoryIpc,
  MemoryWorkspace,
  ProjectsVault,
  WorkspaceProjectMapping,
} from "../../ipc/contract";
import { memory as memoryIpc, platform } from "../../ipc/transport";

export type ProjectsVaultIpc = Pick<
  MemoryIpc,
  | "projectsVault"
  | "registerProjectsVault"
  | "workspaceProjectMapping"
  | "mapWorkspaceToProject"
  | "projectWorkspaceMappings"
>;

export function ProjectsVaultSetup({
  workspace,
  ipc = memoryIpc,
  pickFolder = () => platform.pickFolder(),
}: {
  workspace: MemoryWorkspace | null;
  ipc?: ProjectsVaultIpc;
  pickFolder?: () => Promise<string | null>;
}) {
  const [vault, setVault] = useState<ProjectsVault | null>(null);
  const [mapping, setMapping] = useState<WorkspaceProjectMapping | null>(null);
  const [relatedWorkspaces, setRelatedWorkspaces] = useState<
    WorkspaceProjectMapping[]
  >([]);
  const [projectDraft, setProjectDraft] = useState({ id: "", name: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const nextVault = (await ipc.projectsVault()) ?? null;
        const nextMapping = workspace
          ? await ipc.workspaceProjectMapping(workspace.id)
          : null;
        const nextRelated = nextMapping
          ? await ipc.projectWorkspaceMappings(nextMapping.projectId)
          : [];
        if (cancelled) return;
        setVault(nextVault);
        setMapping(nextMapping);
        setRelatedWorkspaces(nextRelated);
        setProjectDraft(
          nextMapping
            ? {
                id: nextMapping.projectId,
                name: nextMapping.projectDisplayName,
              }
            : suggestedProject(workspace),
        );
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ipc, workspace?.id]);

  const chooseVault = async () => {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const root = await pickFolder();
      if (!root) return;
      setVault(await ipc.registerProjectsVault(root));
      if (!mapping && !projectDraft.id) {
        setProjectDraft(suggestedProject(workspace));
      }
    } catch (registrationError) {
      setError(errorMessage(registrationError));
    } finally {
      setSaving(false);
    }
  };

  const selectProject = (id: string) => {
    const selected = vault?.projects.find((project) => project.id === id);
    setProjectDraft({
      id,
      name:
        selected && selected.displayName !== selected.id
          ? selected.displayName
          : projectNameFromId(id),
    });
  };

  const saveMapping = async () => {
    if (!workspace || !projectDraft.id.trim() || !projectDraft.name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await ipc.mapWorkspaceToProject(
        workspace.id,
        mapping?.projectId ?? null,
        projectDraft.id.trim(),
        projectDraft.name.trim(),
      );
      const related = await ipc.projectWorkspaceMappings(saved.projectId);
      setMapping(saved);
      setProjectDraft({ id: saved.projectId, name: saved.projectDisplayName });
      setRelatedWorkspaces(related);
    } catch (mappingError) {
      setError(errorMessage(mappingError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label="Projects vault mapping"
      className="shrink-0 border-b border-border bg-surface/60 px-4 py-3"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-48 flex-1">
          <div className="text-xs font-medium text-text">Projects vault</div>
          <p className="mt-0.5 text-[11px] text-text-dim">
            Portable project identity and shared Obsidian knowledge. Existing
            repo-local KödMem remains active until migration is complete.
          </p>
          {vault && (
            <p className="mt-1 truncate font-mono text-[10px] text-text-dim">
              {vault.canonicalRoot}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={loading || saving}
          onClick={() => void chooseVault()}
          className="memory-action"
        >
          {vault ? "Change projects vault…" : "Choose projects vault…"}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--kd-error)]">
          {error}
        </p>
      )}

      {vault && workspace && (
        <div className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-[minmax(150px,0.8fr)_minmax(180px,1fr)_auto]">
          <label className="grid gap-1 text-[10px] text-text-dim">
            logical project ID
            <input
              aria-label="logical project ID"
              list="projects-vault-projects"
              value={projectDraft.id}
              onChange={(event) => selectProject(event.target.value)}
              placeholder="project-slug"
              className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-text outline-none focus:border-accent"
            />
            <datalist id="projects-vault-projects">
              {vault.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.displayName}
                </option>
              ))}
            </datalist>
          </label>
          <label className="grid gap-1 text-[10px] text-text-dim">
            project name
            <input
              aria-label="logical project name"
              value={projectDraft.name}
              onChange={(event) =>
                setProjectDraft((draft) => ({
                  ...draft,
                  name: event.target.value,
                }))
              }
              placeholder={workspace.displayName}
              className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            disabled={
              saving || !projectDraft.id.trim() || !projectDraft.name.trim()
            }
            onClick={() => void saveMapping()}
            className="memory-action self-end"
          >
            Save project mapping
          </button>
          {mapping && (
            <div className="text-[10px] text-text-dim sm:col-span-3">
              <span>Mapped to {mapping.projectId}</span>
              <span className="mx-1">·</span>
              <span>
                {relatedWorkspaces.length} {relatedWorkspaces.length === 1 ? "workspace uses" : "workspaces use"} this project identity
              </span>
            </div>
          )}
        </div>
      )}

      {vault && !workspace && !loading && (
        <p className="mt-2 text-[11px] text-text-dim">
          Enable KödMem for this workspace before mapping it to a logical project.
        </p>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function suggestedProject(workspace: MemoryWorkspace | null) {
  if (!workspace) return { id: "", name: "" };
  return {
    id: projectIdFromName(workspace.displayName),
    name: workspace.displayName,
  };
}

function projectIdFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "") || "project";
}

function projectNameFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
