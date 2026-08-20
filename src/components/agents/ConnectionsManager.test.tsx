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
    preparing: false,
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

  it("write-path guard: connection CRUD/attach writes only its own doc, never a config path", async () => {
    const { storage, connections, source } = stores();
    await connections.getState().load();
    const { store: harness, prepareAddMcpServer } = fakeHarness();
    const confirmPendingChange = harness.getState().confirmPendingChange as unknown as ReturnType<typeof vi.fn>;

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

    // Add a catalog connection (a write), then remove it (another write) — both
    // are connection-doc mutations, not config changes.
    await click(button(host, "Add from catalog"));
    const add = [...host.querySelectorAll("li")]
      .find((li) => li.textContent?.includes("Notion"))!
      .querySelector("button");
    await click(add as HTMLButtonElement);
    await click(button(host, "remove")); // arm
    await click(button(host, "confirm remove")); // confirm

    // The connection doc WAS written, and every write went there — nothing else.
    expect(writeDoc.mock.calls.length).toBeGreaterThan(0);
    for (const [name] of writeDoc.mock.calls) {
      expect(name).toBe(connectionDocName);
    }
    // No CLI-config write path (prepareAddMcpServer / confirmPendingChange) was
    // reached by connection CRUD — that only happens on an explicit install.
    expect(prepareAddMcpServer).not.toHaveBeenCalled();
    expect(confirmPendingChange).not.toHaveBeenCalled();
  });

  it("surfaces an install failure that stages no pending change", async () => {
    const { connections, source } = stores();
    await connections.getState().load();
    const { store: harness } = fakeHarness();
    // prepareAddMcpServer fails to stage: it sets mutationError and leaves
    // pendingChange null (e.g. the server name already exists in the config).
    harness.setState({
      prepareAddMcpServer: vi.fn(async () => {
        harness.setState({ mutationError: 'an MCP server named "notion" already exists' });
      }),
    } as Partial<HarnessState>);

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
    await click(button(host, "Install to CLI config…"));

    const error = host.querySelector('[data-testid="connection-install-error"]');
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("already exists");
  });

  it("shows a busy install button while a change is preparing", async () => {
    const { connections, source } = stores();
    await connections.getState().load();
    const { store: harness } = fakeHarness();

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

    await act(async () => {
      harness.setState({ preparing: true } as Partial<HarnessState>);
    });
    const install = button(host, "Installing…");
    expect(install.disabled).toBe(true);
  });

  it("installs a remote server into a codex toml target as a url-only config", async () => {
    const { connections, source } = stores();
    await connections.getState().load();
    // Only the codex (toml) target is available.
    const prepareAddMcpServer = vi.fn<HarnessState["prepareAddMcpServer"]>(async () => {});
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
    // vidIQ is remote-only; codex config.toml expresses it as a bare url.
    const add = [...host.querySelectorAll("li")]
      .find((li) => li.textContent?.includes("vidIQ"))!
      .querySelector("button");
    await click(add as HTMLButtonElement);

    const install = button(host, "Install to CLI config…");
    expect(install.disabled).toBe(false);
    await click(install);

    // End-to-end BYOK proof: the staged spec carries ONLY the url — no
    // headers, tokens, or auth keys can reach the written config.
    expect(prepareAddMcpServer).toHaveBeenCalledTimes(1);
    const [target, spec] = prepareAddMcpServer.mock.calls[0];
    expect(target).toStrictEqual(CODEX_TARGET);
    expect(spec).toStrictEqual({
      name: "vidiq",
      config: { url: "https://mcp.vidiq.com/mcp" },
    });
    expect(Object.keys((spec as { config: object }).config)).toEqual(["url"]);
  });
});
