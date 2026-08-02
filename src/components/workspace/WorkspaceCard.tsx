import { useEffect, useRef, useState } from "react";
import type { WorkspaceSession } from "../../activity/activity";
import type { Project } from "../../store/projects";
import { reliableStatusText } from "./metadata";
import { ProjectColorChoices } from "./ProjectColorChoices";

export type WorkspaceActions = {
  activateSession(projectId: string, sessionId: string): void;
  setActiveProject(projectId: string): void;
  addProject(): void | Promise<void>;
  renameSession(sessionId: string, name: string): void;
  closeWorkspace(sessionId: string): void;
  clearSettledWorkspaces(sessionIds: string[]): void;
  setProjectColor(projectId: string, colorId: string | null): void;
  removeProject(projectId: string): void;
};

export function WorkspaceCard({
  session,
  project,
  appearance,
  actions,
}: {
  session: WorkspaceSession;
  project: Project | undefined;
  appearance: "dark" | "light";
  actions: WorkspaceActions;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const sessionTriggerRef = useRef<HTMLButtonElement>(null);
  const colorTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSessionFocus = useRef(false);
  const projectName = project?.name ?? session.projectName;
  const status = reliableStatusText(session);
  const colorPickerId = `workspace-session-colors-${session.sessionId}`;
  const activate = () =>
    actions.activateSession(session.projectId, session.sessionId);
  const cancelRename = () => {
    restoreSessionFocus.current = true;
    setEditing(false);
  };
  const commitRename = (name: string, shouldRestoreFocus: boolean) => {
    actions.renameSession(session.sessionId, name);
    restoreSessionFocus.current = shouldRestoreFocus;
    setEditing(false);
  };
  const selectProjectColor = (colorId: string | null) => {
    actions.setProjectColor(session.projectId, colorId);
    setColorPickerOpen(false);
    colorTriggerRef.current?.focus();
  };
  const alert =
    session.attention === "needs-user"
      ? (session.attentionReason ?? "Needs your attention")
      : null;

  useEffect(() => {
    if (!editing && restoreSessionFocus.current) {
      restoreSessionFocus.current = false;
      sessionTriggerRef.current?.focus();
    }
  }, [editing]);

  return (
    <article
      data-density={session.density}
      title={`Terminal opened from ${project?.path ?? session.projectName} · ${new Date(
        session.createdAt,
      ).toLocaleString()}`}
      className={`kd-workspace-card min-w-0 rounded-md border border-border bg-surface p-2 ${
        session.selected ? "ring-1 ring-accent" : ""
      }`}
      aria-label={`${session.name}, ${projectName}, ${status}${session.selected ? ", selected" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setActionsOpen(true);
      }}
      onKeyDown={(event) => {
        const opensContextMenu =
          event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
        if (opensContextMenu) {
          event.preventDefault();
          event.stopPropagation();
          setActionsOpen(true);
          return;
        }
        if (event.key !== "Escape") return;
        const wasOpen = actionsOpen || colorPickerOpen;
        setActionsOpen(false);
        setColorPickerOpen(false);
        if (wasOpen) {
          event.stopPropagation();
          sessionTriggerRef.current?.focus();
        }
      }}
    >
      <div className="flex min-w-0 items-start gap-1">
        {editing ? (
          <SessionRenameInput
            initial={session.name}
            onCommit={commitRename}
            onCancel={cancelRename}
          />
        ) : (
          <button
            ref={sessionTriggerRef}
            type="button"
            data-workspace-session={session.sessionId}
            onClick={activate}
            onDoubleClick={() => setEditing(true)}
            className="min-w-0 flex-1 text-left outline-none focus:ring-1 focus:ring-accent"
            aria-label={`${session.name}, ${projectName}, ${status}${session.selected ? ", selected" : ""}`}
            aria-current={session.selected || undefined}
          >
            <span className="block min-w-0">
              <span className="block truncate text-sm text-text">
                {session.name}
              </span>
              {alert && (
                <span
                  role="status"
                  className="mt-1 block text-xs text-[var(--kd-warning)]"
                >
                  {alert}
                </span>
              )}
            </span>
          </button>
        )}
        <button
          type="button"
          aria-label={`Close workspace ${session.name}`}
          title="Close workspace"
          onClick={() => actions.closeWorkspace(session.sessionId)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {actionsOpen && (
        <div
          id={`workspace-actions-${session.sessionId}`}
          aria-label={`Actions for ${session.name}`}
          className="mt-2 grid gap-1 border-t border-border pt-2"
        >
          <button
            type="button"
            aria-label={`Rename ${session.name}`}
            onClick={() => {
              setActionsOpen(false);
              setEditing(true);
            }}
            className="rounded px-2 py-1 text-left text-xs text-text-dim hover:bg-surface-hover hover:text-text"
          >
            Rename workspace
          </button>
          <button
            ref={colorTriggerRef}
            type="button"
            aria-label={`Project color for ${projectName}`}
            aria-expanded={colorPickerOpen}
            aria-controls={colorPickerId}
            onClick={() => setColorPickerOpen((open) => !open)}
            className="rounded px-2 py-1 text-left text-xs text-text-dim hover:bg-surface-hover hover:text-text"
          >
            Project color
          </button>
          {colorPickerOpen && (
            <fieldset
              id={colorPickerId}
              aria-label={`Project color for ${projectName}`}
              className="grid grid-cols-4 gap-1 px-2 py-1"
            >
              <ProjectColorChoices
                appearance={appearance}
                selectedColor={project?.color}
                onSelect={selectProjectColor}
              />
            </fieldset>
          )}
        </div>
      )}
    </article>
  );
}

function SessionRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit(name: string, shouldRestoreFocus: boolean): void;
  onCancel(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const [value, setValue] = useState(initial);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(value, true);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelledRef.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!cancelledRef.current) onCommit(value, false);
      }}
      aria-label="Rename session"
      className="h-7 min-w-0 flex-1 rounded bg-bg px-2 text-sm text-text outline-none ring-1 ring-accent"
    />
  );
}
