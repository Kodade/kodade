// Manual "Check for updates…" action for Settings → General (#98). Unlike
// the launch check, a manual click always reports something — up to date, an
// error, or (same as launch) the non-blocking UpdateNotice banner once a
// version is found.

import { useStore } from "zustand";
import { SettingsCard, SettingsRow } from "../components/settings/SettingsCard";
import { updateStore } from "./updater";

function statusLabel(
  status: ReturnType<typeof updateStore.getState>["status"],
): string | null {
  switch (status.phase) {
    case "checking":
      return "checking…";
    case "up-to-date":
      return "you're on the latest version";
    case "available":
      return `${status.info.version} is available — see the update notice`;
    case "downloading":
      return "downloading…";
    case "ready":
      return "ready — restart to finish";
    case "error":
      return `couldn't check for updates: ${status.message}`;
    case "idle":
      return null;
  }
}

export function UpdateCheckAction() {
  const status = useStore(updateStore, (s) => s.status);
  const busy = status.phase === "checking" || status.phase === "downloading";
  const label = statusLabel(status);

  return (
    <SettingsCard title="updates">
      <SettingsRow
        name="Check for updates"
        description={label ?? "Ködade checks automatically on launch."}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => void updateStore.getState().checkForUpdate()}
          className="rounded border border-border px-3 py-1 text-xs text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
        >
          {busy ? "checking…" : "check for updates…"}
        </button>
      </SettingsRow>
    </SettingsCard>
  );
}
