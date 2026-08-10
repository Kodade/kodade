import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appStore, filesStore } from "../store/appStore";
import { createHarnessStore } from "../store/harness";
import { createClaudeAdapter } from "../harness/adapters/claude";
import { createCodexAdapter } from "../harness/adapters/codex";
import { MockConfig, MockPlatform } from "../ipc/mock";
import type { ConfigScan, KodSkillsPackBundle } from "../ipc/contract";
import type { HarnessAdapter, LocationScan } from "../harness/contract";
import type { HarnessArtifact } from "../harness/model";
import { createEntitlements } from "../app/entitlements";
import { capabilitiesStore } from "../platform/capabilities";
import { settingsViewStore } from "../store/settingsView";
import { HarnessPane } from "./HarnessPane";

function TestHarnessPane(
  props: Omit<ComponentProps<typeof HarnessPane>, "onScopeChange"> & {
    onScopeChange?: ComponentProps<typeof HarnessPane>["onScopeChange"];
  },
) {
  return <HarnessPane onScopeChange={() => undefined} {...props} />;
}

// A fixture adapter: detect() resolves one location, scan() returns whatever
// artifacts/error the test scripts — enough to drive the real rescan path
// (store → scanInventory → buildInventory) without touching Tauri.
function fixtureAdapter(result: LocationScan): HarnessAdapter {
  return {
    cli: "claude",
    detect: () =>
      Promise.resolve([
        { cli: "claude", scope: "project", kind: "instruction", container: "file", path: "loc" },
      ]),
    scan: () => Promise.resolve(result),
    plan: () => Promise.reject(new Error("not implemented in this fixture")),
    apply: () => Promise.reject(new Error("not implemented in this fixture")),
    verify: () => Promise.reject(new Error("not implemented in this fixture")),
    restore: () => Promise.reject(new Error("not implemented in this fixture")),
  };
}

// A fixture adapter for one CLI at one path, for multi-CLI matrix tests.
function fixtureAdapterFor(cli: string, path: string, result: LocationScan): HarnessAdapter {
  return {
    cli,
    detect: () =>
      Promise.resolve([{ cli, scope: "project", kind: "instruction", container: "file", path }]),
    scan: () => Promise.resolve(result),
    plan: () => Promise.reject(new Error("not implemented in this fixture")),
    apply: () => Promise.reject(new Error("not implemented in this fixture")),
    verify: () => Promise.reject(new Error("not implemented in this fixture")),
    restore: () => Promise.reject(new Error("not implemented in this fixture")),
  };
}

// Flush every pending microtask in the rescanScope → config.env() →
// rescan() → scanInventory() chain. A single `await Promise.resolve()` isn't
// enough once config.env() adds a link to that chain (M10c); looping a
// generous number of ticks is cheap and avoids a flaky one-tick race.
async function flushRescan() {
  for (let i = 0; i < 10; i++) {
    await act(async () => await Promise.resolve());
  }
}

function instruction(overrides: Partial<HarnessArtifact> = {}): HarnessArtifact {
  return {
    id: "claude:project:instruction:CLAUDE.md",
    cli: "claude",
    scope: "project",
    kind: "instruction",
    name: "CLAUDE.md",
    path: "/repo/CLAUDE.md",
    source: { via: "file" },
    enabled: true,
    status: "ok",
    detail: { kind: "instruction", lines: 41, bytes: 900 },
    ...overrides,
  };
}

function skill(overrides: Partial<HarnessArtifact> = {}): HarnessArtifact {
  return {
    id: "claude:project:skill:code-review",
    cli: "claude",
    scope: "project",
    kind: "skill",
    name: "code-review",
    path: "/repo/.claude/skills/code-review",
    source: { via: "dir" },
    enabled: true,
    status: "ok",
    detail: { kind: "skill", manifestPath: "/repo/.claude/skills/code-review/SKILL.md" },
    ...overrides,
  };
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

describe("HarnessPane", () => {
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

  it("groups artifacts by kind and shows empty sections in lowercase", async () => {
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [fixtureAdapter({ artifacts: [instruction(), skill()], error: null })],
    });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await act(async () => await Promise.resolve());

    expect(container!.textContent).toContain("Instructions and tools available in kodade.");
    expect(container!.textContent).toContain("instructions");
    expect(container!.textContent).toContain("CLAUDE.md");
    expect(container!.textContent).toContain("project · 41 lines");
    expect(container!.textContent).toContain("skills");
    expect(container!.textContent).toContain("code-review");
    // Sections with nothing detected render an honest, lowercase empty state.
    expect(container!.textContent).toContain("no subagents found");
    expect(container!.textContent).toContain("no mcp servers found");
  });

  it("keeps skill implementation paths out of the inventory row", async () => {
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [
        fixtureAdapter({
          artifacts: [
            skill({
              name: "x-post",
              source: { via: "symlink", target: "/repo/dotfiles/skills/x-post" },
            }),
          ],
          error: null,
        }),
      ],
    });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await act(async () => await Promise.resolve());

    expect(container!.textContent).toContain("x-post");
    expect(container!.textContent).not.toContain("⇲");
    expect(container!.textContent).not.toContain("dotfiles/skills/x-post");
    expect(container!.textContent).not.toContain(".claude/skills");
  });

  it("keeps subagent and MCP implementation paths out of their inventory rows", async () => {
    const subagent: HarnessArtifact = {
      id: "claude:project:subagent:observer",
      cli: "claude",
      scope: "project",
      kind: "subagent",
      name: "observer",
      path: "/repo/.claude/agents/observer.md",
      source: { via: "symlink", target: "/repo/dotfiles/claude/agents/observer.md" },
      enabled: true,
      status: "ok",
    };
    const server: HarnessArtifact = {
      id: "codex:project:mcp-server:node_repl",
      cli: "codex",
      scope: "project",
      kind: "mcp-server",
      name: "node_repl",
      path: "/repo/.codex/config.toml",
      source: { via: "file" },
      enabled: true,
      status: "ok",
      detail: {
        kind: "mcp-server",
        server: "node_repl",
        configPath: "/repo/.codex/config.toml",
        format: "toml",
        transport: "stdio",
        command: "node",
      },
    };
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [fixtureAdapter({ artifacts: [subagent, server], error: null })],
    });

    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    expect(container!.textContent).toContain("observer");
    expect(container!.textContent).toContain("node_repl");
    expect(container!.textContent).not.toContain("dotfiles/claude/agents");
    expect(container!.textContent).not.toContain(".claude/agents/observer.md");
    expect(container!.textContent).not.toContain(".codex/config.toml");
    expect(container!.textContent).not.toContain("⇲");
  });

  it("opens a skill preview in an immediately visible dialog", async () => {
    const config = new MockConfig();
    const manifestPath = "/repo/.claude/skills/code-review/SKILL.md";
    config.reads.set(manifestPath, {
      kind: "text",
      content: "# Code review\n\nReview the full branch diff.\n",
    });
    const store = createHarnessStore({
      config,
      adapters: [fixtureAdapter({ artifacts: [skill()], error: null })],
    });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    act(() => button("view")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();

    const dialog = container!.querySelector('[role="dialog"][aria-label="Preview code-review"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Review the full branch diff.");
    expect(dialog!.querySelector(".markdown-view")).not.toBeNull();
    expect(config.readQueries).toContainEqual({ path: manifestPath, projectRoot: "/repo" });
  });

  it("renders an orphaned symlink and a scan error as inline alert banners", async () => {
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [
        fixtureAdapter({
          artifacts: [
            skill({
              name: "broken",
              source: { via: "symlink", target: "/repo/dotfiles/skills/gone" },
              status: "orphaned-symlink",
            }),
          ],
          error: {
            cli: "claude",
            scope: "project",
            kind: "skill",
            path: "/repo/.claude/skills",
            message: "permission denied",
          },
        }),
      ],
    });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await act(async () => await Promise.resolve());

    expect(container!.textContent).toContain("broken symlink");
    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("permission denied");
  });

  it("free tier renders no mutation affordance (read-only inspector)", async () => {
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [fixtureAdapter({ artifacts: [instruction(), skill()], error: null })],
    });
    const free = createEntitlements({ "harness.pro": false });
    await act(async () =>
      root?.render(<TestHarnessPane scope="project" store={store} entitlements={free} />),
    );
    await act(async () => await Promise.resolve());

    const buttonLabels = Array.from(container!.querySelectorAll("button")).map((button) =>
      button.textContent?.trim().toLowerCase(),
    );
    // Free tier is read-only: no on/off toggle, no apply/cancel dialog buttons.
    const mutationWords = ["on", "off", "apply", "cancel", "enable", "disable"];
    for (const label of buttonLabels) {
      expect(mutationWords).not.toContain(label ?? "");
    }
    // Only the honest read affordances should exist.
    expect(buttonLabels).toContain("open");
    expect(buttonLabels).toContain("view");
  });

  it("opens an instruction from settings and returns to the visible workspace", async () => {
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [fixtureAdapter({ artifacts: [instruction()], error: null })],
    });
    const originalSelectFile = filesStore.getState().selectFile;
    let selectedPath: string | null = null;
    filesStore.setState({
      selectFile: async (path: string) => {
        selectedPath = path;
      },
    });
    settingsViewStore.getState().open("harness");

    try {
      await act(async () =>
        root?.render(<TestHarnessPane scope="project" store={store} />),
      );
      await flushRescan();
      const open = Array.from(container!.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "open",
      );
      await act(async () => {
        open?.click();
        await Promise.resolve();
      });

      expect(selectedPath).toBe("/repo/CLAUDE.md");
      expect(settingsViewStore.getState().section).toBeNull();
    } finally {
      filesStore.setState({ selectFile: originalSelectFile });
      settingsViewStore.getState().close();
    }
  });

  it("Pro: merges a shared project AGENTS.md row across codex and opencode into one row with two dots", async () => {
    const shared = instruction({
      id: "codex:project:instruction:AGENTS.md",
      cli: "codex",
      name: "AGENTS.md",
      path: "/repo/AGENTS.md",
    });
    const sharedOpencode = { ...shared, id: "opencode:project:instruction:AGENTS.md", cli: "opencode" };
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [
        fixtureAdapterFor("codex", "/repo/AGENTS.md", { artifacts: [shared], error: null }),
        fixtureAdapterFor("opencode", "/repo/AGENTS.md", { artifacts: [sharedOpencode], error: null }),
      ],
    });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    // Exactly one AGENTS.md row (not two), i.e. only one "AGENTS.md" text node.
    const rows = Array.from(container!.querySelectorAll("section")).flatMap((section) =>
      Array.from(section.children).filter((child) => child.textContent?.includes("AGENTS.md")),
    );
    expect(rows).toHaveLength(1);
    // Column headers list every roster CLI when entitled.
    expect(container!.textContent).toContain("Codex");
    expect(container!.textContent).toContain("OpenCode");
  });

  it("Pro: keeps CLI headers, detection cells, and the state column on one shared grid", async () => {
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [fixtureAdapter({ artifacts: [skill()], error: null })],
    });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    const section = container!.querySelector('[aria-label="skills harness inventory"]');
    const header = section!.querySelector<HTMLElement>('[data-harness-grid="header"]');
    const row = section!.querySelector<HTMLElement>('[data-harness-grid="row"]');
    expect(header).not.toBeNull();
    expect(row).not.toBeNull();
    expect(header!.style.gridTemplateColumns).toBe(row!.style.gridTemplateColumns);
    expect(Array.from(header!.children).map((node) => node.textContent?.trim())).toEqual([
      "skills",
      "Claude",
      "Codex",
      "Grok Build",
      "OpenCode",
      "KödLocal",
      "state",
    ]);
  });

  it("free tier: renders the honest lock row naming only detected CLIs, no matrix columns beyond claude", async () => {
    const claudeInstruction = instruction();
    const codexOnly = { ...claudeInstruction, id: "codex:project:instruction:AGENTS.md", cli: "codex", name: "AGENTS.md", path: "/repo/AGENTS.md" };
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [
        fixtureAdapter({ artifacts: [claudeInstruction], error: null }),
        fixtureAdapterFor("codex", "/repo/AGENTS.md", { artifacts: [codexOnly], error: null }),
      ],
    });
    const free = createEntitlements({ "harness.pro": false });
    await act(async () =>
      root?.render(<TestHarnessPane scope="project" store={store} entitlements={free} />),
    );
    await flushRescan();

    expect(container!.textContent).toContain("codex also detected");
    expect(container!.textContent).toContain("unlock the full matrix, global scope, and editing with kodade pro.");
    // No scope toggle button for free tier.
    const buttonLabels = Array.from(container!.querySelectorAll("button")).map((b) =>
      b.textContent?.trim().toLowerCase(),
    );
    expect(buttonLabels).not.toContain("global");
  });

  it("free tier: omits the lock row's detected-CLI clause when nothing else was found", async () => {
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [fixtureAdapter({ artifacts: [instruction()], error: null })],
    });
    const free = createEntitlements({ "harness.pro": false });
    await act(async () =>
      root?.render(<TestHarnessPane scope="project" store={store} entitlements={free} />),
    );
    await flushRescan();

    expect(container!.textContent).toContain("unlock the full matrix, global scope, and editing with kodade pro.");
    expect(container!.textContent).not.toContain("also detected");
  });

  it("Pro: the scope toggle reports global without opening a workspace tab", async () => {
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [fixtureAdapter({ artifacts: [instruction()], error: null })],
    });
    let selectedScope: "global" | "project" = "project";
    await act(async () =>
      root?.render(
        <TestHarnessPane
          scope="project"
          store={store}
          onScopeChange={(scope) => {
            selectedScope = scope;
          }}
        />,
      ),
    );
    await flushRescan();

    const globalButton = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().toLowerCase() === "global",
    );
    expect(globalButton).toBeDefined();
    act(() => globalButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(selectedScope).toBe("global");
  });

  it("a global scope downgrade shows the pro-required message, not a crash", async () => {
    const store = createHarnessStore({ config: new MockConfig(), adapters: [] });
    const free = createEntitlements({ "harness.pro": false });
    await act(async () =>
      root?.render(<TestHarnessPane scope="global" store={store} entitlements={free} />),
    );
    await flushRescan();

    expect(container!.textContent).toContain("global harness scope requires kodade pro");
  });

  // --- M10d: enable/disable toggle + confirm dialog (Pro) ---

  const SKILLS = "/repo/.claude/skills";

  // A skills-dir scan with one enabled `code-review` skill, wired so the real
  // claude adapter's plan/apply/verify path runs end-to-end over MockConfig.
  function skillsScan(): ConfigScan {
    return {
      status: "listing",
      root: SKILLS,
      entries: [
        {
          name: "code-review",
          path: `${SKILLS}/code-review`,
          isDir: true,
          isSymlink: false,
          target: null,
          orphaned: false,
          children: [
            {
              name: "SKILL.md",
              path: `${SKILLS}/code-review/SKILL.md`,
              isDir: false,
              isSymlink: false,
              target: null,
              orphaned: false,
              children: null,
            },
          ],
        },
      ],
    };
  }

  function button(label: string): HTMLButtonElement | undefined {
    return Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().toLowerCase() === label,
    ) as HTMLButtonElement | undefined;
  }

  it("Free: renders the KödSkills picker with Claude install and a Pro target lock", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = kodSkillsBundle();
    const free = createEntitlements({ "harness.pro": false });
    const store = createHarnessStore({
      config,
      adapters: [createClaudeAdapter(config)],
      hasFeature: free.hasFeature,
    });
    await act(async () =>
      root?.render(<TestHarnessPane scope="project" store={store} entitlements={free} />),
    );
    await flushRescan();

    expect(button("+ add project skill…")).toBeDefined();
    act(() =>
      button("install global starter pack…")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    await flushRescan();

    expect(container!.querySelector('[role="dialog"][aria-label="Manage KödSkills"]')).not.toBeNull();
    expect(container!.textContent).toContain("KödSkills engineering pack");
    expect(container!.textContent).toContain("v1.0.0");
    expect(container!.textContent).toContain("claude");
    expect(container!.textContent).toContain("Ködade Pro adds the shared .agents/skills target");
    expect(button("install selected…")).toBeDefined();
    expect(button("update selected…")).toBeUndefined();
  });

  it("Free: allows clean project-skill updates in the Claude target", async () => {
    const free = createEntitlements({ "harness.pro": false });
    const store = createHarnessStore({
      config: new MockConfig(),
      adapters: [],
      hasFeature: free.hasFeature,
    });
    await act(async () =>
      root?.render(<TestHarnessPane scope="project" store={store} entitlements={free} />),
    );
    await flushRescan();

    act(() =>
      button("+ add project skill…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flushRescan();
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
    await flushRescan();

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

    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    expect(button("+ add project skill…")).toBeUndefined();
  });

  it("Pro: stages selected Claude and Codex/KödLocal installs in one confirm dialog", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = kodSkillsBundle();
    const store = createHarnessStore({
      config,
      adapters: [createClaudeAdapter(config), createCodexAdapter(config)],
      hasFeature: () => true,
    });
    await act(async () => root?.render(<TestHarnessPane scope="global" store={store} />));
    await flushRescan();

    act(() => button("manage ködskills…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();
    expect(container!.textContent).toContain("codex + grok + opencode + kodade-local");

    act(() => button("install selected…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();

    const dialog = container!.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("2 changes as one reversible batch");
    expect(button("apply batch")).toBeDefined();
    expect(config.installDirCalls).toEqual([]); // confirmation is still plan-only
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
      adapters: [createClaudeAdapter(config), createCodexAdapter(config)],
      hasFeature: () => true,
    });
    await act(async () =>
      root?.render(
        <TestHarnessPane scope="project" store={store} platform={platform} />,
      ),
    );
    await flushRescan();

    expect(button("manage ködskills…")).toBeUndefined();
    act(() =>
      button("+ add project skill…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flushRescan();
    expect(
      container!.querySelector('[role="dialog"][aria-label="Manage project skills"]'),
    ).not.toBeNull();

    act(() =>
      button("choose skill folder…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flushRescan();

    expect(container!.textContent).toContain("project-review");
    expect(container!.textContent).toContain(".claude/skills");
    expect(container!.textContent).toContain(".agents/skills");
    expect(container!.textContent).toContain("claude + grok + opencode");

    act(() =>
      button("install selected…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flushRescan();

    expect(store.getState().pendingChange?.items).toHaveLength(2);
    expect(config.installDirCalls).toEqual([]);
  });

  it("Pro: toggling a skill opens the confirm dialog, and applying flips the row", async () => {
    const config = new MockConfig();
    config.scans.set(SKILLS, skillsScan());
    const store = createHarnessStore({ config, adapters: [createClaudeAdapter(config)] });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    expect(container!.textContent).toContain("code-review");
    const toggle = button("on");
    expect(toggle).toBeDefined();

    // Open the confirm dialog (plan only — no write yet).
    act(() => toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();
    const dialog = container!.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("disable");
    expect(dialog!.textContent).toContain("code-review");
    expect(config.renameCalls).toEqual([]);

    // Apply: rename → verify → rescan; the dialog closes and the row flips.
    act(() => button("apply")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();

    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(config.renameCalls).toEqual([
      { path: `${SKILLS}/code-review`, newPath: `${SKILLS}/code-review.disabled`, projectRoot: "/repo" },
    ]);
    expect(button("off")).toBeDefined();
  });

  it("Pro: cancelling the dialog writes nothing", async () => {
    const config = new MockConfig();
    config.scans.set(SKILLS, skillsScan());
    const store = createHarnessStore({ config, adapters: [createClaudeAdapter(config)] });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    act(() => button("on")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();
    expect(container!.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => button("cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();

    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(config.renameCalls).toEqual([]);
    expect(button("on")).toBeDefined();
  });

  it("Pro: a failed apply surfaces an inline error banner", async () => {
    const config = new MockConfig();
    config.scans.set(SKILLS, skillsScan());
    config.failRenameWith = "permission denied";
    const store = createHarnessStore({ config, adapters: [createClaudeAdapter(config)] });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    act(() => button("on")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();
    act(() => button("apply")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();

    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("permission denied");
  });

  it("free tier: a skill row shows no toggle", async () => {
    const config = new MockConfig();
    config.scans.set(SKILLS, skillsScan());
    const store = createHarnessStore({ config, adapters: [createClaudeAdapter(config)] });
    const free = createEntitlements({ "harness.pro": false });
    await act(async () =>
      root?.render(<TestHarnessPane scope="project" store={store} entitlements={free} />),
    );
    await flushRescan();

    expect(container!.textContent).toContain("code-review");
    expect(button("on")).toBeUndefined();
    expect(button("off")).toBeUndefined();
  });

  // Set a React-controlled input's value the way a user would (native setter +
  // bubbling input event), so onChange fires.
  function setInput(label: string, value: string) {
    const el = container!.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("Pro: the add-server form runs the safe merge and previews the one-key diff", async () => {
    const config = new MockConfig();
    // A project .mcp.json already holding a third-party server — the neighbor
    // that must survive byte-identical.
    config.reads.set("/repo/.mcp.json", {
      kind: "text",
      content: '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n',
    });
    const store = createHarnessStore({ config, adapters: [createClaudeAdapter(config)] });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    // Open the add-server form and let it load the detected target.
    act(() => button("+ add server…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();
    expect(container!.textContent).toContain("add mcp server");

    setInput("server name", "bridgememory");
    setInput("command", "kodade-mcp");

    // Review the merge → the diff confirm dialog opens (plan only, no write yet).
    act(() =>
      button("review merge…")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flushRescan();

    const dialog = container!.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("merge one entry");
    expect(dialog!.textContent).toContain("mcpServers.bridgememory");
    expect(dialog!.textContent).toContain("kodade-mcp");
    expect(config.writeCalls).toEqual([]); // still just a plan

    // Apply the merge: config_write is called with the merged bytes.
    act(() => button("apply merge")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();
    expect(config.writeCalls.map((c) => c.path)).toContain("/repo/.mcp.json");
    expect(container!.querySelector('[role="dialog"]')).toBeNull(); // dialog closed
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

    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(button("apply merge")).toBeUndefined();
    expect(store.getState().pendingChange?.owner).toEqual({ surface: "memory", scopeId: "ws_other" });
  });

  it("Pro: instruction rows expose an edit affordance that opens the inline editor", async () => {
    const config = new MockConfig();
    config.reads.set("/repo/CLAUDE.md", { kind: "text", content: "# project rules\n" });
    const store = createHarnessStore({ config, adapters: [createClaudeAdapter(config)] });
    await act(async () => root?.render(<TestHarnessPane scope="project" store={store} />));
    await flushRescan();

    const edit = button("edit");
    expect(edit).toBeDefined();
    act(() => edit!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushRescan();

    // The inline editor loads the current text through the guarded read.
    const textarea = container!.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toContain("# project rules");
    expect(button("review changes…")).toBeDefined();
  });
});
