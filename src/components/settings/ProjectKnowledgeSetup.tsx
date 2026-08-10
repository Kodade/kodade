import { useState } from "react";
import type { MemoryIpc, ProjectScaffoldPlan } from "../../ipc/contract";

export type ProjectKnowledgeIpc = Pick<
  MemoryIpc,
  "previewProjectScaffold" | "applyProjectScaffold" | "openProjectInObsidian"
>;

export function ProjectKnowledgeSetup({
  workspaceId,
  ipc,
}: {
  workspaceId: string;
  ipc: ProjectKnowledgeIpc;
}) {
  const [plan, setPlan] = useState<ProjectScaffoldPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const preview = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPlan(await ipc.previewProjectScaffold(workspaceId));
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
      setPlan(await ipc.previewProjectScaffold(workspaceId));
    } catch (applyError) {
      setError(errorMessage(applyError));
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
      aria-label="Project knowledge setup"
      className="mt-3 border-t border-border pt-3 sm:col-span-3"
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-48 flex-1">
          <div className="text-xs font-medium text-text">Project knowledge</div>
          <p className="mt-0.5 text-[11px] text-text-dim">
            Preview and create only missing Obsidian roles. Existing notes stay
            byte-for-byte unchanged, and repository files are never copied.
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
