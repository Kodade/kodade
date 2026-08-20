// The v2 shell's Agents tab (#64, slice 2). It replaces the placeholder with a
// real surface: a persona rail (app-wide and current-workspace scopes), a
// persona editor (name, provider, system prompt, KödSkills, and a disabled
// Connections affordance that lands in slice 4), and a run area that mounts the
// existing KödWork task pane — the same component, not a fork — so a launched
// persona keeps durable progress, scoped permissions, review, and recurrence.
//
// The run engine is untouched: launching pre-fills a normal task draft through
// the store's own setters and runs it on the existing spawn path. Run history
// stays in the Workspaces sidebar's shared green/red rows.

import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import {
  agentsStore as defaultAgentsStore,
  appStore,
  harnessStore as defaultHarnessStore,
  kodworkStore,
} from "../../store/appStore";
import type { AgentsState } from "../../agents/agents-store";
import { personaScopeKey } from "../../agents/agents-store";
import { MAX_NAME_CHARS, MAX_PROMPT_CHARS, type AgentPersona } from "../../agents/persona";
import type { PersonaScope } from "../../agents/persona-store";
import type { KodworkState } from "../../kodwork/store";
import type { HarnessState } from "../../store/harness";
import type { ProjectsState } from "../../store/projects";
import { AVAILABLE_PROVIDERS } from "../../providers/catalog";
import { RELEASE_MANIFEST, type ReleaseManifest } from "../../release/manifest";
import { Pane } from "../Pane";
import { ProviderLogo } from "../chat/ProviderLogo";
import { ComposerMenu } from "../chat/ComposerMenu";
import { KodworkPane } from "../kodwork/KodworkPane";
import { launchPersonaRun } from "./agent-runs";

// Only CLIs with a verified headless stream can run an agent, the same gate the
// KödWork composer uses; a persona's provider is chosen from these.
const RUN_PROVIDERS = AVAILABLE_PROVIDERS.filter(
  (provider) => provider.stream !== undefined,
);
const DEFAULT_PROVIDER_ID = RUN_PROVIDERS[0]?.id ?? "claude";

const EMPTY_PERSONAS: AgentPersona[] = [];

// Which persona (or a new one) the editor is bound to. `id === null` is a new,
// unsaved persona in that scope.
type EditTarget = { scope: PersonaScope; id: string | null };

export function AgentsTab({
  store = defaultAgentsStore,
  workStore = kodworkStore,
  projectsStore = appStore,
  harness = defaultHarnessStore,
  manifest = RELEASE_MANIFEST,
}: {
  store?: StoreApi<AgentsState>;
  workStore?: StoreApi<KodworkState>;
  projectsStore?: StoreApi<ProjectsState>;
  harness?: StoreApi<HarnessState>;
  manifest?: ReleaseManifest;
} = {}) {
  const projects = useStore(projectsStore, (s) => s.projects);
  const activeProjectId = useStore(projectsStore, (s) => s.activeProjectId);
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;
  const projectScope: PersonaScope | null = activeProject
    ? { kind: "project", projectId: activeProject.id }
    : null;

  const appPersonas = useStore(
    store,
    (s) => s.personas[personaScopeKey({ kind: "app" })] ?? EMPTY_PERSONAS,
  );
  const projectPersonas = useStore(store, (s) =>
    projectScope
      ? (s.personas[personaScopeKey(projectScope)] ?? EMPTY_PERSONAS)
      : EMPTY_PERSONAS,
  );
  const selectedRunTaskId = useStore(store, (s) => s.selectedRunTaskId);
  const storageReadable = useStore(store, (s) => s.storageReadable);
  const runOpenSeq = useStore(store, (s) => s.runOpenSeq);

  // Load the persona document once, and mirror the current workspace scope
  // whenever the active project changes. load() re-mirrors every synced scope,
  // so a workspace scope synced before the read still populates.
  useEffect(() => {
    void store
      .getState()
      .load()
      .catch((error) =>
        console.error("kodade: persona document load failed:", error),
      );
  }, [store]);
  useEffect(() => {
    if (activeProject) {
      store.getState().syncScope({ kind: "project", projectId: activeProject.id });
    }
  }, [store, activeProject?.id]);

  const [editing, setEditing] = useState<EditTarget | null>(null);

  // A run opened from the sidebar (or a fresh launch) takes over the run area:
  // drop the editor so the task pane is visible. Keyed on runOpenSeq — which
  // bumps on every selectRun — so re-opening the ALREADY-selected run still
  // reveals it rather than leaving the editor up.
  const seenRunSeq = useRef(runOpenSeq);
  useEffect(() => {
    if (runOpenSeq === seenRunSeq.current) return;
    seenRunSeq.current = runOpenSeq;
    if (store.getState().selectedRunTaskId) setEditing(null);
  }, [runOpenSeq, store]);

  return (
    <Pane title="agents">
      <div className="flex h-full min-h-0">
        <PersonaRail
          appPersonas={appPersonas}
          projectPersonas={projectPersonas}
          projectName={activeProject?.name ?? null}
          projectScope={projectScope}
          storageReadable={storageReadable}
          editing={editing}
          onSelect={(scope, id) => setEditing({ scope, id })}
          onNew={(scope) => setEditing({ scope, id: null })}
        />
        <div className="relative min-w-0 flex-1 overflow-hidden bg-bg">
          {editing ? (
            <PersonaEditor
              key={`${personaScopeKey(editing.scope)}:${editing.id ?? "new"}`}
              store={store}
              workStore={workStore}
              projectsStore={projectsStore}
              harness={harness}
              manifest={manifest}
              scope={editing.scope}
              personaId={editing.id}
              projectId={activeProject?.id ?? null}
              projectPath={activeProject?.path ?? null}
              onSaved={(id) => setEditing({ scope: editing.scope, id })}
              onDeleted={() => setEditing(null)}
            />
          ) : selectedRunTaskId ? (
            <KodworkPane
              taskId={selectedRunTaskId}
              workStore={workStore}
              projectsStore={projectsStore}
            />
          ) : (
            <EmptyState hasProject={!!activeProject} />
          )}
        </div>
      </div>
    </Pane>
  );
}

// --- Persona rail ---

function PersonaRail({
  appPersonas,
  projectPersonas,
  projectName,
  projectScope,
  storageReadable,
  editing,
  onSelect,
  onNew,
}: {
  appPersonas: AgentPersona[];
  projectPersonas: AgentPersona[];
  projectName: string | null;
  projectScope: PersonaScope | null;
  storageReadable: boolean;
  editing: EditTarget | null;
  onSelect(scope: PersonaScope, id: string): void;
  onNew(scope: PersonaScope): void;
}) {
  return (
    <nav
      aria-label="Personas"
      data-testid="persona-rail"
      className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface/40 px-2 py-3"
    >
      {!storageReadable && (
        <p
          data-testid="persona-storage-error"
          className="mx-1 rounded border border-[color-mix(in_srgb,var(--kd-error)_45%,transparent)] bg-[color-mix(in_srgb,var(--kd-error)_10%,transparent)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--kd-error)]"
        >
          Persona storage is unreadable, so new agents can't be saved. Resolve
          the on-disk personas document, then reopen this tab.
        </p>
      )}
      {projectScope && (
        <PersonaGroup
          heading={projectName ? `${projectName} workspace` : "This workspace"}
          scope={projectScope}
          personas={projectPersonas}
          storageReadable={storageReadable}
          editing={editing}
          onSelect={onSelect}
          onNew={onNew}
        />
      )}
      <PersonaGroup
        heading="All projects"
        scope={{ kind: "app" }}
        personas={appPersonas}
        storageReadable={storageReadable}
        editing={editing}
        onSelect={onSelect}
        onNew={onNew}
      />
    </nav>
  );
}

function PersonaGroup({
  heading,
  scope,
  personas,
  storageReadable,
  editing,
  onSelect,
  onNew,
}: {
  heading: string;
  scope: PersonaScope;
  personas: AgentPersona[];
  storageReadable: boolean;
  editing: EditTarget | null;
  onSelect(scope: PersonaScope, id: string): void;
  onNew(scope: PersonaScope): void;
}) {
  const scopeKey = personaScopeKey(scope);
  return (
    <section data-persona-scope={scopeKey}>
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-dim">
          {heading}
        </h2>
        <button
          type="button"
          aria-label={`New persona for ${heading}`}
          title="New persona"
          onClick={() => onNew(scope)}
          className="flex h-5 w-5 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span aria-hidden="true" className="text-sm leading-none">
            +
          </span>
        </button>
      </div>
      {personas.length === 0 ? (
        <p className="mt-1 px-1 text-[11px] leading-relaxed text-text-dim">
          {storageReadable
            ? "No personas yet."
            : "Personas unavailable while storage is unreadable."}
        </p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {personas.map((persona) => {
            const selected =
              editing?.id === persona.id &&
              personaScopeKey(editing.scope) === scopeKey;
            return (
              <li key={persona.id}>
                <button
                  type="button"
                  onClick={() => onSelect(scope, persona.id)}
                  aria-current={selected ? "true" : undefined}
                  data-persona-id={persona.id}
                  className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs focus:outline-none focus:ring-1 focus:ring-accent ${
                    selected
                      ? "bg-surface-hover text-text"
                      : "text-text-dim hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  <ProviderLogo providerId={persona.providerId} size={16} />
                  <span className="min-w-0 flex-1 truncate">{persona.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// --- Persona editor ---

function PersonaEditor({
  store,
  workStore,
  projectsStore,
  harness,
  manifest,
  scope,
  personaId,
  projectId,
  projectPath,
  onSaved,
  onDeleted,
}: {
  store: StoreApi<AgentsState>;
  workStore: StoreApi<KodworkState>;
  projectsStore: StoreApi<ProjectsState>;
  harness: StoreApi<HarnessState>;
  manifest: ReleaseManifest;
  scope: PersonaScope;
  personaId: string | null;
  projectId: string | null;
  projectPath: string | null;
  onSaved(id: string): void;
  onDeleted(): void;
}) {
  // The editor remounts (keyed by scope+id in the parent) whenever the
  // selection changes, so reading the persona once at mount is enough.
  const existing = personaId ? store.getState().getPersona(scope, personaId) : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [providerId, setProviderId] = useState(
    existing?.providerId ?? DEFAULT_PROVIDER_ID,
  );
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [skillIds, setSkillIds] = useState<string[]>(existing?.skills ?? []);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const mutationError = useStore(store, (s) => s.mutationError);

  // A stale error from a previous persona must not carry into a freshly opened
  // editor. The editor remounts per target, so clearing once on mount is enough.
  useEffect(() => {
    store.getState().clearMutationError();
  }, [store]);

  // Installed KödSkills for the multi-select. Loaded lazily against the active
  // project; a failed scan is distinguished from "none installed" below.
  const kodSkills = useStore(harness, (s) => s.kodSkills);
  const kodSkillsError = useStore(harness, (s) => s.kodSkillsError);
  useEffect(() => {
    if (projectPath) void harness.getState().loadKodSkills(projectPath);
  }, [harness, projectPath]);
  const skillOptions = kodSkills?.pack.skills ?? [];

  const provider = RUN_PROVIDERS.find((entry) => entry.id === providerId);
  const workEnabled = manifest.features.work;
  const canRun = workEnabled && !!projectId && prompt.trim().length > 0;

  const save = async (): Promise<string | null> => {
    const changes = { name, providerId, prompt, skills: skillIds };
    if (personaId) {
      const updated = await store.getState().updatePersona(scope, personaId, changes);
      return updated?.id ?? null;
    }
    const created = await store.getState().createPersona(scope, changes);
    return created?.id ?? null;
  };

  const onSaveClick = async () => {
    const id = await save();
    if (id) onSaved(id);
  };

  const onPrepareRunClick = async () => {
    // Save first; the run must reflect a persisted persona. A save failure
    // leaves mutationError set — stop rather than launch a phantom run.
    const id = await save();
    if (!id) return;
    if (!projectId) {
      onSaved(id);
      return;
    }
    const persona = store.getState().getPersona(scope, id);
    if (!persona) return;
    // Prepares (does not start) a KödWork draft from the persona; the run is
    // started from the task pane's own Start control.
    await launchPersonaRun(projectsStore, workStore, store, projectId, persona);
  };

  const onDeleteClick = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    if (personaId) await store.getState().removePersona(scope, personaId);
    onDeleted();
  };

  const toggleSkill = (id: string) => {
    setSkillIds((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  };

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <h1 className="text-sm font-semibold text-text">
          {personaId ? "Edit agent" : "New agent"}
        </h1>
        <p className="mt-1 text-xs text-text-dim">
          An agent is a reusable persona — a provider, a system prompt, and the
          KödSkills it should lean on. Preparing a run drafts a background task
          with your own installed CLI; you start it from the task pane.
        </p>

        <label className="mt-4 block text-[11px] text-text-dim" htmlFor="persona-name">
          Name
        </label>
        <input
          id="persona-name"
          type="text"
          value={name}
          maxLength={MAX_NAME_CHARS}
          onChange={(event) => setName(event.target.value)}
          placeholder="New persona"
          className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-text placeholder:text-text-dim focus:border-accent/70 focus:outline-none"
        />

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <ComposerMenu
            label="Provider"
            value={providerId}
            onSelect={(id) => setProviderId(id)}
            options={RUN_PROVIDERS.map((entry) => ({
              id: entry.id,
              label: entry.name,
              icon: <ProviderLogo providerId={entry.id} size={20} />,
            }))}
          >
            <ProviderLogo providerId={providerId} size={18} />
            <span className="max-w-[130px] truncate">
              {provider?.name ?? providerId}
            </span>
          </ComposerMenu>
        </div>

        <label className="mt-4 block text-[11px] text-text-dim" htmlFor="persona-prompt">
          System prompt
        </label>
        <div className="mt-1 rounded-xl border border-border bg-surface focus-within:border-accent/70">
          <textarea
            id="persona-prompt"
            value={prompt}
            maxLength={MAX_PROMPT_CHARS}
            onChange={(event) => setPrompt(event.target.value)}
            rows={6}
            aria-label="System prompt"
            placeholder="How should this agent work? What should it always do, and what outcome does it drive toward?"
            className="w-full resize-none bg-transparent px-3.5 py-3 text-sm text-text placeholder:text-text-dim focus:outline-none"
          />
        </div>

        <fieldset className="mt-4">
          <legend className="text-[11px] text-text-dim">Skills</legend>
          <p className="mt-1 text-[10px] leading-relaxed text-text-dim">
            Stored with the persona; applied once runs pick up skills in a later
            update.
          </p>
          {kodSkillsError ? (
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--kd-error)]">
              Could not load installed KödSkills: {kodSkillsError}
            </p>
          ) : skillOptions.length === 0 ? (
            <p className="mt-1 text-[11px] leading-relaxed text-text-dim">
              No installed KödSkills detected for this workspace.
            </p>
          ) : (
            <ul className="mt-1 grid gap-1 sm:grid-cols-2">
              {skillOptions.map((skill) => (
                <li key={skill.id}>
                  <label className="flex items-start gap-2 rounded border border-border bg-surface px-2 py-1.5 text-xs text-text">
                    <input
                      type="checkbox"
                      checked={skillIds.includes(skill.id)}
                      onChange={() => toggleSkill(skill.id)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{skill.id}</span>
                      {skill.description && (
                        <span className="block truncate text-[10px] text-text-dim">
                          {skill.description}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <label className="mt-4 block text-[11px] text-text-dim" htmlFor="persona-connections">
          Connections
        </label>
        <input
          id="persona-connections"
          type="text"
          value=""
          disabled
          readOnly
          placeholder="Connections arrive in a later update"
          aria-describedby="persona-connections-note"
          className="mt-1 w-full cursor-not-allowed rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-text-dim placeholder:text-text-dim"
        />
        <p id="persona-connections-note" className="mt-1 text-[10px] text-text-dim">
          Connect this agent to your tools and accounts. Coming soon.
        </p>

        {mutationError && (
          <p className="mt-3 text-xs text-[var(--kd-error)]" data-testid="persona-error">
            {mutationError}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onPrepareRunClick()}
            disabled={!canRun}
            title={
              !workEnabled
                ? "Agent runs are unavailable in this build"
                : !projectId
                  ? "Open a project to prepare a run"
                  : prompt.trim().length === 0
                    ? "Add a system prompt first"
                    : "Save this agent and prepare a run to start from the task pane"
            }
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-text hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            Prepare run
          </button>
          <button
            type="button"
            onClick={() => void onSaveClick()}
            className="rounded border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {personaId ? "Save" : "Create"}
          </button>
          <div className="flex-1" />
          {personaId && (
            <>
              {confirmingDelete && (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded px-2 py-1.5 text-xs text-text-dim hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={() => void onDeleteClick()}
                aria-label={confirmingDelete ? "Confirm delete persona" : "Delete persona"}
                title={
                  confirmingDelete
                    ? "This permanently removes the persona"
                    : "Delete this persona"
                }
                className={`rounded border px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent ${
                  confirmingDelete
                    ? "border-[color-mix(in_srgb,var(--kd-error)_55%,transparent)] text-[var(--kd-error)] hover:bg-[color-mix(in_srgb,var(--kd-error)_12%,transparent)]"
                    : "border-border text-text-dim hover:bg-surface-hover hover:text-text"
                }`}
              >
                {confirmingDelete ? "Confirm delete" : "Delete"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ hasProject }: { hasProject: boolean }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-xs text-text-dim">
      <p className="max-w-xs leading-relaxed">
        {hasProject
          ? "Create an agent persona, or pick a run from the sidebar to see its progress here."
          : "Open a project to build and run agents."}
      </p>
    </div>
  );
}
