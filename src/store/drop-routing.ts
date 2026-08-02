import type { FileDropEvent, PlatformIpc } from "../ipc/contract";
import { chatDropHandler } from "../chat/drop-target";
import { isTerminalDropPosition } from "../terminal/drop-target";
import { pasteKindForShell, shellEscapePaths } from "../terminal/paste";
import type { RegistryLike, ProjectsState } from "./projects";

type DropProjectsStore = {
  getState: () => Pick<
    ProjectsState,
    | "activeProjectId"
    | "activeSessionByProject"
    | "sessions"
    | "shellBase"
    | "addProject"
  >;
};

export type DropRoutingDeps = {
  platform: Pick<PlatformIpc, "isDir">;
  projects: DropProjectsStore;
  registry: Required<Pick<RegistryLike, "paste">>;
};

// A terminal-targeted drop pastes into the active session. Without a LIVE
// session (no project yet, or the shell exited) the drop falls through to the
// normal routing below, so dropping a folder onto the empty terminal still
// adds it as a project instead of vanishing.
export async function routeFileDrop(
  drop: FileDropEvent,
  { platform, projects, registry }: DropRoutingDeps,
): Promise<void> {
  if (isTerminalDropPosition(drop.position)) {
    const state = projects.getState();
    const activeSessionId = state.activeProjectId
      ? state.activeSessionByProject[state.activeProjectId]
      : undefined;
    const active = activeSessionId
      ? state.sessions.find((s) => s.id === activeSessionId)
      : undefined;
    if (active && !active.exited && drop.paths.length > 0) {
      const escaped = shellEscapePaths(
        drop.paths,
        pasteKindForShell(state.shellBase),
      );
      if (escaped) await registry.paste(active.id, escaped);
      return;
    }
    // fall through: nothing live to paste into
  }

  // A drop on the chat pane attaches the files to the composer. Checked after
  // the terminal because the terminal split renders INSIDE the chat pane's
  // region — the more specific target wins.
  const attach = chatDropHandler(drop.position);
  if (attach && drop.paths.length > 0) {
    attach(drop.paths);
    return;
  }

  // Preserve the pre-terminal-drop behavior for every other window location.
  for (const path of drop.paths) {
    try {
      if (await platform.isDir(path))
        await projects.getState().addProject(path);
    } catch (err) {
      console.error(`kodade: could not add dropped path ${path}:`, err);
    }
  }
}
