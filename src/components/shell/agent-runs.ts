// Wiring between a persona/run row and the Agents tab (#64, slice 2).
//
// The run engine is untouched: launching creates a normal KödWork work session
// and pre-fills its draft through the store's own setters (setProvider /
// setOutcome), so the task then runs on the existing spawn path with all its
// scoped-permission behavior. Selecting a run just points the Agents tab's run
// area at an already-registered task — no files/editor tab is opened, because
// in v2 the task detail lives inside the Agents tab, not the Editor tab.

import type { StoreApi } from "zustand/vanilla";
import type { ProjectsState } from "../../store/projects";
import type { KodworkState } from "../../kodwork/store";
import type { AgentsState } from "../../agents/agents-store";
import type { AgentPersona } from "../../agents/persona";
import { personaDraftInput } from "../../agents/persona-run";

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

// Launch a fresh run from a persona. Returns the new task id, or null when a
// work session could not be created (e.g. a build without KödWork).
export async function launchPersonaRun(
  projectsStore: StoreApi<ProjectsState>,
  workStore: StoreApi<KodworkState>,
  agentsStore: StoreApi<AgentsState>,
  projectId: string,
  persona: AgentPersona,
): Promise<string | null> {
  if (projectsStore.getState().activeProjectId !== projectId) {
    await projectsStore.getState().setActiveProject(projectId);
  }
  const taskId = projectsStore.getState().addWorkSession(projectId);
  if (!taskId) return null;
  await workStore.getState().openTask(taskId, projectId);
  const draft = personaDraftInput(persona);
  // Provider first: setProvider clears any resume id, and a fresh draft has
  // none, so order is only about staying consistent with the composer.
  workStore.getState().setProvider(taskId, draft.providerId);
  workStore.getState().setOutcome(taskId, draft.outcome);
  agentsStore.getState().selectRun(taskId);
  return taskId;
}
