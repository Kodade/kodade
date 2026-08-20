// The sign-in escape hatch, shared by every surface that can hit an auth
// failure (KödChat's transcript card, KödWork's task view, and the Providers
// settings section). It opens a real terminal running the provider's own login
// flow. Ködade wraps that flow; it never sees or stores the credential.

import type { StoreApi } from "zustand/vanilla";
import type { ProjectsState } from "../store/projects";
import { isChatSession } from "../store/projects";
import { AVAILABLE_PROVIDERS, loginCommandFor } from "./catalog";
import { buildRemoteProgramLaunch } from "../ssh/command";
import { remoteSessionBase, remoteTargetForProjectId } from "../ssh/model";

// True when a login terminal has somewhere to open. The chat-first desktop
// shell hangs every local PTY off the selected chat thread, so a project with
// no chat selected has no terminal host yet; a remote project always opens its
// own session. Callers disable the login affordance rather than let it fail.
export function canOpenLoginTerminal(state: ProjectsState): boolean {
  const projectId = state.activeProjectId;
  if (!projectId) return false;
  if (remoteTargetForProjectId(state.remoteTargets, projectId)) return true;
  const sessionId = state.activeSessionByProject[projectId];
  return state.sessions.some(
    (session) =>
      session.id === sessionId &&
      session.projectId === projectId &&
      isChatSession(session),
  );
}

// Rejects when there is no terminal to open into (see canOpenLoginTerminal) so
// a caller can say so instead of leaving a dead button.
export async function openLoginTerminal(
  store: StoreApi<ProjectsState>,
  providerId: string,
): Promise<void> {
  const provider = AVAILABLE_PROVIDERS.find(
    (candidate) => candidate.id === providerId,
  );
  if (!provider) throw new Error(`unknown provider: ${providerId}`);
  const state = store.getState();
  const target = state.activeProjectId
    ? remoteTargetForProjectId(state.remoteTargets, state.activeProjectId)
    : null;
  const command = loginCommandFor(provider, target !== null);
  await state.launchInSession(
    target ? buildRemoteProgramLaunch(command) : command,
    target ? remoteSessionBase(provider.id) : provider.id,
  );
}
