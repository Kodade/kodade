// The sign-in escape hatch, shared by every surface that can hit an auth
// failure (KödChat's transcript card, KödWork's task view, and the Providers
// settings section). It opens a real terminal running the provider's own login
// flow. Ködade wraps that flow; it never sees or stores the credential.

import type { StoreApi } from "zustand/vanilla";
import type { ProjectsState } from "../store/projects";
import { AVAILABLE_PROVIDERS, loginCommandFor } from "./catalog";
import { buildRemoteProgramLaunch } from "../ssh/command";
import { remoteSessionBase, remoteTargetForProjectId } from "../ssh/model";

// True when a login terminal has somewhere to open. A login shell now hosts at
// project scope, so any active project can open one whether or not a chat is
// selected (v2.0 P4 slice 3); a remote project always opens its own session.
// Only a project-less state has no host. Callers disable the login affordance
// rather than let it fail.
export function canOpenLoginTerminal(state: ProjectsState): boolean {
  return state.activeProjectId !== null;
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
