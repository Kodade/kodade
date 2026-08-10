import { useState } from "react";
import type {
  LegacyMigrationApply,
  LegacyMigrationPlan,
  MemoryIpc,
  ProjectScaffoldPlan,
} from "../../ipc/contract";

export type ProjectKnowledgeIpc = Pick<
  MemoryIpc,
  | "previewProjectScaffold"
  | "applyProjectScaffold"
  | "previewLegacyMigration"
  | "applyLegacyMigration"
  | "rollbackLegacyMigration"
  | "openProjectInObsidian"
>;

export function ProjectKnowledgeSetup({
  workspaceId,
  ipc,
}: {
  workspaceId: string;
  ipc: ProjectKnowledgeIpc;
}) {
  const [plan, setPlan] = useState<ProjectScaffoldPlan | null>(null);
  const [migration, setMigration] = useState<LegacyMigrationPlan | null>(null);
  const [migrationResult, setMigrationResult] =
    useState<LegacyMigrationApply | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const preview = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const nextPlan = await ipc.previewProjectScaffold(workspaceId);
      setPlan(nextPlan);
      if (nextPlan.operations.length === 0) {
        setMigration(await ipc.previewLegacyMigration(workspaceId));
      } else {
        setMigration(null);
      }
    } catch (previewError) {
      setError(errorMessage(previewError));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan || plan.operations.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const applied = await ipc.applyProjectScaffold(
        workspaceId,
        plan.fingerprint,
      );
      setResult(
        `Created ${applied.created.length} missing ${
          applied.created.length === 1 ? "item" : "items"
        }. Existing notes were left unchanged.`,
      );
      const nextPlan = await ipc.previewProjectScaffold(workspaceId);
      setPlan(nextPlan);
      setMigration(await ipc.previewLegacyMigration(workspaceId));
    } catch (applyError) {
      setError(errorMessage(applyError));
    } finally {
      setBusy(false);
    }
  };

  const applyMigration = async () => {
    if (!migration?.canApply || busy) return;
    setBusy(true);
    setError(null);
    try {
      const applied = await ipc.applyLegacyMigration(
        workspaceId,
        migration.fingerprint,
      );
      setMigrationResult(applied);
      setResult(
        `Migrated legacy project memory and retained every source. Recovery backup: ${applied.backupPath}`,
      );
      setMigration(await ipc.previewLegacyMigration(workspaceId));
    } catch (migrationError) {
      setError(errorMessage(migrationError));
      try {
        setMigration(await ipc.previewLegacyMigration(workspaceId));
      } catch {
        // Keep the original apply error visible when recovery discovery fails.
      }
    } finally {
      setBusy(false);
    }
  };

  const rollbackMigration = async () => {
    const recovery = migrationResult
      ? {
          migrationId: migrationResult.migrationId,
          manifestSha256: migrationResult.manifestSha256,
        }
      : migration?.recovery;
    if (!recovery || busy) return;
    setBusy(true);
    setError(null);
    try {
      const rolledBack = await ipc.rollbackLegacyMigration(
        workspaceId,
        recovery.migrationId,
        recovery.manifestSha256,
      );
      setMigrationResult(null);
      setResult(
        `Rolled back migration (${rolledBack.restored} restored, ${rolledBack.removed} removed). Legacy sources were retained.`,
      );
      setMigration(await ipc.previewLegacyMigration(workspaceId));
    } catch (rollbackError) {
      setError(errorMessage(rollbackError));
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.openProjectInObsidian(workspaceId);
    } catch (openError) {
      setError(errorMessage(openError));
    } finally {
      setBusy(false);
    }
  };

  const canOpen =
    plan !== null &&
    !plan.operations.some((operation) =>
      operation.relativePath.endsWith("/Project.md"),
    );

  return (
    <section
      id="project-knowledge-setup"
      aria-label="Project knowledge setup"
      className="mt-3 border-t border-border pt-3 sm:col-span-3"
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-48 flex-1">
          <div className="text-xs font-medium text-text">Project knowledge</div>
          <p className="mt-0.5 text-[11px] text-text-dim">
            Preview and create only missing Obsidian roles. Existing notes stay
            byte-for-byte unchanged. An approved legacy-memory migration copies
            eligible history into canonical notes while retaining every source.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void preview()}
          className="memory-action"
        >
          {plan ? "Refresh preview" : "Preview knowledge setup"}
        </button>
        <button
          type="button"
          disabled={busy || !canOpen}
          onClick={() => void open()}
          className="memory-action"
        >
          Open in Obsidian
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--kd-error)]">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="mt-2 text-xs text-[var(--kd-success)]">
          {result}
        </p>
      )}

      {plan && plan.operations.length === 0 && (
        <p className="mt-2 text-xs text-[var(--kd-success)]">
          Project knowledge is ready.
        </p>
      )}

      {migration && migration.status !== "noLegacy" && (
        <div className="mt-2 rounded border border-border bg-bg/60 p-2">
          <div className="text-[11px] font-medium text-text">
            Legacy KödMem migration
          </div>
          <p className="mt-1 text-[10px] text-text-dim">
            Target project: {migration.projectDisplayName} (
            <code>{migration.projectId}</code>)
          </p>
          <p className="mt-1 text-[10px] text-text-dim">
            {migration.status === "complete"
              ? "Projects-vault is authoritative for every local legacy snapshot. Sources remain unchanged."
              : `${migration.counts.sourceFiles} files, ${migration.counts.memories} records, and ${migration.counts.checkpoints} checkpoints were detected across ${migration.sources.length} mapped workspaces. Sources remain unchanged.`}
          </p>
          {migration.createsLocalRecoveryBackup && (
            <p className="mt-1 text-[10px] text-text-dim">
              Apply creates a local recovery backup, validates canonical
              Markdown and its derived index, then writes the Project.md
              cutover receipt as the final vault change.
            </p>
          )}
          {migration.systemOperations.length > 0 && (
            <ol className="mt-2 grid gap-1">
              {migration.systemOperations.map((operation) => (
                <li
                  key={`${operation.sequence}-${operation.kind}`}
                  className="rounded border border-border/70 px-2 py-1 text-[10px]"
                >
                  <span className="text-text-dim">
                    {operation.sequence}. {operation.kind}
                  </span>{" "}
                  <code>{operation.target}</code>
                  {operation.localOnly ? " (local only)" : ""}
                </li>
              ))}
            </ol>
          )}
          {migration.operations.length > 0 && (
            <ul className="mt-2 grid gap-1">
              {migration.operations.map((operation, index) => (
                <li
                  key={`${operation.targetRelativePath}-${index}`}
                  className="rounded border border-border/70 px-2 py-1 text-[10px]"
                >
                  <span className="text-text-dim">{operation.action}</span>{" "}
                  <code>{operation.sourceRelativePath ?? operation.sourceKind}</code>{" "}
                  <span aria-hidden="true">→</span>{" "}
                  <code>{operation.targetRelativePath}</code>
                  {operation.conflict && (
                    <div className="mt-1 text-[var(--kd-error)]">
                      {operation.conflict}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {migration.canApply && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void applyMigration()}
              className="memory-action mt-2"
            >
              Migrate and retain sources
            </button>
          )}
          {migration.status === "blocked" && (
            <p role="alert" className="mt-2 text-xs text-[var(--kd-error)]">
              {migration.recovery
                ? recoveryMessage(migration.recovery.phase)
                : "Resolve every conflict, then refresh the preview. Nothing has been written."}
            </p>
          )}
          {(migrationResult || migration.recovery?.canRollback) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void rollbackMigration()}
              className="memory-action mt-2"
            >
              {migration.recovery?.phase === "rollingBack"
                ? "Resume rollback"
                : "Roll back unchanged migration outputs"}
            </button>
          )}
        </div>
      )}

      {plan && plan.operations.length > 0 && (
        <div className="mt-2 rounded border border-border bg-bg/60 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-text">
              {plan.operations.length} missing{" "}
              {plan.operations.length === 1 ? "item" : "items"}
            </span>
            <details className="text-[9px] text-text-dim">
              <summary className="cursor-pointer">Plan details</summary>
              <code className="mt-1 block max-w-72 break-all">
                Verification fingerprint: {plan.fingerprint}
              </code>
            </details>
          </div>
          <ul className="mt-2 grid gap-1.5">
            {plan.operations.map((operation) => (
              <li
                key={operation.relativePath}
                className="rounded border border-border/70 px-2 py-1.5 text-[10px]"
              >
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-text-dim">
                    {operation.kind === "createDirectory"
                      ? "Create folder"
                      : "Create file"}
                  </span>
                  <code className="break-all text-text">
                    {operation.relativePath}
                  </code>
                </div>
                {operation.content !== null && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-text-dim">
                      Generated content
                    </summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface p-2 text-[9px] text-text">
                      {operation.content}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() => void apply()}
            className="memory-action mt-2"
          >
            Create {plan.operations.length} missing{" "}
            {plan.operations.length === 1 ? "item" : "items"}
          </button>
        </div>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryMessage(
  phase: NonNullable<LegacyMigrationPlan["recovery"]>["phase"],
): string {
  switch (phase) {
    case "rollingBack":
      return "Rollback was interrupted. Resume it to restore the remaining unchanged outputs.";
    case "markdownWritten":
      return "Migration was interrupted after canonical outputs were written. Retry only when offered, or roll back the unchanged outputs.";
    case "cutover":
      return "Migration reached cutover but local recovery is incomplete. Roll back only unchanged outputs or retry when offered.";
    case "prepared":
      return "Migration recovery was prepared and may include a pending authority marker. Retry only when offered, or roll back safely.";
    case "complete":
      return "Migration is complete and remains rollbackable while its outputs are unchanged.";
  }
}
