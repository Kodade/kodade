// Wiring between a persona/run row and the Agents tab (#64, slice 2; skills in
// #65).
//
// The run engine is untouched: launching creates a normal KödWork work session
// and pre-fills its draft through the store's own setters (setProvider /
// setOutcome), so the task then runs on the existing spawn path with all its
// scoped-permission behavior. Selecting a run just points the Agents tab's run
// area at an already-registered task — no files/editor tab is opened, because
// in v2 the task detail lives inside the Agents tab, not the Editor tab.
//
// A persona's KödSkills are handled before the task is opened, through the SAME
// loadKodSkills → prepareKodSkills path the KödHarness picker uses: the install
// is staged for review, never written silently. Anything that can't be staged
// becomes a non-blocking notice — a skill problem must not stop a run.

import type { StoreApi } from "zustand/vanilla";
import type { ProjectsState } from "../../store/projects";
import type { KodworkState } from "../../kodwork/store";
import {
  isPendingChangeOwned,
  type HarnessState,
  type PendingChangeOwner,
} from "../../store/harness";
import type { AgentsState } from "../../agents/agents-store";
import type { AgentPersona } from "../../agents/persona";
import { personaDraftInput } from "../../agents/persona-run";
import { planPersonaSkills } from "../../agents/persona-skills";

// A pending-change owner unique to the persona-skills surface, so a staged
// skill install never collides with a KödHarness-, KödMem-, or Connections-
// owned change.
export function personaSkillsOwner(projectRoot: string): PendingChangeOwner {
  return { surface: "skills", scopeId: projectRoot };
}

export type LaunchPersonaRunResult = {
  taskId: string | null;
  // Non-blocking message about the persona's skills, or null.
  skillsNotice: string | null;
};

// Register an existing run in the work store (if needed) and show it in the tab.
export async function openAgentRun(
  projectsStore: StoreApi<ProjectsState>,
  workStore: StoreApi<KodworkState>,
  agentsStore: StoreApi<AgentsState>,
  projectId: string,
  taskId: string,
): Promise<void> {
  if (projectsStore.getState().activeProjectId !== projectId) {
    await projectsStore.getState().setActiveProject(projectId);
  }
  await workStore.getState().openTask(taskId, projectId);
  agentsStore.getState().selectRun(taskId);
}

// Launch a fresh run from a persona. `taskId` is null when a work session could
// not be created (e.g. a build without KödWork).
export async function launchPersonaRun(
  projectsStore: StoreApi<ProjectsState>,
  workStore: StoreApi<KodworkState>,
  agentsStore: StoreApi<AgentsState>,
  projectId: string,
  persona: AgentPersona,
  skills?: {
    harness: StoreApi<HarnessState>;
    projectRoot: string | null;
    providerLabel?: string;
  },
): Promise<LaunchPersonaRunResult> {
  if (projectsStore.getState().activeProjectId !== projectId) {
    await projectsStore.getState().setActiveProject(projectId);
  }
  // Skills first: the run must not open before its skills have been staged for
  // install (the user confirms the staged change from the run area).
  const skillsNotice = skills ? await stagePersonaSkills(persona, skills) : null;
  const taskId = projectsStore.getState().addWorkSession(projectId);
  if (!taskId) return { taskId: null, skillsNotice };
  await workStore.getState().openTask(taskId, projectId);
  const draft = personaDraftInput(persona);
  // Provider first: setProvider clears any resume id, and a fresh draft has
  // none, so order is only about staying consistent with the composer.
  workStore.getState().setProvider(taskId, draft.providerId);
  workStore.getState().setOutcome(taskId, draft.outcome);
  agentsStore.getState().selectRun(taskId);
  return { taskId, skillsNotice };
}

// Stage the persona's missing KödSkills for install through the harness store's
// existing review flow. Returns a notice, or null when there is nothing to say.
// Never throws and never blocks the launch.
async function stagePersonaSkills(
  persona: AgentPersona,
  deps: { harness: StoreApi<HarnessState>; projectRoot: string | null; providerLabel?: string },
): Promise<string | null> {
  if (persona.skills.length === 0) return null;
  const { harness, projectRoot } = deps;
  const label = deps.providerLabel ?? persona.providerId;
  if (!projectRoot) {
    return `This agent's skills weren't installed — open a workspace folder first. The run still launches.`;
  }
  const owner = personaSkillsOwner(projectRoot);
  try {
    // Always re-inspect: a cached model goes stale the moment a skill is
    // installed (here or from the KödHarness pane). It is one scan.
    await harness.getState().loadKodSkills(projectRoot);
    const plan = planPersonaSkills(persona, harness.getState().kodSkills ?? null, label);
    if (plan.skillIds.length === 0) return plan.notice;

    // Staging replaces whatever is staged (stageBatch has no owner check), so a
    // foreign un-confirmed change must never be clobbered by a launch. Our own
    // leftover from an earlier launch is safe to drop — staging is re-runnable.
    const staged = harness.getState().pendingChange ?? null;
    // Read the title first: isPendingChangeOwned is a type predicate, so the
    // "not ours" branch would otherwise narrow `staged` away entirely.
    const stagedTitle = staged?.title ?? "";
    if (staged && !isPendingChangeOwned(staged, owner)) {
      return `This agent's KödSkills weren't installed — finish or cancel the pending “${stagedTitle}” change first. The run still launches.`;
    }
    if (staged) harness.getState().cancelPendingChange(owner);

    await harness
      .getState()
      .prepareKodSkills("install", plan.skillIds, plan.targetIds, projectRoot, owner);
    // Staging can legitimately produce nothing (licence gating, no adapter);
    // the store records why in mutationError. Surface it, don't swallow it.
    if (!isPendingChangeOwned(harness.getState().pendingChange ?? null, owner)) {
      const reason = harness.getState().mutationError;
      return `${plan.skillIds.join(", ")} couldn't be staged for install${reason ? `: ${reason}` : ""}. The run still launches.`;
    }
    return plan.notice ??
      `Review the staged KödSkills install for ${label} to finish setting this agent up. The run still launches.`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Couldn't install this agent's KödSkills: ${reason}. The run still launches.`;
  }
}
