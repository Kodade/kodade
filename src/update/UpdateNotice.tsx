// The non-blocking update banner (#98): appears only once an update is
// actually found (or later, downloading/ready-to-restart). idle/checking/
// up-to-date/error never render here — a launch check is fully silent, and
// "up to date"/error feedback for a manual check surfaces inline in Settings
// (see UpdateCheckAction) instead of interrupting the workspace.

import { useStore } from "zustand";
import { updateStore } from "./updater";

export function UpdateNotice() {
  const status = useStore(updateStore, (s) => s.status);

  if (status.phase !== "available" && status.phase !== "downloading" && status.phase !== "ready") {
    return null;
  }

  return (
    <div
      role="status"
      className="pointer-events-auto fixed bottom-4 right-4 z-30 w-80 rounded border border-border bg-surface p-3 text-xs shadow-lg"
    >
      {status.phase === "available" && (
        <>
          <p className="text-text">
            Ködade {status.info.version} is available.
          </p>
          {status.info.notes && (
            <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-text-dim">
              {status.info.notes}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => updateStore.getState().dismiss()}
              className="rounded border border-border px-3 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
            >
              dismiss
            </button>
            <button
              type="button"
              onClick={() => void updateStore.getState().install()}
              className="rounded border border-accent px-3 py-1 text-accent hover:bg-surface-hover"
            >
              update
            </button>
          </div>
        </>
      )}

      {status.phase === "downloading" && (
        <>
          <p className="text-text">Downloading {status.info.version}…</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-bg">
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${status.progress ?? 0}%` }}
            />
          </div>
        </>
      )}

      {status.phase === "ready" && (
        <>
          <p className="text-text">
            Ködade {status.info.version} is ready to install.
          </p>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => void updateStore.getState().restart()}
              className="rounded border border-accent px-3 py-1 text-accent hover:bg-surface-hover"
            >
              restart to finish
            </button>
          </div>
        </>
      )}
    </div>
  );
}
