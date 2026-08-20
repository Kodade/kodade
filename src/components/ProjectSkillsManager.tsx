import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ProjectSkillAction, ProjectSkillCell } from "../harness/project-skills";
import type { PlatformIpc } from "../ipc/contract";
import type { HarnessState } from "../store/harness";
import { RELEASE_MANIFEST } from "../release/manifest";
import { abbreviate } from "./ChangeConfirmDialog";

export function ProjectSkillsManager({
  store,
  platform,
  projectRoot,
  pro,
  onClose,
}: {
  store: StoreApi<HarnessState>;
  platform: Pick<PlatformIpc, "pickProjectSkill">;
  projectRoot: string;
  pro: boolean;
  onClose: () => void;
}) {
  const state = useStore(store);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  useEffect(() => {
    store.getState().clearProjectSkill();
  }, [store, projectRoot]);

  useEffect(() => {
    if (!state.projectSkill) return;
    setSelectedTargets(new Set(state.projectSkill.targets.map((target) => target.id)));
  }, [state.projectSkill]);

  const choose = async () => {
    setPicking(true);
    setPickerError(null);
    try {
      const bundle = await platform.pickProjectSkill();
      if (bundle) await store.getState().loadProjectSkill(bundle, projectRoot);
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  };

  const toggleTarget = (targetId: string) => {
    const next = new Set(selectedTargets);
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    setSelectedTargets(next);
  };

  const submit = async (action: ProjectSkillAction) => {
    await store.getState().prepareProjectSkill(action, [...selectedTargets], projectRoot);
    if (store.getState().pendingChange) onClose();
  };

  const model = state.projectSkill;
  const selectedCells = model?.cells.filter((cell) => selectedTargets.has(cell.targetId)) ?? [];
  const hasInstall = selectedCells.some((cell) => cell.status === "ready");
  const hasUpdate = selectedCells.some((cell) => cell.status === "update");
  const hasUninstall = selectedCells.some(
    (cell) => cell.status === "installed" || cell.status === "update",
  );

  return (
    <section
      className="overflow-hidden rounded border border-border bg-surface"
      aria-label="Project skill manager"
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-text-dim">
        <span>project skills</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close project skill manager"
          className="rounded px-1.5 hover:bg-surface-hover hover:text-text"
        >
          ×
        </button>
      </header>
      <div className="p-3 text-xs">
        <p className="text-text">
          choose a skill folder containing <span className="font-mono">SKILL.md</span>
        </p>
        <p className="mt-1 text-text-dim">
          kodade copies a verified text-only skill into agent-recognized directories in this project.
        </p>
        <button
          type="button"
          onClick={() => void choose()}
          disabled={picking || state.projectSkillLoading}
          className="mt-3 rounded border border-accent px-3 py-1 text-accent hover:bg-surface-hover disabled:opacity-50"
        >
          {model ? "choose another skill folder…" : "choose skill folder…"}
        </button>

        {(picking || state.projectSkillLoading) && (
          <p className="mt-2 text-text-dim">reading selected skill…</p>
        )}
        {(pickerError || state.projectSkillError) && (
          <p role="alert" className="mt-2 text-[var(--kd-error)]">
            {pickerError ?? state.projectSkillError}
          </p>
        )}

        {model && (
          <>
            <div className="mt-3 rounded border border-border bg-bg p-2">
              <p className="text-sm text-text">{model.skill.id}</p>
              <p className="mt-1 text-text-dim">{model.skill.description}</p>
              <p className="mt-1 font-mono text-[10px] text-text-dim">
                {model.skill.sourceRoot}
              </p>
            </div>

            <div className="mt-3 space-y-2 rounded border border-border p-2">
              {model.targets.map((target) => {
                const cell = model.cells.find((candidate) => candidate.targetId === target.id);
                return (
                  <label key={target.id} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={selectedTargets.has(target.id)}
                      onChange={() => toggleTarget(target.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-text">{target.clis.join(" + ")}</span>
                      <span className="ml-2 font-mono text-[10px] text-text-dim">
                        {abbreviate(target.path, projectRoot)}
                      </span>
                      {cell && <ProjectSkillBadge cell={cell} />}
                    </span>
                  </label>
                );
              })}
            </div>
            {!pro && RELEASE_MANIFEST.profile === "development" && (
              <p className="mt-2 text-text-dim">
                Ködade Pro adds the shared .agents/skills target for Codex + KödLocal.
              </p>
            )}
            {state.mutationError && (
              <p role="alert" className="mt-2 text-[var(--kd-error)]">
                {state.mutationError}
              </p>
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
                  remove selected…
                </button>
              )}
              {hasUpdate && (
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
          </>
        )}
      </div>
    </section>
  );
}

function ProjectSkillBadge({ cell }: { cell: ProjectSkillCell }) {
  const warning =
    cell.status === "conflict" ||
    cell.status === "modified" ||
    cell.status === "external" ||
    cell.status === "unreadable";
  return (
    <span
      className={`mt-1 block text-[10px] ${
        warning ? "text-[var(--kd-warning)]" : "text-text-dim"
      }`}
    >
      {cell.reason}
    </span>
  );
}
