import type { WorkspaceSession } from "../../activity/activity";

// All sidebar copy is derived from the projection's low-sensitivity metadata.
// Deliberately never add terminal output or an inferred approval request here.
export function reliableStatusText(session: WorkspaceSession): string {
  if (session.attention === "needs-user") return "Needs your attention";
  if (session.attention === "unread") return "Unread activity";
  if (session.status === "working") {
    return session.foregroundProcess
      ? `Working in ${session.foregroundProcess}`
      : "Working";
  }
  if (session.status === "failed") {
    return `Exited with code ${session.exitCode ?? "unknown"}`;
  }
  if (session.status === "exited") {
    return `Exited with code ${session.exitCode ?? 0}`;
  }
  return "Shell idle";
}

export function matchesWorkspaceSearch(
  session: WorkspaceSession,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [
    session.name,
    session.projectName,
    session.foregroundProcess ?? "",
    session.status,
    reliableStatusText(session),
  ].some((value) => value.toLocaleLowerCase().includes(normalized));
}
