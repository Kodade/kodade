// Terminal (PTY) session projection for the v2 Workspaces sidebar.
//
// Pure and store-free so it can be unit tested directly. Split terminals carry
// their root's id in `workspaceId` — the same grouping the workspace card
// projection uses — so they nest under that root instead of listing flat.
// Terminals embedded in a chat thread or a KödWork task belong to that thread
// or task, so they never appear as terminals of their own.

import { isChatSession, isWorkSession, type SessionMeta } from "../../store/projects";

export type TerminalGroup = {
  root: SessionMeta;
  children: SessionMeta[];
};

export function projectTerminalGroups(
  sessions: SessionMeta[],
  projectId: string,
): TerminalGroup[] {
  const ownedIds = new Set(
    sessions
      .filter((session) => isChatSession(session) || isWorkSession(session))
      .map((session) => session.id),
  );
  const terminals = sessions.filter(
    (session) =>
      session.projectId === projectId &&
      !isChatSession(session) &&
      !isWorkSession(session) &&
      // Embedded in a chat thread / task workspace: not a standalone terminal.
      !(session.workspaceId && ownedIds.has(session.workspaceId)),
  );
  const terminalIds = new Set(terminals.map((session) => session.id));
  const groups: TerminalGroup[] = [];
  const byRootId = new Map<string, TerminalGroup>();

  // Roots first so a split that appears before its root still nests correctly.
  for (const session of terminals) {
    const isRoot =
      !session.workspaceId ||
      session.workspaceId === session.id ||
      !terminalIds.has(session.workspaceId);
    if (!isRoot) continue;
    const group: TerminalGroup = { root: session, children: [] };
    groups.push(group);
    byRootId.set(session.id, group);
  }
  // A split whose parent is itself a split (a depth-2 chain) has no group to
  // join. Promote it to its own root rather than dropping it from the list.
  for (const session of terminals) {
    if (byRootId.has(session.id)) continue;
    if (byRootId.has(session.workspaceId!)) continue;
    const group: TerminalGroup = { root: session, children: [] };
    groups.push(group);
    byRootId.set(session.id, group);
  }
  for (const session of terminals) {
    if (byRootId.has(session.id)) continue;
    byRootId.get(session.workspaceId!)!.children.push(session);
  }
  return groups;
}
