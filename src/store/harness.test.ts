// Headless store tests: MockConfig fixtures replayed through the real claude
// adapter and scanInventory, exactly the seam the app uses. No Tauri, no React.

import { describe, expect, it, vi } from "vitest";
import { MockConfig } from "../ipc/mock";
import { createHarnessAdapter } from "../harness/adapters/shared";
import type { KodSkillsPackBundle, ProjectSkillSourceBundle } from "../ipc/contract";
import type {
  ArtifactLocation,
  ChangeReceipt,
  ConfigChange,
  HarnessAdapter,
} from "../harness/contract";
import type { HarnessArtifact, ScanContext } from "../harness/model";
import { buildScanContext, createHarnessStore } from "./harness";

// A tiny deferred promise, for controlling exactly when one adapter call
// resolves (MockConfig has no built-in deferral — this is store-level races).
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A hand-built ScanContext for tests exercising rescan() directly — no IPC
// involved, so this stays a plain literal rather than going through
// buildScanContext (that async path has its own tests below).
const CTX: ScanContext = {
  home: "/Users/keith",
  platform: "mac",
  projectRoot: "/Users/keith/proj",
  appDataRoaming: null,
  appDataLocal: null,
};

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

function projectSkillBundle(): ProjectSkillSourceBundle {
  return {
    root: "/vault/skills/project-review",
    files: [
      {
        path: "SKILL.md",
        contents:
          "---\nname: project-review\ndescription: Review this project before shipping.\n---\n",
      },
    ],
  };
}

describe("buildScanContext", () => {
  it("resolves home/platform from config.env() (M10c)", async () => {
    const config = new MockConfig();
    config.envResult = { home: "/Users/keith", platform: "mac", appDataRoaming: null, appDataLocal: null };
    const ctx = await buildScanContext(config, "/Users/keith/proj");
    expect(ctx).toEqual({
      home: "/Users/keith",
      platform: "mac",
      projectRoot: "/Users/keith/proj",
      appDataRoaming: null,
      appDataLocal: null,
    });
    expect(config.envQueries).toBe(1);
  });

  it("carries a real windows home through, not a path-sniffed guess", async () => {
    const config = new MockConfig();
    config.envResult = {
      home: "C:\\Users\\Keith",
      platform: "windows",
      appDataRoaming: null,
      appDataLocal: null,
    };
    const ctx = await buildScanContext(config, "C:\\Users\\Keith\\proj");
    expect(ctx.home).toBe("C:\\Users\\Keith");
    expect(ctx.platform).toBe("windows");
  });

  it("carries the real %APPDATA%/%LOCALAPPDATA% roots through (M10g)", async () => {
    // A non-ASCII Windows username, exercising the same path M10g's Rust
    // config_env test covers — the value just needs to pass through intact.
    const config = new MockConfig();
    config.envResult = {
      home: "C:\\Users\\Keïth",
      platform: "windows",
      appDataRoaming: "C:\\Users\\Keïth\\AppData\\Roaming",
      appDataLocal: "C:\\Users\\Keïth\\AppData\\Local",
    };
    const ctx = await buildScanContext(config, "C:\\Users\\Keïth\\proj");
    expect(ctx.appDataRoaming).toBe("C:\\Users\\Keïth\\AppData\\Roaming");
    expect(ctx.appDataLocal).toBe("C:\\Users\\Keïth\\AppData\\Local");
  });
});

describe("createHarnessStore", () => {
  it("scans the project and populates the inventory", async () => {
    const config = new MockConfig();
    config.reads.set("/Users/keith/proj/CLAUDE.md", { kind: "text", content: "hello\n" });
    const store = createHarnessStore({
      config,
      adapters: [createHarnessAdapter("claude", config)],
      now: () => 1234,
    });

    await store.getState().rescan("project", CTX);
    const state = store.getState();

    expect(state.scanning).toBe(false);
    expect(state.scanError).toBeNull();
    expect(state.lastScannedAt).toBe(1234);
    expect(state.inventory?.scannedAt).toBe(1234);
    expect(state.inventory?.artifacts).toEqual([
      expect.objectContaining({ kind: "instruction", name: "CLAUDE.md" }),
    ]);
  });

  it("surfaces a scan location error without throwing", async () => {
    const config = new MockConfig();
    config.scans.set("/Users/keith/proj/.claude/skills", {
      status: "unreadable",
      root: "/Users/keith/proj/.claude/skills",
      error: "permission denied",
    });
    const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });

    await store.getState().rescan("project", CTX);
    const state = store.getState();

    expect(state.scanError).toBeNull(); // the rescan action itself didn't throw
    expect(state.inventory?.errors).toEqual([
      expect.objectContaining({ path: "/Users/keith/proj/.claude/skills", message: "permission denied" }),
    ]);
  });

  it("sets scanError when an adapter throws outright", async () => {
    const config = new MockConfig();
    const throwing = {
      cli: "claude",
      detect: () => Promise.reject(new Error("detect blew up")),
      scan: () => Promise.reject(new Error("unused")),
      plan: () => Promise.reject(new Error("unused")),
      apply: () => Promise.reject(new Error("unused")),
      verify: () => Promise.reject(new Error("unused")),
      restore: () => Promise.reject(new Error("unused")),
    };
    const store = createHarnessStore({ config, adapters: [throwing] });

    await store.getState().rescan("project", CTX);
    const state = store.getState();

    expect(state.scanning).toBe(false);
    expect(state.scanError).toBe("detect blew up");
    expect(state.inventory).toBeNull();
  });

  it("a stale rescan can't clobber a newer one (monotonic generation guard)", async () => {
    const config = new MockConfig();
    const slowDetect = deferred<ArtifactLocation[]>();
    let detectCalls = 0;
    // detect() controls exactly when each rescan's inventory is ready; scan()
    // just echoes the location's path into an error message so the resulting
    // inventory identifies which round (slow/fast) produced it.
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => {
        detectCalls++;
        if (detectCalls === 1) return slowDetect.promise;
        return Promise.resolve([
          { cli: "claude", scope: "project", kind: "instruction", container: "file", path: "fast" },
        ]);
      },
      scan: (loc) =>
        Promise.resolve({
          artifacts: [],
          error: { cli: loc.cli, scope: loc.scope, kind: loc.kind, path: loc.path, message: loc.path },
        }),
      plan: () => Promise.reject(new Error("unused")),
      apply: () => Promise.reject(new Error("unused")),
      verify: () => Promise.reject(new Error("unused")),
      restore: () => Promise.reject(new Error("unused")),
    };
    const store = createHarnessStore({ config, adapters: [adapter] });

    // Round 1 (stale) blocks on slowDetect; round 2 (fresh) resolves first.
    const first = store.getState().rescan("project", CTX);
    await store.getState().rescan("project", CTX);
    expect(store.getState().inventory?.errors[0].message).toBe("fast");

    // Release the stale round; its late resolution must be dropped.
    slowDetect.resolve([
      { cli: "claude", scope: "project", kind: "instruction", container: "file", path: "slow" },
    ]);
    await first;
    expect(store.getState().inventory?.errors[0].message).toBe("fast");
  });

  it("readArtifact delegates to the injected ConfigIpc", async () => {
    const config = new MockConfig();
    config.reads.set("/Users/keith/proj/CLAUDE.md", { kind: "text", content: "hi\n" });
    const store = createHarnessStore({ config, adapters: [] });

    const result = await store.getState().readArtifact("/Users/keith/proj/CLAUDE.md", "/Users/keith/proj");
    expect(result).toEqual({ kind: "text", content: "hi\n" });
  });

  describe("rescanScope", () => {
    it("builds the real ScanContext via config.env() then scans (M10c)", async () => {
      const config = new MockConfig();
      config.envResult = { home: "/Users/keith", platform: "mac", appDataRoaming: null, appDataLocal: null };
      config.reads.set("/Users/keith/proj/CLAUDE.md", { kind: "text", content: "hi\n" });
      const store = createHarnessStore({
        config,
        adapters: [createHarnessAdapter("claude", config)],
        now: () => 42,
      });

      await store.getState().rescanScope("project", "/Users/keith/proj");

      expect(config.envQueries).toBe(1);
      expect(store.getState().inventory?.scannedAt).toBe(42);
      expect(store.getState().inventory?.artifacts).toEqual([
        expect.objectContaining({ kind: "instruction", name: "CLAUDE.md" }),
      ]);
    });

    it("surfaces a config.env() rejection as scanError, never a throw", async () => {
      const config = new MockConfig();
      config.env = () => Promise.reject(new Error("env lookup failed"));
      const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });

      await store.getState().rescanScope("project", "/Users/keith/proj");

      expect(store.getState().scanning).toBe(false);
      expect(store.getState().scanError).toBe("env lookup failed");
    });

    it("resolves global scope against the real home, not a blank placeholder", async () => {
      const config = new MockConfig();
      config.envResult = { home: "/Users/keith", platform: "mac", appDataRoaming: null, appDataLocal: null };
      config.reads.set("/Users/keith/.claude/CLAUDE.md", { kind: "text", content: "global\n" });
      const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });

      await store.getState().rescanScope("global", "/Users/keith/proj");

      expect(store.getState().inventory?.artifacts).toEqual([
        expect.objectContaining({ kind: "instruction", name: "CLAUDE.md", scope: "global" }),
      ]);
    });
  });
});

// --- M10d: enable/disable mutation orchestration ---

// A skill artifact fixture for the mutation actions.
function skillFixture(overrides: Partial<HarnessArtifact> = {}): HarnessArtifact {
  return {
    id: "claude:project:skill:code-review",
    cli: "claude",
    scope: "project",
    kind: "skill",
    name: "code-review",
    path: "/root/.claude/skills/code-review",
    source: { via: "dir" },
    enabled: true,
    status: "ok",
    detail: { kind: "skill", manifestPath: "/root/.claude/skills/code-review/SKILL.md" },
    ...overrides,
  };
}

const LOC: ArtifactLocation = {
  cli: "claude",
  scope: "project",
  kind: "skill",
  container: "dir",
  path: "/root/.claude/skills",
};

function changeFor(artifact: HarnessArtifact): ConfigChange {
  return {
    path: artifact.path,
    format: "dir-rename",
    before: artifact.path,
    after: `${artifact.path}.disabled`,
    diff: [{ before: artifact.path, after: `${artifact.path}.disabled` }],
    backupPath: "",
    projectRoot: "/root",
  };
}

function receiptFor(change: ConfigChange): ChangeReceipt {
  return { path: change.after, backupPath: "", appliedAt: 1, hash: "", change };
}

describe("harness store mutation (M10d)", () => {
  it("prepareToggle stages a plan without touching disk", async () => {
    const config = new MockConfig();
    const artifact = skillFixture();
    const change = changeFor(artifact);
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([LOC]),
      scan: () => Promise.resolve({ artifacts: [artifact], error: null }),
      plan: () => Promise.resolve(change),
      apply: () => Promise.reject(new Error("unused")),
      verify: () => Promise.reject(new Error("unused")),
      restore: () => Promise.reject(new Error("unused")),
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    await store.getState().rescanScope("project", "/root");

    await store.getState().prepareToggle(artifact.id, "/root");

    expect(store.getState().preparing).toBe(false);
    expect(store.getState().pendingChange).toEqual({
      cli: "claude",
      title: "disable code-review",
      change,
      artifact,
      owner: { surface: "harness", scopeId: "/root" },
    });
    // plan makes no IPC write call.
    expect(config.renameCalls).toEqual([]);
  });

  it("confirm applies, verifies, and rescans on success", async () => {
    const config = new MockConfig();
    const artifact = skillFixture();
    const change = changeFor(artifact);
    let applied = false;
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([LOC]),
      scan: () =>
        Promise.resolve({
          artifacts: [applied ? skillFixture({ enabled: false }) : artifact],
          error: null,
        }),
      plan: () => Promise.resolve(change),
      apply: () => {
        applied = true;
        return Promise.resolve(receiptFor(change));
      },
      verify: () => Promise.resolve({ ok: true }),
      restore: () => Promise.reject(new Error("must not restore on success")),
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    await store.getState().rescanScope("project", "/root");
    await store.getState().prepareToggle(artifact.id, "/root");

    await store.getState().confirmPendingChange();

    expect(store.getState().applying).toBe(false);
    expect(store.getState().pendingChange).toBeNull();
    expect(store.getState().mutationError).toBeNull();
    // The trailing rescan reflects the flipped state.
    expect(store.getState().inventory?.artifacts[0].enabled).toBe(false);
  });

  it("refuses to apply a pending KödMem change from the harness surface", async () => {
    const config = new MockConfig();
    const artifact = skillFixture();
    const change = changeFor(artifact);
    const apply = vi.fn().mockResolvedValue(receiptFor(change));
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([LOC]),
      scan: () => Promise.resolve({ artifacts: [artifact], error: null }),
      plan: () => Promise.resolve(change),
      apply,
      verify: () => Promise.resolve({ ok: true }),
      restore: () => Promise.resolve(),
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    store.setState({
      pendingChange: {
        cli: "claude",
        title: "add MCP server kodade-mem",
        change,
        owner: { surface: "memory", scopeId: "ws_1" },
      },
    });

    await store.getState().confirmPendingChange({ surface: "harness", scopeId: "/root" });

    expect(apply).not.toHaveBeenCalled();
    expect(store.getState().pendingChange?.owner).toEqual({ surface: "memory", scopeId: "ws_1" });
  });

  it("verify failure auto-restores and surfaces the reason", async () => {
    const config = new MockConfig();
    const artifact = skillFixture();
    const change = changeFor(artifact);
    let restored = false;
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([LOC]),
      scan: () => Promise.resolve({ artifacts: [artifact], error: null }),
      plan: () => Promise.resolve(change),
      apply: () => Promise.resolve(receiptFor(change)),
      verify: () => Promise.resolve({ ok: false, reason: "content changed" }),
      restore: () => {
        restored = true;
        return Promise.resolve();
      },
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    await store.getState().rescanScope("project", "/root");
    await store.getState().prepareToggle(artifact.id, "/root");

    await store.getState().confirmPendingChange();

    expect(restored).toBe(true);
    expect(store.getState().mutationError).toContain("content changed");
    expect(store.getState().pendingChange).toBeNull();
    expect(store.getState().applying).toBe(false);
  });

  it("keeps BOTH reasons when verify fails and the auto-restore also fails", async () => {
    const config = new MockConfig();
    const artifact = skillFixture();
    const change = changeFor(artifact);
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([LOC]),
      scan: () => Promise.resolve({ artifacts: [artifact], error: null }),
      plan: () => Promise.resolve(change),
      apply: () => Promise.resolve(receiptFor(change)),
      verify: () => Promise.resolve({ ok: false, reason: "content changed" }),
      restore: () => Promise.reject(new Error("rename back was rejected")),
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    await store.getState().rescanScope("project", "/root");
    await store.getState().prepareToggle(artifact.id, "/root");

    await store.getState().confirmPendingChange();

    const error = store.getState().mutationError;
    expect(error).toContain("verify failed: content changed");
    expect(error).toContain("restore also failed: rename back was rejected");
    expect(store.getState().pendingChange).toBeNull();
    expect(store.getState().applying).toBe(false);
  });

  it("surfaces an apply throw as mutationError without leaving a pending change", async () => {
    const config = new MockConfig();
    const artifact = skillFixture();
    const change = changeFor(artifact);
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([LOC]),
      scan: () => Promise.resolve({ artifacts: [artifact], error: null }),
      plan: () => Promise.resolve(change),
      apply: () => Promise.reject(new Error("guard rejected the rename")),
      verify: () => Promise.reject(new Error("unused")),
      restore: () => Promise.reject(new Error("unused")),
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    await store.getState().rescanScope("project", "/root");
    await store.getState().prepareToggle(artifact.id, "/root");

    await store.getState().confirmPendingChange();

    expect(store.getState().mutationError).toContain("guard rejected the rename");
    expect(store.getState().pendingChange).toBeNull();
  });

  it("cancelPendingChange discards the staged change", async () => {
    const config = new MockConfig();
    const artifact = skillFixture();
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([LOC]),
      scan: () => Promise.resolve({ artifacts: [artifact], error: null }),
      plan: () => Promise.resolve(changeFor(artifact)),
      apply: () => Promise.reject(new Error("must not apply")),
      verify: () => Promise.reject(new Error("unused")),
      restore: () => Promise.reject(new Error("unused")),
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    await store.getState().rescanScope("project", "/root");
    await store.getState().prepareToggle(artifact.id, "/root");
    expect(store.getState().pendingChange).not.toBeNull();

    store.getState().cancelPendingChange();
    expect(store.getState().pendingChange).toBeNull();
    expect(store.getState().mutationError).toBeNull();
  });

  it("a stale post-apply rescan can't clobber a newer scan", async () => {
    const config = new MockConfig();
    const artifact = skillFixture();
    const change = changeFor(artifact);
    const slow = deferred<void>();
    // `slowNext` makes the very next scan park on `slow` (the confirm's trailing
    // rescan); a later external rescan runs fast and must win the generation race.
    let slowNext = false;
    let current: HarnessArtifact = artifact;
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([LOC]),
      scan: async () => {
        if (slowNext) {
          slowNext = false;
          await slow.promise;
          return { artifacts: [skillFixture({ name: "stale" })], error: null };
        }
        return { artifacts: [current], error: null };
      },
      plan: () => Promise.resolve(change),
      apply: () => Promise.resolve(receiptFor(change)),
      verify: () => Promise.resolve({ ok: true }),
      restore: () => Promise.reject(new Error("unused")),
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    await store.getState().rescanScope("project", "/root");
    await store.getState().prepareToggle(artifact.id, "/root");

    // confirm applies, verifies, then its trailing rescan parks on `slow`.
    slowNext = true;
    const confirming = store.getState().confirmPendingChange();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // A newer rescan lands fresh data while the confirm rescan is still parked.
    current = skillFixture({ name: "fresh" });
    await store.getState().rescanScope("project", "/root");
    expect(store.getState().inventory?.artifacts[0].name).toBe("fresh");

    // Release the stale confirm rescan — it must NOT overwrite the newer result.
    slow.resolve();
    await confirming;
    expect(store.getState().inventory?.artifacts[0].name).toBe("fresh");
  });
});

describe("harness store KödSkills batches (M15)", () => {
  it("treats an empty idempotent batch as already complete", async () => {
    const store = createHarnessStore({ config: new MockConfig(), adapters: [] });

    await store.getState().prepareBatch(
      [],
      "no changes",
      { surface: "memory", scopeId: "ws_1" },
    );

    expect(store.getState().pendingChange).toBeNull();
    expect(store.getState().preparing).toBe(false);
    expect(store.getState().mutationError).toBeNull();
  });

  it("rolls every receipt back when post-apply health verification fails", async () => {
    const config = new MockConfig();
    const change: ConfigChange = {
      path: "/root/AGENTS.md",
      format: "markdown",
      before: "before",
      after: "after",
      diff: [{ before: "before", after: "after" }],
      backupPath: "",
      projectRoot: "/root",
    };
    const restored: string[] = [];
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([]),
      scan: () => Promise.resolve({ artifacts: [], error: null }),
      plan: () => Promise.resolve(change),
      apply: () => Promise.resolve({ path: change.path, backupPath: "/backup", appliedAt: 1, hash: "", change }),
      verify: () => Promise.resolve({ ok: true }),
      restore: (receipt) => {
        restored.push(receipt.path);
        return Promise.resolve();
      },
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    store.setState({
      pendingChange: {
        cli: "claude",
        title: "onboard agents",
        change,
        owner: { surface: "memory", scopeId: "ws_1" },
        validate: () => Promise.resolve({ ok: false, reason: "actual context did not match" }),
      },
    });

    await store.getState().confirmPendingChange();

    expect(restored).toEqual([change.path]);
    expect(store.getState().mutationError).toBe("batch reverted: actual context did not match");
  });

  it("re-checks the license so a stale Pro model cannot stage a Codex install", async () => {
    const config = new MockConfig();
    config.kodSkillsBundle = kodSkillsBundle();
    let pro = true;
    const store = createHarnessStore({
      config,
      adapters: [createHarnessAdapter("claude", config), createHarnessAdapter("codex", config)],
      hasFeature: () => pro,
    });
    await store.getState().loadKodSkills("/root");
    expect(store.getState().kodSkills?.targets.map((target) => target.id))
      .toContain("agents");

    pro = false;
    await store.getState().prepareKodSkills(
      "install",
      ["code-review"],
      ["agents"],
      "/root",
    );

    expect(store.getState().pendingChange).toBeNull();
    expect(store.getState().mutationError).toMatch(/no selected KödSkills are eligible/i);
  });

  it("restores the failing item and prior receipts in reverse order", async () => {
    const config = new MockConfig();
    const makeChange = (name: string): ConfigChange => ({
      path: `/root/.claude/skills/${name}`,
      format: "skill-dir",
      before: "absent",
      after: "2 files",
      diff: [{ before: "", after: `${name}/SKILL.md` }],
      backupPath: "",
      projectRoot: "/root",
      skillOperation: "install",
      files: [],
      expectedFiles: null,
    });
    const first = makeChange("first");
    const second = makeChange("second");
    const applied: string[] = [];
    const restored: string[] = [];
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([]),
      scan: () => Promise.resolve({ artifacts: [], error: null }),
      plan: () => Promise.reject(new Error("unused")),
      apply: (change) => {
        applied.push(change.path);
        return Promise.resolve({ path: change.path, backupPath: "", appliedAt: 1, hash: "", change });
      },
      verify: (receipt) => Promise.resolve(
        receipt.path.endsWith("second")
          ? { ok: false, reason: "second verification failed" }
          : { ok: true },
      ),
      restore: (receipt) => {
        restored.push(receipt.path);
        return Promise.resolve();
      },
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    store.setState({
      pendingChange: {
        cli: "claude",
        title: "install 2 KödSkills changes",
        change: first,
        owner: { surface: "harness", scopeId: "/root" },
        items: [
          { cli: "claude", title: "install first", change: first },
          { cli: "claude", title: "install second", change: second },
        ],
      },
    });

    await store.getState().confirmPendingChange();

    expect(applied).toEqual([first.path, second.path]);
    expect(restored).toEqual([second.path, first.path]);
    expect(store.getState().mutationError).toBe("batch reverted: second verification failed");
    expect(store.getState().pendingChange).toBeNull();
  });

  it("restores the current item when verification throws", async () => {
    const config = new MockConfig();
    const makeChange = (name: string): ConfigChange => ({
      path: `/root/.claude/skills/${name}`,
      format: "skill-dir",
      before: "absent",
      after: "2 files",
      diff: [{ before: "", after: `${name}/SKILL.md` }],
      backupPath: "",
      projectRoot: "/root",
      skillOperation: "install",
      files: [],
      expectedFiles: null,
    });
    const first = makeChange("first");
    const second = makeChange("second");
    const restored: string[] = [];
    const adapter: HarnessAdapter = {
      cli: "claude",
      detect: () => Promise.resolve([]),
      scan: () => Promise.resolve({ artifacts: [], error: null }),
      plan: () => Promise.reject(new Error("unused")),
      apply: (change) => Promise.resolve({
        path: change.path,
        backupPath: "",
        appliedAt: 1,
        hash: "",
        change,
      }),
      verify: (receipt) => receipt.path.endsWith("second")
        ? Promise.reject(new Error("verification crashed"))
        : Promise.resolve({ ok: true }),
      restore: (receipt) => {
        restored.push(receipt.path);
        return Promise.resolve();
      },
    };
    const store = createHarnessStore({ config, adapters: [adapter] });
    store.setState({
      pendingChange: {
        cli: "claude",
        title: "install 2 KödSkills changes",
        change: first,
        owner: { surface: "harness", scopeId: "/root" },
        items: [
          { cli: "claude", title: "install first", change: first },
          { cli: "claude", title: "install second", change: second },
        ],
      },
    });

    await store.getState().confirmPendingChange();

    expect(restored).toEqual([second.path, first.path]);
    expect(store.getState().mutationError).toBe("verification crashed");
    expect(store.getState().pendingChange).toBeNull();
  });
});

describe("harness store project skill import", () => {
  it("inspects a selected source and stages all selected project targets without writing", async () => {
    const config = new MockConfig();
    config.envResult = {
      home: "/Users/keith",
      platform: "mac",
      appDataRoaming: null,
      appDataLocal: null,
    };
    const store = createHarnessStore({
      config,
      adapters: [createHarnessAdapter("claude", config), createHarnessAdapter("codex", config)],
      hasFeature: () => true,
    });

    await store.getState().loadProjectSkill(projectSkillBundle(), "/root");
    expect(store.getState().projectSkill?.cells.map((cell) => cell.status)).toEqual([
      "ready",
      "ready",
    ]);

    await store.getState().prepareProjectSkill(
      "install",
      ["claude", "agents"],
      "/root",
    );

    expect(store.getState().pendingChange?.items).toHaveLength(2);
    expect(store.getState().pendingChange?.items?.map((item) => item.change.path)).toEqual([
      "/root/.claude/skills/project-review",
      "/root/.agents/skills/project-review",
    ]);
    expect(config.installDirCalls).toEqual([]);
  });

  it("re-checks Pro before staging the shared agents target", async () => {
    const config = new MockConfig();
    let pro = true;
    const store = createHarnessStore({
      config,
      adapters: [createHarnessAdapter("claude", config), createHarnessAdapter("codex", config)],
      hasFeature: () => pro,
    });
    await store.getState().loadProjectSkill(projectSkillBundle(), "/root");

    pro = false;
    await store.getState().prepareProjectSkill("install", ["agents"], "/root");

    expect(store.getState().pendingChange).toBeNull();
    expect(store.getState().mutationError).toMatch(/eligible/i);
  });
});

// --- M10e: instruction editing + MCP safe merge through the store ---

describe("prepareAddMcpServer + listMcpTargets (M10e)", () => {
  const ROOT = "/Users/keith/proj";

  it("lists the detected MCP config file as a target", async () => {
    const config = new MockConfig();
    const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });
    const targets = await store.getState().listMcpTargets("project", ROOT);
    expect(targets).toEqual([
      { cli: "claude", path: `${ROOT}/.mcp.json`, format: "json", keyPath: "mcpServers" },
    ]);
  });

  it("stages a single-key merge as a pendingChange without writing", async () => {
    const config = new MockConfig();
    config.reads.set(`${ROOT}/.mcp.json`, {
      kind: "text",
      content: '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n',
    });
    const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });

    const target = { cli: "claude" as const, path: `${ROOT}/.mcp.json`, format: "json" as const, keyPath: "mcpServers" };
    await store.getState().prepareAddMcpServer(target, { name: "bridgememory", config: { command: "kodade-mcp" } }, ROOT);

    const pending = store.getState().pendingChange;
    expect(pending?.cli).toBe("claude");
    expect(pending?.change.touchedKeys).toEqual(["mcpServers.bridgememory"]);
    expect(config.writeCalls).toEqual([]); // plan never writes
    expect(store.getState().mutationError).toBeNull();
  });

  it("surfaces a duplicate/corrupt refusal as mutationError, staging nothing", async () => {
    const config = new MockConfig();
    config.reads.set(`${ROOT}/.mcp.json`, {
      kind: "text",
      content: '{ "mcpServers": { "github": { "command": "gh-mcp" } } }',
    });
    const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });
    const target = { cli: "claude" as const, path: `${ROOT}/.mcp.json`, format: "json" as const, keyPath: "mcpServers" };
    await store.getState().prepareAddMcpServer(target, { name: "github", config: { command: "x" } }, ROOT);
    expect(store.getState().pendingChange).toBeNull();
    expect(store.getState().mutationError).toMatch(/already exists/);
  });

  it("confirm applies the merge and rescans", async () => {
    const config = new MockConfig();
    config.reads.set(`${ROOT}/.mcp.json`, {
      kind: "text",
      content: '{ "mcpServers": {} }',
    });
    const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });
    const target = { cli: "claude" as const, path: `${ROOT}/.mcp.json`, format: "json" as const, keyPath: "mcpServers" };

    // Prime lastScan so the post-apply rescan has a scope/root to reuse.
    await store.getState().rescanScope("project", ROOT);
    await store.getState().prepareAddMcpServer(target, { name: "svc", config: { command: "svc-mcp" } }, ROOT);
    await store.getState().confirmPendingChange();

    expect(store.getState().pendingChange).toBeNull();
    expect(store.getState().mutationError).toBeNull();
    expect(config.writeCalls.map((call) => call.path)).toContain(`${ROOT}/.mcp.json`);
    // The merged server now shows up in the rescanned inventory.
    const server = store.getState().inventory?.artifacts.find((a) => a.kind === "mcp-server" && a.name === "svc");
    expect(server).toBeTruthy();
  });
});

describe("prepareEdit (M10e instruction editing)", () => {
  const ROOT = "/Users/keith/proj";
  const CLAUDE = `${ROOT}/CLAUDE.md`;

  it("stages an instruction edit as a pendingChange", async () => {
    const config = new MockConfig();
    config.reads.set(CLAUDE, { kind: "text", content: "old\n" });
    const store = createHarnessStore({ config, adapters: [createHarnessAdapter("claude", config)] });
    await store.getState().rescanScope("project", ROOT);

    const artifact = store.getState().inventory?.artifacts.find((a) => a.kind === "instruction");
    expect(artifact).toBeTruthy();
    await store.getState().prepareEdit(artifact!.id, "brand new\n", ROOT);

    const pending = store.getState().pendingChange;
    expect(pending?.change.format).toBe("markdown");
    expect(pending?.change.after).toBe("brand new\n");
    expect(config.writeCalls).toEqual([]);
  });
});
