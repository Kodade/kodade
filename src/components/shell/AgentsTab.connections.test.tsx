// AgentsTab connections (#64, slice 4): the persona editor's connection
// attachment picker stores connection ids on the persona, and the prepare-run
// notice warns (non-blocking) when an attached connection isn't installed for
// the selected provider. Stores are injected — a real connection store over
// MockStorage, a fake harness carrying scan probes.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockStorage } from "../../ipc/mock";
import { RELEASE_MANIFEST } from "../../release/manifest";
import { createPersonaStore, type PersonaScope } from "../../agents/persona-store";
import { createAgentsStore } from "../../agents/agents-store";
import { createConnectionStore, type ConnectionScope } from "../../agents/connection-store";
import { createConnectionsStore } from "../../agents/connections-store";
import type { HarnessInventory } from "../../harness/model";
import type { HarnessState } from "../../store/harness";
import type { KodworkState } from "../../kodwork/store";
import type { ProjectsState } from "../../store/projects";
import { AgentsTab } from "./AgentsTab";

const APP: PersonaScope = { kind: "app" };
const PROJ: ConnectionScope = { kind: "project", projectId: "p1" };

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
});

const WORK_MANIFEST = {
  ...RELEASE_MANIFEST,
  features: { ...RELEASE_MANIFEST.features, work: true },
};

function fakeProjects() {
  return createStore(() => ({
    projects: [{ id: "p1", name: "Kodade", path: "/repo" }],
    activeProjectId: "p1",
    setActiveProject: vi.fn(async () => {}),
    addWorkSession: vi.fn(() => "task-1"),
  })) as unknown as StoreApi<ProjectsState>;
}
function fakeWork() {
  return createStore(() => ({
    tasks: {},
    openTask: vi.fn(async () => {}),
    setProvider: vi.fn(() => {}),
    setOutcome: vi.fn(() => {}),
  })) as unknown as StoreApi<KodworkState>;
}

// A harness fake carrying an inventory: `fetch` is installed for codex only.
function fakeHarness(): StoreApi<HarnessState> {
  const inventory: HarnessInventory = {
    scannedAt: 0,
    artifacts: [
      {
        id: "a", cli: "codex", scope: "global", kind: "mcp-server", name: "fetch",
        path: "/home/.codex/config.toml", source: { via: "file" }, enabled: true, status: "ok",
        detail: { kind: "mcp-server", server: "fetch", configPath: "/home/.codex/config.toml", format: "toml", transport: "stdio", command: "uvx" },
      },
    ],
    errors: [],
  };
  return createStore(() => ({
    inventory,
    kodSkills: null,
    kodSkillsError: null,
    loadKodSkills: vi.fn(async () => {}),
    rescanScope: vi.fn(async () => {}),
  })) as unknown as StoreApi<HarnessState>;
}

async function render(node: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted = createRoot(host);
  await act(async () => {
    mounted?.render(node);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!match) throw new Error(`no button "${text}"`);
  return match as HTMLButtonElement;
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

async function setupStores() {
  const storage = new MockStorage();
  let seq = 0;
  const personaStore = createPersonaStore({ storage, newId: () => `p-${++seq}`, now: () => 1 });
  const store = createAgentsStore({ store: personaStore });
  const connSource = createConnectionStore({
    storage,
    newId: () => `c-${++seq}`,
    now: () => 1,
  });
  const connections = createConnectionsStore({ store: connSource });
  await connections.getState().load();
  // A workspace-scoped stdio connection whose server key is "fetch".
  await connections.getState().createConnection(PROJ, {
    source: "custom",
    name: "Fetch",
    transport: { kind: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
  });
  return { store, connections, connSource };
}

describe("AgentsTab connections", () => {
  it("attaches a connection id onto the persona and shows a not-installed notice", async () => {
    const { store, connections, connSource } = await setupStores();
    const host = await render(
      <AgentsTab
        store={store}
        workStore={fakeWork()}
        projectsStore={fakeProjects()}
        harness={fakeHarness()}
        connections={connections}
        connectionSource={connSource}
        manifest={WORK_MANIFEST}
      />,
    );

    // New app persona (provider defaults to the first run provider, claude).
    await click(host.querySelector<HTMLButtonElement>('[aria-label="New persona for All projects"]')!);
    const section = host.querySelector('[data-testid="persona-connections"]')!;
    const checkbox = section.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(section.textContent).toContain("Fetch");
    await click(checkbox);

    // The prepare-run notice appears: fetch is installed for codex, not claude.
    expect(host.querySelector('[data-testid="persona-connection-notice"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="persona-connection-notice"]')!.textContent).toContain("Fetch");

    await click(button(host, "Create"));
    const persona = store.getState().personasFor(APP)[0];
    expect(persona.connections).toHaveLength(1);
  });

  it("shows no notice when the connection is installed for the selected provider", async () => {
    const { store, connections, connSource } = await setupStores();
    // Harness inventory now has `fetch` under claude too.
    const harness = createStore(() => ({
      inventory: {
        scannedAt: 0,
        artifacts: [
          {
            id: "a", cli: "claude", scope: "project", kind: "mcp-server", name: "fetch",
            path: "/repo/.mcp.json", source: { via: "file" }, enabled: true, status: "ok",
            detail: { kind: "mcp-server", server: "fetch", configPath: "/repo/.mcp.json", format: "json", transport: "stdio", command: "uvx" },
          },
        ],
        errors: [],
      },
      kodSkills: null,
      kodSkillsError: null,
      loadKodSkills: vi.fn(async () => {}),
      rescanScope: vi.fn(async () => {}),
    })) as unknown as StoreApi<HarnessState>;

    const host = await render(
      <AgentsTab
        store={store}
        workStore={fakeWork()}
        projectsStore={fakeProjects()}
        harness={harness}
        connections={connections}
        connectionSource={connSource}
        manifest={WORK_MANIFEST}
      />,
    );
    await click(host.querySelector<HTMLButtonElement>('[aria-label="New persona for All projects"]')!);
    const section = host.querySelector('[data-testid="persona-connections"]')!;
    await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(host.querySelector('[data-testid="persona-connection-notice"]')).toBeNull();
  });
});
