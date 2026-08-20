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
import type { AgentPersona } from "../../agents/persona";
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

type AgentsTabProps = {
  store?: StoreApi<AgentsState>;
  workStore?: StoreApi<KodworkState>;
  projectsStore?: StoreApi<ProjectsState>;
  harness?: StoreApi<HarnessState>;
  manifest?: ReleaseManifest;
};

type AgentsTabWiring = {
  store: StoreApi<AgentsState>;
  workStore: StoreApi<KodworkState>;
  projectsStore: StoreApi<ProjectsState>;
  harness: StoreApi<HarnessState>;
  manifest: ReleaseManifest;
};

// Fall back to the app singletons only when a prop is absent. Reading a
// singleton is wrapped because a stripped test/preview harness may not export
// it (Vitest module mocks throw on an undefined export), in which case the tab
// renders inertly instead of crashing. `??` keeps injected props from ever
// touching the singletons, so a wired test never hits this path.
function resolveWiring(props: AgentsTabProps): AgentsTabWiring | null {
  try {
    return {
      store: props.store ?? defaultAgentsStore,
      workStore: props.workStore ?? kodworkStore,
      projectsStore: props.projectsStore ?? appStore,
      harness: props.harness ?? defaultHarnessStore,
      manifest: props.manifest ?? RELEASE_MANIFEST,
    };
  } catch {
    return null;
  }
}

export function AgentsTab(props: AgentsTabProps = {}) {
  const wiring = resolveWiring(props);
  // Hook-free guard so the body's hook order stays stable.
  if (!wiring) {
    return (
      <Pane title="agents">
        <div className="h-full" />
      </Pane>
    );
  }
  return <AgentsTabBody {...wiring} />;
}

function AgentsTabBody({
  store,
  workStore,
  projectsStore,
  harness,
  manifest,
}: {
  store: StoreApi<AgentsState>;
  workStore: StoreApi<KodworkState>;
  projectsStore: StoreApi<ProjectsState>;
  harness: StoreApi<HarnessState>;
  manifest: ReleaseManifest;
}) {
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

  // Load the persona document once, and mirror the current workspace scope
  // whenever the active project changes.
  useEffect(() => {
    void store.getState().load();
  }, [store]);
  useEffect(() => {
    if (activeProject) {
      store.getState().syncScope({ kind: "project", projectId: activeProject.id });
    }
  }, [store, activeProject?.id]);

  const [editing, setEditing] = useState<EditTarget | null>(null);

  // A run selected from the sidebar (or a fresh launch) takes over the run
  // area: drop the editor so the task pane is visible.
  const prevRun = useRef(selectedRunTaskId);
  useEffect(() => {
    if (selectedRunTaskId && selectedRunTaskId !== prevRun.current) {
      setEditing(null);
    }
    prevRun.current = selectedRunTaskId;
  }, [selectedRunTaskId]);

  return (
    <Pane title="agents">
      <div className="flex h-full min-h-0">
        <PersonaRail
          appPersonas={appPersonas}
          projectPersonas={projectPersonas}
          projectName={activeProject?.name ?? null}
          projectScope={projectScope}
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
  editing,
  onSelect,
  onNew,
}: {
  appPersonas: AgentPersona[];
  projectPersonas: AgentPersona[];
  projectName: string | null;
  projectScope: PersonaScope | null;
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
      {projectScope && (
        <PersonaGroup
          heading={projectName ? `${projectName} workspace` : "This workspace"}
          scope={projectScope}
          personas={projectPersonas}
          editing={editing}
          onSelect={onSelect}
          onNew={onNew}
        />
      )}
      <PersonaGroup
        heading="All projects"
        scope={{ kind: "app" }}
        personas={appPersonas}
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
  editing,
  onSelect,
  onNew,
}: {
  heading: string;
  scope: PersonaScope;
  personas: AgentPersona[];
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
          No personas yet.
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
  const mutationError = useStore(store, (s) => s.mutationError);

  // Installed KödSkills for the multi-select. Loaded lazily against the active
  // project; a build/project without any simply shows an empty-state note.
  const kodSkills = useStore(harness, (s) => s.kodSkills);
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

  const onRunClick = async () => {
    // Persist first so the run reflects the saved persona, then launch from
    // the current form values (which now match what was saved).
    const id = await save();
    if (id) onSaved(id);
    if (!projectId) return;
    const persona: AgentPersona = {
      id: id ?? personaId ?? "draft",
      name,
      prompt,
      providerId,
      skills: skillIds,
      connections: existing?.connections ?? [],
      createdAt: existing?.createdAt ?? 0,
      updatedAt: existing?.updatedAt ?? 0,
    };
    await launchPersonaRun(projectsStore, workStore, store, projectId, persona);
  };

  const onDeleteClick = async () => {
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
          KödSkills it should lean on. Launch it to run a background task with
          your own installed CLI.
        </p>

        <label className="mt-4 block text-[11px] text-text-dim" htmlFor="persona-name">
          Name
        </label>
        <input
          id="persona-name"
          type="text"
          value={name}
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
            onChange={(event) => setPrompt(event.target.value)}
            rows={6}
            aria-label="System prompt"
            placeholder="How should this agent work? What should it always do, and what outcome does it drive toward?"
            className="w-full resize-none bg-transparent px-3.5 py-3 text-sm text-text placeholder:text-text-dim focus:outline-none"
          />
        </div>

        <fieldset className="mt-4">
          <legend className="text-[11px] text-text-dim">Skills</legend>
          {skillOptions.length === 0 ? (
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
            onClick={() => void onRunClick()}
            disabled={!canRun}
            title={
              !workEnabled
                ? "Agent runs are unavailable in this build"
                : !projectId
                  ? "Open a project to run this agent"
                  : prompt.trim().length === 0
                    ? "Add a system prompt first"
                    : "Save and run this agent"
            }
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-text hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            Run agent
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
            <button
              type="button"
              onClick={() => void onDeleteClick()}
              className="rounded border border-border px-3 py-1.5 text-xs text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
            >
              Delete
            </button>
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
