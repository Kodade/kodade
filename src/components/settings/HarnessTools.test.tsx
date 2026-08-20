// Settings → Advanced → KödHarness tools (issue #63). The inventory pane is
// retired; these cases are the ones that covered the surviving capabilities —
// the KödSkills pack picker, project skills, and the add-MCP-server merge.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntitlements } from "../../app/entitlements";
import { createHarnessAdapter } from "../../harness/adapters/shared";
import type { KodSkillsPackBundle } from "../../ipc/contract";
import { MockConfig, MockPlatform } from "../../ipc/mock";
import { capabilitiesStore } from "../../platform/capabilities";
import { appStore, filesStore } from "../../store/appStore";
import { createHarnessStore } from "../../store/harness";
import { HarnessTools } from "./HarnessTools";

// Flush every pending microtask in the store's async chains (config.env() →
// scan → model build). Looping a generous number of ticks is cheap and avoids
// a flaky one-tick race.
async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => await Promise.resolve());
  }
}

function kodSkillsBundle(): KodSkillsPackBundle {
  const skillText = "---\ndescription: Review a branch diff.\n---\n";
  const agentText = "interface:\n  display_name: Code Review\n";
  return {
    manifest: JSON.stringify({
      name: "KödSkills engineering pack",
      id: "kodskills-engineering",
      version: "1.0.0",
      description: "A curated engineering workflow.",
      source: "https://github.com/ContractorKeith/skills",
      tag: "v1.0.0",
      sha: "000087d6fc70e92fc91eb40b89b0c62a67ebc78a",
      skills: [
        {
          id: "code-review",
          dir: "code-review",
          description: "Review a branch diff.",
          files: [
            {
              path: "SKILL.md",
              sha256: "dabf81ba0fa2b523fb9e007377786b316c5a3d0ac7df47d1f489e7b956aad542",
            },
            {
              path: "agents/openai.yaml",
              sha256: "6676d79ab8f6475f6a0f7cb34415c9636a96abd9d7789fb9854f9d76cfedd47b",
            },
          ],
        },
      ],
    }),
    files: [
      { path: "skills/code-review/SKILL.md", contents: skillText },
      { path: "skills/code-review/agents/openai.yaml", contents: agentText },
    ],
  };
}

describe("HarnessTools", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    capabilitiesStore.setState({ capabilities: null });
    // Pre-seed the (real, app-singleton) files store's rootPath so appStore's
    // project-switch subscriber — wired in appStore.ts, outside this test's
    // control — no-ops instead of driving a real Tauri fs watch/unwatch call.
    filesStore.setState({ rootPath: "/repo" });
    appStore.setState({
      activeProjectId: "p1",
      projects: [{ id: "p1", name: "kodade", path: "/repo" }],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    // Null out rootPath BEFORE clearing activeProjectId, so the subscriber's
    // setRoot(null) call sees a match and no-ops (see beforeEach comment).
    filesStore.setState({ rootPath: null });
    appStore.setState({ activeProjectId: null, projects: [] });
    capabilitiesStore.setState({ capabilities: null });
  });

  function button(label: string): HTMLButtonElement | undefined {
    return Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().toLowerCase() === label,
    ) as HTMLButtonElement | undefined;
  }

  // Set a React-controlled input's value the way a user would (native setter +
  // bubbling input event), so onChange fires.
  function setInput(label: string, value: string) {
    const el = container!.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("renders the tool affordances, and no retired inventory matrix", async () => {
    const store = createHarnessStore({ config: new MockConfig(), adapters: [] });
    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    expect(button("manage ködskills…")).toBeDefined();
    expect(button("+ add project skill…")).toBeDefined();
    expect(button("+ add mcp server…")).toBeDefined();
    // The artifact matrix, its scope toggle, and the instruction editor are gone.
    expect(container!.querySelector('[data-harness-grid="header"]')).toBeNull();
    expect(container!.textContent).not.toContain("no subagents found");
    expect(button("global")).toBeUndefined();
  });

  it("says so honestly when no project is selected", async () => {
    appStore.setState({ activeProjectId: null, projects: [] });
    const store = createHarnessStore({ config: new MockConfig(), adapters: [] });
    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    expect(container!.textContent).toContain("select a project");
    expect(button("manage ködskills…")).toBeUndefined();
  });

  it("Free: renders the KödSkills picker with Claude install and a Pro target lock", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = kodSkillsBundle();
    const free = createEntitlements({ "harness.pro": false });
    const store = createHarnessStore({
      config,
      adapters: [createHarnessAdapter("claude", config)],
      hasFeature: free.hasFeature,
    });
    await act(async () => root?.render(<HarnessTools store={store} entitlements={free} />));
    await flush();

    // Free tier gets skills, not the MCP merge.
    expect(button("+ add mcp server…")).toBeUndefined();
    act(() =>
      button("manage ködskills…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();

    expect(container!.querySelector('[role="dialog"][aria-label="Manage KödSkills"]')).not.toBeNull();
    expect(container!.textContent).toContain("KödSkills engineering pack");
    expect(container!.textContent).toContain("v1.0.0");
    expect(container!.textContent).toContain("claude");
    expect(container!.textContent).toContain("Ködade Pro adds the shared .agents/skills target");
    expect(button("install selected…")).toBeDefined();
    expect(button("update selected…")).toBeUndefined();
  });

  it("Pro: stages selected Claude and Codex/KödLocal installs in one confirm dialog", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = kodSkillsBundle();
    const store = createHarnessStore({
      config,
      adapters: [createHarnessAdapter("claude", config), createHarnessAdapter("codex", config)],
      hasFeature: () => true,
    });
    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    act(() =>
      button("manage ködskills…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();
    expect(container!.textContent).toContain("codex + grok + opencode + kodade-local");

    act(() => button("install selected…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const dialog = container!.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("2 changes as one reversible batch");
    expect(button("apply batch")).toBeDefined();
    expect(config.installDirCalls).toEqual([]); // confirmation is still plan-only
  });

  it("Free: allows clean project-skill updates in the Claude target", async () => {
    const free = createEntitlements({ "harness.pro": false });
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [],
      hasFeature: free.hasFeature,
    });
    await act(async () => root?.render(<HarnessTools store={store} entitlements={free} />));
    await flush();

    act(() =>
      button("+ add project skill…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();
    act(() =>
      store.setState({
        projectSkill: {
          skill: {
            id: "project-review",
            description: "Review this project.",
            sourceRoot: "/vault/project-review",
            sourceHash: "new",
            files: [],
          },
          targets: [{
            id: "claude",
            cli: "claude",
            clis: ["claude", "grok", "opencode"],
            path: "/repo/.claude/skills",
          }],
          cells: [{
            targetId: "claude",
            targetPath: "/repo/.claude/skills",
            installedPath: "/repo/.claude/skills/project-review",
            status: "update",
            eligible: true,
            reason: "selected source differs",
            snapshot: [],
          }],
        },
      }),
    );
    await flush();

    expect(button("update selected…")).toBeDefined();
    expect(button("remove selected…")).toBeDefined();
  });

  it("hides the native project-skill picker when folder selection is unavailable", async () => {
    capabilitiesStore.setState({
      capabilities: {
        browser: false,
        pickFolder: false,
        voice: false,
        revealInOs: false,
      },
    });
    const store = createHarnessStore({ config: new MockConfig(), adapters: [] });

    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    expect(button("+ add project skill…")).toBeUndefined();
  });

  it("Pro: project skills choose a folder and stage recognized project targets", async () => {
    const config = new MockConfig();
    const platform = new MockPlatform();
    platform.nextProjectSkill = {
      root: "/vault/skills/project-review",
      files: [
        {
          path: "SKILL.md",
          contents:
            "---\nname: project-review\ndescription: Review this project before shipping.\n---\n",
        },
      ],
    };
    const store = createHarnessStore({
      config,
      adapters: [createHarnessAdapter("claude", config), createHarnessAdapter("codex", config)],
      hasFeature: () => true,
    });
    await act(async () =>
      root?.render(<HarnessTools store={store} platform={platform} />),
    );
    await flush();

    act(() =>
      button("+ add project skill…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();
    expect(
      container!.querySelector('[role="dialog"][aria-label="Manage project skills"]'),
    ).not.toBeNull();

    act(() =>
      button("choose skill folder…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();

    expect(container!.textContent).toContain("project-review");
    expect(container!.textContent).toContain(".claude/skills");
    expect(container!.textContent).toContain(".agents/skills");
    expect(container!.textContent).toContain("claude + grok + opencode");

    act(() =>
      button("install selected…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();

    expect(store.getState().pendingChange?.items).toHaveLength(2);
    expect(config.installDirCalls).toEqual([]);
  });

  it("Pro: the add-server form runs the safe merge and previews the one-key diff", async () => {
    const config = new MockConfig();
    // A project .mcp.json already holding a third-party server — the neighbor
    // that must survive byte-identical.
    config.reads.set("/repo/.mcp.json", {
      kind: "text",
      content: '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n',
    });
    const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });
    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    // Open the add-server form and let it load the detected target.
    act(() => button("+ add mcp server…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(container!.textContent).toContain("add mcp server");

    setInput("server name", "bridgememory");
    setInput("command", "kodade-mcp");

    // Review the merge → the diff confirm dialog opens (plan only, no write yet).
    act(() =>
      button("review merge…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();

    const dialog = container!.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("merge one entry");
    expect(dialog!.textContent).toContain("mcpServers.bridgememory");
    expect(dialog!.textContent).toContain("kodade-mcp");
    expect(config.writeCalls).toEqual([]); // still just a plan

    // Apply the merge: config_write is called with the merged bytes.
    act(() => button("apply merge")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(config.writeCalls.map((c) => c.path)).toContain("/repo/.mcp.json");
    expect(container!.querySelector('[role="dialog"]')).toBeNull(); // dialog closed
  });

  it("Pro: offers global-only MCP catalogs (codex, grok) beside project ones", async () => {
    const config = new MockConfig();
    config.reads.set("/repo/.mcp.json", { kind: "text", content: '{ "mcpServers": {} }\n' });
    config.reads.set("/Users/keith/.codex/config.toml", { kind: "text", content: "" });
    config.reads.set("/Users/keith/.grok/config.toml", { kind: "text", content: "" });
    const store = createHarnessStore({
      config,
      adapters: [
        createHarnessAdapter("claude", config),
        createHarnessAdapter("codex", config),
        createHarnessAdapter("grok", config),
      ],
    });
    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    act(() => button("+ add mcp server…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const select = container!.querySelector('[aria-label="target config file"]') as HTMLSelectElement;
    const options = Array.from(select.options).map((option) => option.textContent);
    // Claude's catalog is per project; codex and grok only have a global one,
    // and the pane's scope toggle is gone — so both must be listed here.
    expect(options).toContain("claude · .mcp.json");
    expect(options).toContain("codex · /Users/keith/.codex/config.toml (global)");
    expect(options).toContain("grok · /Users/keith/.grok/config.toml (global)");
  });

  it("Pro: merges into the selected global catalog, not the project one", async () => {
    const config = new MockConfig();
    config.reads.set("/repo/.mcp.json", { kind: "text", content: '{ "mcpServers": {} }\n' });
    config.reads.set("/Users/keith/.codex/config.toml", {
      kind: "text",
      content: '[mcp_servers.github]\ncommand = "gh-mcp"\n',
    });
    const store = createHarnessStore({
      config,
      adapters: [createHarnessAdapter("claude", config), createHarnessAdapter("codex", config)],
    });
    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    act(() => button("+ add mcp server…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    // Pick the codex global target.
    const select = container!.querySelector('[aria-label="target config file"]') as HTMLSelectElement;
    const codexIndex = Array.from(select.options).findIndex((option) =>
      option.textContent?.includes(".codex/config.toml"),
    );
    expect(codexIndex).toBeGreaterThanOrEqual(0);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, String(codexIndex));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    setInput("server name", "kodade-mem");
    setInput("command", "kodade-mcp");

    act(() =>
      button("review merge…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();
    expect(store.getState().pendingChange?.change.path).toBe("/Users/keith/.codex/config.toml");

    act(() => button("apply merge")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const write = config.writeCalls.find((c) => c.path === "/Users/keith/.codex/config.toml");
    expect(write).toBeDefined();
    expect(write!.contents).toContain("kodade-mem");
    expect(write!.contents).toContain("gh-mcp"); // the neighbor survives
    expect(config.writeCalls.map((c) => c.path)).not.toContain("/repo/.mcp.json");
  });

  it("cancelling the confirm dialog writes nothing", async () => {
    const config = new MockConfig();
    config.reads.set("/repo/.mcp.json", { kind: "text", content: '{ "mcpServers": {} }\n' });
    const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });
    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    act(() => button("+ add mcp server…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    setInput("server name", "bridgememory");
    setInput("command", "kodade-mcp");
    act(() =>
      button("review merge…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();
    expect(container!.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => button("cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(config.writeCalls).toEqual([]);
    expect(store.getState().pendingChange).toBeNull();
  });

  it("a failed apply surfaces the inline error banner", async () => {
    const config = new MockConfig();
    config.reads.set("/repo/.mcp.json", { kind: "text", content: '{ "mcpServers": {} }\n' });
    config.failConfigWriteWith = "permission denied";
    const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });
    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    act(() => button("+ add mcp server…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    setInput("server name", "bridgememory");
    setInput("command", "kodade-mcp");
    act(() =>
      button("review merge…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();
    act(() => button("apply merge")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("permission denied");
  });

  it("never presents or applies a KödMem-staged merge from another workspace", async () => {
    const store = createHarnessStore({ config: new MockConfig(), adapters: [] });
    store.setState({
      pendingChange: {
        cli: "claude",
        title: "add MCP server kodade-mem",
        owner: { surface: "memory", scopeId: "ws_other" },
        change: {
          path: "/repo/.mcp.json",
          format: "json",
          before: '{ "mcpServers": {} }\n',
          after: '{ "mcpServers": { "kodade-mem": { "command": "kodade-mcp" } } }\n',
          diff: [],
          backupPath: "",
          projectRoot: "/repo",
          touchedKeys: ["mcpServers.kodade-mem"],
          expectedHash: "",
          isNewFile: false,
        },
      },
    });

    await act(async () => root?.render(<HarnessTools store={store} />));
    await flush();

    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(button("apply merge")).toBeUndefined();
    expect(store.getState().pendingChange?.owner).toEqual({ surface: "memory", scopeId: "ws_other" });
  });
});
