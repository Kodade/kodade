// KödHarness store (M10b): Zustand vanilla factory, injected deps — the same
// shape as the github store (src/github/store.ts). Drives a scan across the
// injected adapters via scan.ts's pure scanInventory/buildInventory and holds
// the resulting inventory for the pane. M10b wires PROJECT scope + the claude
// adapter only; the store itself takes an `adapters` list so M10c (multi-CLI
// matrix, global scope) widens the roster without reshaping this file.

import { createStore } from "zustand/vanilla";
import { FEATURES, hasFeature as hasLicenseFeature } from "../license";
import type { ConfigIpc, FileRead, ProjectSkillSourceBundle } from "../ipc/contract";
import type {
  ChangeReceipt,
  ConfigChange,
  HarnessAdapter,
  HarnessChangeRequest,
} from "../harness/contract";
import type {
  HarnessArtifact,
  HarnessInventory,
  HarnessScope,
  ScanContext,
} from "../harness/model";
import type { McpServerSpec } from "../harness/merge";
import { scanInventory } from "../harness/scan";
import {
  buildKodSkillsRequests,
  inspectKodSkills,
  type KodSkillsAction,
  type KodSkillsModel,
} from "../harness/kodskills";
import {
  buildProjectSkillRequests,
  inspectProjectSkill,
  type ProjectSkillAction,
  type ProjectSkillModel,
} from "../harness/project-skills";

export type HarnessDeps = {
  config: ConfigIpc;
  adapters: readonly HarnessAdapter[];
  now?: () => number;
  hasFeature?: typeof hasLicenseFeature;
};

// One config file a new MCP server can be merged into: derived from a CLI's
// catalog MCP location (path + format + the key holding the server map). The
// "+ add server…" affordance offers these as targets.
export type McpTarget = {
  cli: string;
  path: string;
  format: "json" | "jsonc" | "toml";
  keyPath: string;
};

// A staged change is durable across pane lifecycles, so it records the surface
// and project/workspace scope that created it. A different pane may leave the
// staged change alone, but must not present or apply it as its own.
export type PendingChangeOwner = {
  surface: "harness" | "memory";
  scopeId: string;
};

// A prepared-but-not-yet-applied change plus the plan() output, held while the
// confirm dialog is open. `cli` selects the adapter that will apply it; `title`
// is the dialog's summary line. `artifact` is present for changes to an existing
// row (skill toggle, instruction edit) and absent for add-mcp-server (a brand-new
// entry that has no row yet).
export type PendingChange = {
  cli: string;
  title: string;
  change: ConfigChange;
  artifact?: HarnessArtifact;
  owner: PendingChangeOwner;
  // M15 batches keep the legacy single fields above as their first item so
  // existing KödMem/M10 consumers remain source-compatible. The store always
  // applies `items` when present.
  items?: PendingChangeItem[];
};

export type PendingChangeItem = {
  cli: string;
  title: string;
  change: ConfigChange;
  artifact?: HarnessArtifact;
};

export function isPendingChangeOwned(
  pending: PendingChange | null,
  owner: PendingChangeOwner,
): pending is PendingChange {
  return pending?.owner.surface === owner.surface && pending.owner.scopeId === owner.scopeId;
}

type PlannedBatchRequest = {
  cli: string;
  title: string;
  request: HarnessChangeRequest;
};

async function stageBatch(
  setState: (state: Partial<HarnessState>) => void,
  adapterFor: (cli: string) => HarnessAdapter | undefined,
  planned: readonly PlannedBatchRequest[],
  title: string,
  owner: PendingChangeOwner,
) {
  setState({ preparing: true, mutationError: null });
  try {
    const items: PendingChangeItem[] = [];
    for (const plan of planned) {
      const adapter = adapterFor(plan.cli);
      if (!adapter) throw new Error(`no adapter for ${plan.cli}`);
      items.push({
        cli: plan.cli,
        title: plan.title,
        change: await adapter.plan(plan.request),
      });
    }
    const first = items[0];
    setState({
      pendingChange: {
        cli: first.cli,
        title,
        change: first.change,
        owner,
        items,
      },
      preparing: false,
    });
  } catch (error) {
    setState({
      preparing: false,
      mutationError: error instanceof Error ? error.message : String(error),
    });
  }
}

export type HarnessState = {
  inventory: HarnessInventory | null;
  scanning: boolean;
  scanError: string | null;
  lastScannedAt: number | null;

  // --- Mutation (M10d): enable/disable through plan → confirm → apply/verify ---
  pendingChange: PendingChange | null;
  preparing: boolean; // plan() in flight (opening the confirm dialog)
  applying: boolean; // apply → verify in flight (the dialog's [apply] button)
  mutationError: string | null;
  kodSkills: KodSkillsModel | null;
  kodSkillsLoading: boolean;
  kodSkillsError: string | null;
  projectSkill: ProjectSkillModel | null;
  projectSkillLoading: boolean;
  projectSkillError: string | null;

  // Build the ConfigChange for toggling one artifact and stage it as
  // pendingChange (opening the confirm dialog). Never writes — plan() is
  // disk-free. A failure surfaces via mutationError.
  prepareToggle(artifactId: string, projectRoot: string, owner?: PendingChangeOwner): Promise<void>;
  // M10e: stage a whole-file instruction edit (CLAUDE.md/AGENTS.md-class) for the
  // confirm dialog. plan() reads current bytes for the diff + optimistic hash;
  // no write happens until confirmPendingChange.
  prepareEdit(
    artifactId: string,
    newText: string,
    projectRoot: string,
    owner?: PendingChangeOwner,
  ): Promise<void>;
  // M10e: the config files a new MCP server could be merged into for `scope`
  // (one per detected CLI MCP location). Drives the "+ add server…" target picker.
  listMcpTargets(scope: HarnessScope, projectRoot: string): Promise<McpTarget[]>;
  // M10e: stage a format-preserving single-key MCP merge into `target` for the
  // confirm dialog. plan() runs merge.ts (parse + single-key assertion); a corrupt
  // config, duplicate, or over-broad diff surfaces via mutationError and stages
  // nothing.
  prepareAddMcpServer(
    target: McpTarget,
    spec: McpServerSpec,
    projectRoot: string,
    owner?: PendingChangeOwner,
  ): Promise<void>;
  // Apply the staged change, verify it, and on a verify failure auto-restore
  // from the receipt and surface the reason. Rescans the last scope on either
  // outcome so the row reflects disk. Clears pendingChange when done.
  confirmPendingChange(owner?: PendingChangeOwner): Promise<void>;
  // Discard the staged change without touching disk.
  cancelPendingChange(owner?: PendingChangeOwner): void;
  loadKodSkills(projectRoot: string): Promise<void>;
  prepareKodSkills(
    action: KodSkillsAction,
    skillIds: readonly string[],
    targetIds: readonly string[],
    projectRoot: string,
    owner?: PendingChangeOwner,
  ): Promise<void>;
  loadProjectSkill(
    bundle: ProjectSkillSourceBundle,
    projectRoot: string,
    ownerIds?: readonly string[],
  ): Promise<void>;
  prepareProjectSkill(
    action: ProjectSkillAction,
    targetIds: readonly string[],
    projectRoot: string,
    owner?: PendingChangeOwner,
  ): Promise<void>;
  prepareProjectSkillReconcile(
    projectRoot: string,
    owner?: PendingChangeOwner,
  ): Promise<void>;
  clearProjectSkill(): void;

  // Re-scan one scope across every injected adapter. Monotonic generation
  // guard (the github store's pattern): a slower stale rescan can never
  // clobber a newer one's result, whichever scope/project it was for. Pure
  // seam over an already-built ScanContext, so it stays trivially testable
  // with a hand-built context (no IPC involved).
  rescan(scope: HarnessScope, ctx: ScanContext): Promise<void>;
  // Convenience wrapper (M10c): builds the real ScanContext (home/platform via
  // config.env()) for `projectRoot` and rescans `scope` with it. This is what
  // the pane calls — it replaced a project-scope-only "" home placeholder plus
  // path-sniffed platform guess, now that a real home/platform IPC exists.
  rescanScope(scope: HarnessScope, projectRoot: string): Promise<void>;
  // On-demand read of one artifact's raw file (an instruction file, a skill's
  // SKILL.md, a subagent file) for the pane's read-only [view] preview. Goes
  // through the same guarded ConfigIpc the scan uses — never a second seam.
  readArtifact(path: string, projectRoot: string): Promise<FileRead>;
};

export function createHarnessStore(deps: HarnessDeps) {
  let generation = 0;
  const now = deps.now ?? Date.now;
  const featureEnabled = deps.hasFeature ?? hasLicenseFeature;
  const hasHarnessPro = () => featureEnabled(FEATURES.harnessPro);
  let projectSkillOwnerIds: readonly string[] | undefined;
  // The last scope/projectRoot rescanned, so a post-mutation rescan can reuse
  // them (mutation actions are called from the pane without those args).
  let lastScan: { scope: HarnessScope; projectRoot: string } | null = null;

  const adapterFor = (cli: string): HarnessAdapter | undefined =>
    deps.adapters.find((adapter) => adapter.cli === cli);
  const defaultOwner = (projectRoot: string): PendingChangeOwner => ({
    surface: "harness",
    scopeId: projectRoot,
  });

  return createStore<HarnessState>((set, get) => ({
    inventory: null,
    scanning: false,
    scanError: null,
    lastScannedAt: null,
    pendingChange: null,
    preparing: false,
    applying: false,
    mutationError: null,
    kodSkills: null,
    kodSkillsLoading: false,
    kodSkillsError: null,
    projectSkill: null,
    projectSkillLoading: false,
    projectSkillError: null,

    async rescan(scope, ctx) {
      const gen = ++generation;
      set({ scanning: true, scanError: null });
      try {
        const inventory = await scanInventory(deps.adapters, scope, ctx, now);
        if (gen !== generation) return; // superseded by a newer rescan
        set({ inventory, scanning: false, lastScannedAt: inventory.scannedAt });
      } catch (error) {
        if (gen !== generation) return;
        set({
          scanning: false,
          scanError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async rescanScope(scope, projectRoot) {
      // rescan() owns the monotonic generation guard end-to-end; this just
      // builds the ScanContext first. A config.env() failure surfaces the
      // same way an adapter failure would, via the same scanError seam.
      lastScan = { scope, projectRoot };
      set({ scanning: true, scanError: null });
      try {
        const ctx = await buildScanContext(deps.config, projectRoot);
        await get().rescan(scope, ctx);
      } catch (error) {
        set({
          scanning: false,
          scanError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    readArtifact(path, projectRoot) {
      return deps.config.read(path, projectRoot);
    },

    async prepareToggle(artifactId, projectRoot, owner = defaultOwner(projectRoot)) {
      const artifact = get().inventory?.artifacts.find((a) => a.id === artifactId);
      if (!artifact) {
        set({ mutationError: "that artifact is no longer in the harness" });
        return;
      }
      const adapter = adapterFor(artifact.cli);
      if (!adapter) {
        set({ mutationError: `no adapter for ${artifact.cli}` });
        return;
      }
      const action = artifact.enabled ? "disable" : "enable";
      set({ preparing: true, mutationError: null });
      try {
        const change = await adapter.plan({ artifactId, action, projectRoot, artifact });
        set({
          pendingChange: { cli: artifact.cli, title: `${action} ${artifact.name}`, change, artifact, owner },
          preparing: false,
        });
      } catch (error) {
        set({
          preparing: false,
          mutationError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async prepareEdit(artifactId, newText, projectRoot, owner = defaultOwner(projectRoot)) {
      const artifact = get().inventory?.artifacts.find((a) => a.id === artifactId);
      if (!artifact) {
        set({ mutationError: "that artifact is no longer in the harness" });
        return;
      }
      if (artifact.kind !== "instruction") {
        set({ mutationError: "only instruction files can be edited here" });
        return;
      }
      const adapter = adapterFor(artifact.cli);
      if (!adapter) {
        set({ mutationError: `no adapter for ${artifact.cli}` });
        return;
      }
      set({ preparing: true, mutationError: null });
      try {
        const change = await adapter.plan({
          artifactId,
          action: "edit",
          projectRoot,
          artifact,
          payload: { path: artifact.path, newText },
        });
        set({
          pendingChange: { cli: artifact.cli, title: `edit ${artifact.name}`, change, artifact, owner },
          preparing: false,
        });
      } catch (error) {
        set({
          preparing: false,
          mutationError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async listMcpTargets(scope, projectRoot) {
      const ctx = await buildScanContext(deps.config, projectRoot);
      const targets: McpTarget[] = [];
      for (const adapter of deps.adapters) {
        const locations = await adapter.detect(scope, ctx);
        for (const loc of locations) {
          if (
            loc.kind === "mcp-server" &&
            loc.mcpKeyPath &&
            (loc.format === "json" || loc.format === "jsonc" || loc.format === "toml")
          ) {
            targets.push({
              cli: adapter.cli,
              path: loc.path,
              format: loc.format,
              keyPath: loc.mcpKeyPath,
            });
          }
        }
      }
      return targets;
    },

    async prepareAddMcpServer(target, spec, projectRoot, owner = defaultOwner(projectRoot)) {
      const adapter = adapterFor(target.cli);
      if (!adapter) {
        set({ mutationError: `no adapter for ${target.cli}` });
        return;
      }
      set({ preparing: true, mutationError: null });
      try {
        const change = await adapter.plan({
          artifactId: `${target.cli}:add-mcp:${spec.name}`,
          action: "add-mcp-server",
          projectRoot,
          payload: {
            path: target.path,
            format: target.format,
            keyPath: target.keyPath,
            server: spec,
          },
        });
        set({
          pendingChange: { cli: target.cli, title: `add MCP server ${spec.name}`, change, owner },
          preparing: false,
        });
      } catch (error) {
        set({
          preparing: false,
          mutationError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async loadKodSkills(projectRoot) {
      set({ kodSkillsLoading: true, kodSkillsError: null });
      try {
        const ctx = await buildScanContext(deps.config, projectRoot);
        const model = await inspectKodSkills(deps.config, ctx, hasHarnessPro());
        set({ kodSkills: model, kodSkillsLoading: false });
      } catch (error) {
        set({
          kodSkills: null,
          kodSkillsLoading: false,
          kodSkillsError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async prepareKodSkills(
      action,
      skillIds,
      targetIds,
      projectRoot,
      owner = defaultOwner(projectRoot),
    ) {
      const model = get().kodSkills;
      if (!model) {
        set({ mutationError: "load KödSkills before preparing a change" });
        return;
      }
      const planned = buildKodSkillsRequests(
        model,
        action,
        skillIds,
        targetIds,
        projectRoot,
        hasHarnessPro(),
      );
      if (planned.length === 0) {
        set({ mutationError: `no selected KödSkills are eligible to ${action}` });
        return;
      }
      await stageBatch(
        set,
        adapterFor,
        planned,
        `${action} ${planned.length} KödSkills ${planned.length === 1 ? "change" : "changes"}`,
        owner,
      );
    },

    async loadProjectSkill(bundle, projectRoot, ownerIds) {
      projectSkillOwnerIds = ownerIds;
      set({
        projectSkill: null,
        projectSkillLoading: true,
        projectSkillError: null,
        mutationError: null,
      });
      try {
        const ctx = await buildScanContext(deps.config, projectRoot);
        const model = await inspectProjectSkill(
          deps.config,
          bundle,
          ctx,
          hasHarnessPro(),
          projectSkillOwnerIds,
        );
        set({ projectSkill: model, projectSkillLoading: false });
      } catch (error) {
        set({
          projectSkill: null,
          projectSkillLoading: false,
          projectSkillError: error instanceof Error ? error.message : String(error),
        });
      }
    },

    clearProjectSkill() {
      projectSkillOwnerIds = undefined;
      set({
        projectSkill: null,
        projectSkillLoading: false,
        projectSkillError: null,
      });
    },

    async prepareProjectSkill(
      action,
      targetIds,
      projectRoot,
      owner = defaultOwner(projectRoot),
    ) {
      const model = get().projectSkill;
      if (!model) {
        set({ mutationError: "choose a project skill folder before preparing a change" });
        return;
      }
      const planned = buildProjectSkillRequests(
        model,
        action,
        targetIds,
        projectRoot,
        hasHarnessPro(),
        projectSkillOwnerIds,
      );
      if (planned.length === 0) {
        set({ mutationError: `no selected project skill targets are eligible to ${action}` });
        return;
      }
      await stageBatch(
        set,
        adapterFor,
        planned,
        `${action} ${model.skill.id} in ${planned.length} ${
          planned.length === 1 ? "target" : "targets"
        }`,
        owner,
      );
    },

    async prepareProjectSkillReconcile(
      projectRoot,
      owner = defaultOwner(projectRoot),
    ) {
      const model = get().projectSkill;
      if (!model) {
        set({ mutationError: "load a project skill before preparing a change" });
        return;
      }
      const installIds = model.cells
        .filter((cell) => cell.status === "ready")
        .map((cell) => cell.targetId);
      const updateIds = model.cells
        .filter((cell) => cell.status === "update")
        .map((cell) => cell.targetId);
      const planned = [
        ...buildProjectSkillRequests(
          model,
          "install",
          installIds,
          projectRoot,
          hasHarnessPro(),
          projectSkillOwnerIds,
        ),
        ...buildProjectSkillRequests(
          model,
          "update",
          updateIds,
          projectRoot,
          hasHarnessPro(),
          projectSkillOwnerIds,
        ),
      ];
      if (planned.length === 0) return;
      await stageBatch(
        set,
        adapterFor,
        planned,
        `install or update ${model.skill.id} in ${planned.length} ${
          planned.length === 1 ? "target" : "targets"
        }`,
        owner,
      );
    },

    async confirmPendingChange(owner) {
      const pending = get().pendingChange;
      if (!pending || (owner && !isPendingChangeOwned(pending, owner))) return;
      const items = pending.items ?? [
        { cli: pending.cli, title: pending.title, change: pending.change, artifact: pending.artifact },
      ];
      const adapters = items.map((item) => adapterFor(item.cli));
      const missing = items.find((_, index) => !adapters[index]);
      if (missing) {
        set({ mutationError: `no adapter for ${missing.cli}` });
        return;
      }
      set({ applying: true, mutationError: null });
      const rescan = async () => {
        if (lastScan) await get().rescanScope(lastScan.scope, lastScan.projectRoot);
      };
      const applied: { adapter: HarnessAdapter; receipt: ChangeReceipt }[] = [];
      const rollback = async (entries: typeof applied): Promise<string[]> => {
        const errors: string[] = [];
        for (const entry of [...entries].reverse()) {
          try {
            await entry.adapter.restore(entry.receipt);
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        return errors;
      };
      try {
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const adapter = adapters[index]!;
          const receipt = await adapter.apply(item.change);
          applied.push({ adapter, receipt });
          const result = await adapter.verify(receipt);
          if (!result.ok) {
            // Verify failed — auto-restore from the receipt and surface why. If the
            // restore ALSO fails, keep both reasons: losing the verify failure would
            // hide why the change was rejected in the first place.
            const restoreErrors = await rollback(applied);
            let message = `${items.length > 1 ? "batch" : "change"} reverted: ${result.reason}`;
            if (restoreErrors.length > 0) {
              message = `verify failed: ${result.reason}; restore also failed: ${restoreErrors.join("; ")}`;
            }
            set({ applying: false, pendingChange: null, mutationError: message });
            await rescan();
            return;
          }
        }
        set({ applying: false, pendingChange: null });
        await rescan();
      } catch (error) {
        // A later batch item can fail after earlier items committed. Roll those
        // receipts back in reverse order; each adapter owns its inverse.
        const restoreErrors = await rollback(applied);
        const detail = error instanceof Error ? error.message : String(error);
        set({
          applying: false,
          pendingChange: null,
          mutationError: restoreErrors.length > 0
            ? `${detail}; restore also failed: ${restoreErrors.join("; ")}`
            : detail,
        });
        await rescan();
      }
    },

    cancelPendingChange(owner) {
      const pending = get().pendingChange;
      if (pending && owner && !isPendingChangeOwned(pending, owner)) return;
      set({ pendingChange: null, mutationError: null });
    },
  }));
}

// Build the ScanContext for one rescan: home/platform come from the real
// config_env IPC call (M10c), so project AND global scope both resolve
// against the user's actual home rather than a blank placeholder.
export async function buildScanContext(
  config: ConfigIpc,
  projectRoot: string,
): Promise<ScanContext> {
  const env = await config.env();
  return {
    home: env.home,
    platform: env.platform,
    projectRoot,
    appDataRoaming: env.appDataRoaming,
    appDataLocal: env.appDataLocal,
  };
}
