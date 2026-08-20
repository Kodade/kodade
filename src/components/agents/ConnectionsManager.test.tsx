// Connections manager (#64, slice 4): catalog add → install handoff. The
// install path MUST route through the harness store's prepareAddMcpServer review
// flow with a connections-owned pending change — never a direct config write.
// The guard here asserts exactly that: the connection store only ever writes its
// own connections doc, and CLI config only moves through prepareAddMcpServer.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockStorage } from "../../ipc/mock";
import { createConnectionStore, type ConnectionScope } from "../../agents/connection-store";
import { createConnectionsStore } from "../../agents/connections-store";
import { connectionDocName } from "../../agents/connection";
import type { HarnessState, McpTarget } from "../../store/harness";
import { ConnectionsManager } from "./ConnectionsManager";

const PROJECT_ROOT = "/repo";
const SCOPE: ConnectionScope = { kind: "project", projectId: "p1" };

const CLAUDE_TARGET: McpTarget = {
  cli: "claude",
  path: "/repo/.mcp.json",
  format: "json",
  keyPath: "mcpServers",
};
const CODEX_TARGET: McpTarget = {
  cli: "codex",
  path: "/home/.codex/config.toml",
  format: "toml",
  keyPath: "mcp_servers",
};

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
});

function stores() {
  const storage = new MockStorage();
  let seq = 0;
  const source = createConnectionStore({ storage, newId: () => `id-${++seq}`, now: () => 1 });
  const connections = createConnectionsStore({ store: source });
  return { storage, source, connections };
}

function fakeHarness() {
  const prepareAddMcpServer = vi.fn<HarnessState["prepareAddMcpServer"]>(async () => {});
  const store = createStore<Partial<HarnessState>>(() => ({
    inventory: null,
    applying: false,
    mutationError: null,
    pendingChange: null,
    listMcpTargets: vi.fn(async (scope: string) =>
      scope === "project" ? [CLAUDE_TARGET] : [CODEX_TARGET],
    ),
    rescanScope: vi.fn(async () => {}),
    prepareAddMcpServer,
    confirmPendingChange: vi.fn(async () => {}),
    cancelPendingChange: vi.fn(() => {}),
  })) as unknown as StoreApi<HarnessState>;
  return { store, prepareAddMcpServer };
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

describe("ConnectionsManager", () => {
  it("adds a catalog connection and installs it through prepareAddMcpServer", async () => {
    const { connections, source } = stores();
    await connections.getState().load();
    const { store: harness, prepareAddMcpServer } = fakeHarness();

    const host = await render(
      <ConnectionsManager
        connections={connections}
        harness={harness}
        source={source}
        scope={SCOPE}
        projectRoot={PROJECT_ROOT}
        onClose={() => {}}
      />,
    );

    // Browse the catalog and add GitHub's remote transport.
    await click(button(host, "Add from catalog"));
    const githubAdd = [...host.querySelectorAll("li")]
      .find((li) => li.textContent?.includes("GitHub"))!
      .querySelector("button");
    await click(githubAdd as HTMLButtonElement);

    // It is now a registered connection in the workspace scope.
    expect(connections.getState().connectionsFor(SCOPE).map((c) => c.name)).toStrictEqual(["GitHub"]);

    // Install it into the detected claude target.
    await click(button(host, "Install to CLI config…"));

    expect(prepareAddMcpServer).toHaveBeenCalledTimes(1);
    const [target, spec, projectRoot, owner] = prepareAddMcpServer.mock.calls[0];
    expect(target).toStrictEqual(CLAUDE_TARGET);
    expect(spec).toStrictEqual({
      name: "github",
      config: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
    });
    expect(projectRoot).toBe(PROJECT_ROOT);
    expect(owner).toStrictEqual({ surface: "connections", scopeId: PROJECT_ROOT });
  });

  it("write-path guard: the connection store only writes its own doc, never CLI config", async () => {
    const { storage, connections, source } = stores();
    await connections.getState().load();
    const { store: harness } = fakeHarness();

    const writeDoc = vi.spyOn(storage, "writeDoc");

    const host = await render(
      <ConnectionsManager
        connections={connections}
        harness={harness}
        source={source}
        scope={SCOPE}
        projectRoot={PROJECT_ROOT}
        onClose={() => {}}
      />,
    );

    await click(button(host, "Add from catalog"));
    const add = [...host.querySelectorAll("li")]
      .find((li) => li.textContent?.includes("Notion"))!
      .querySelector("button");
    await click(add as HTMLButtonElement);

    // Every write the manager triggered went to the connections doc only — no
    // config path was ever written directly (that is prepareAddMcpServer's job).
    for (const [name] of writeDoc.mock.calls) {
      expect(name).toBe(connectionDocName);
    }
  });

  it("disables remote install honestly for a stdio-only toml target", async () => {
    const { connections, source } = stores();
    await connections.getState().load();
    // Only the codex (toml) target is available.
    const prepareAddMcpServer = vi.fn(async () => {});
    const harness = createStore<Partial<HarnessState>>(() => ({
      inventory: null,
      applying: false,
      mutationError: null,
      pendingChange: null,
      listMcpTargets: vi.fn(async (scope: string) => (scope === "global" ? [CODEX_TARGET] : [])),
      rescanScope: vi.fn(async () => {}),
      prepareAddMcpServer,
      confirmPendingChange: vi.fn(async () => {}),
      cancelPendingChange: vi.fn(() => {}),
    })) as unknown as StoreApi<HarnessState>;

    const host = await render(
      <ConnectionsManager
        connections={connections}
        harness={harness}
        source={source}
        scope={SCOPE}
        projectRoot={PROJECT_ROOT}
        onClose={() => {}}
      />,
    );

    await click(button(host, "Add from catalog"));
    // vidIQ is remote-only, so codex (toml) cannot express it.
    const add = [...host.querySelectorAll("li")]
      .find((li) => li.textContent?.includes("vidIQ"))!
      .querySelector("button");
    await click(add as HTMLButtonElement);

    const install = button(host, "Install to CLI config…");
    expect(install.disabled).toBe(true);
    await click(install);
    expect(prepareAddMcpServer).not.toHaveBeenCalled();
  });
});
