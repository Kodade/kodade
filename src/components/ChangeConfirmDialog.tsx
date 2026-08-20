// The plan → apply confirm dialog for a staged KödHarness change.
//
// It says what will happen, shows the exact change (a diff for an MCP merge, a
// file list for a skill directory, a batch summary when several changes apply
// together), and offers [cancel] [apply]. Extracted from the retired KödHarness
// pane (issue #63): the surfaces that still stage changes — KödSkills, project
// skills, add-MCP-server, and KödMem onboarding — all share this one dialog.
//
// Follows SettingsPopover's focus/Escape/click-away discipline: focus moves in
// on open, Escape and an outside pointer both cancel.

import { useEffect, useRef } from "react";
import type { ConfigChange } from "../harness/contract";
import type { PendingChange } from "../store/harness";

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
      {/* `dir-rename` has no summary of its own: its only producer was the
          retired pane's enable/disable toggle, and the store API that stages it
          (prepareToggle) is dead, flagged for a later cleanup. */}
      {isBatch ? (
        <BatchSummary items={items} projectRoot={projectRoot} />
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
              : change.format === "skill-dir"
                ? "apply"
                : "apply merge"}
        </button>
      </div>
    </div>
  );
}

// Several staged changes applied as one reversible batch — how a KödSkills or
// project-skill install across multiple targets is presented.
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

// A skill directory install/update/uninstall.
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

// The byte-write preview: the file, the exact key(s) touched, a diff, and the
// backup/restore promise. For an MCP merge this is the "your other servers are
// untouched" reassurance.
function MergeSummary({ change, projectRoot }: { change: ConfigChange; projectRoot: string }) {
  const isMerge = change.touchedKeys != null && change.touchedKeys.length > 0;
  const operation = change.mcpOperation === "update" ? "update" : "merge";
  return (
    <>
      <p className="text-text">
        {isMerge
          ? `Ködade will ${operation} one entry. your other servers are untouched.`
          : "Ködade will save this file."}{" "}
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

// A compact unified diff: removed lines (−) then added lines (+) per hunk.
// Purely presentational over the ConfigChange.diff the plan produced.
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

// Shorten a path for display: relative to the project root when it sits under
// it, otherwise the path as-is.
export function abbreviate(path: string, projectRoot: string): string {
  if (path === projectRoot) return ".";
  if (path.startsWith(projectRoot)) {
    const rest = path.slice(projectRoot.length).replace(/^[/\\]/, "");
    return rest || ".";
  }
  return path;
}
