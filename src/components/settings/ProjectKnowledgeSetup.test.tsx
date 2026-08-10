import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LegacyMigrationPlan,
  ProjectScaffoldPlan,
} from "../../ipc/contract";
import {
  ProjectKnowledgeSetup,
  type ProjectKnowledgeIpc,
} from "./ProjectKnowledgeSetup";

const plan: ProjectScaffoldPlan = {
  workspaceId: "ws_portable",
  projectId: "portable-project",
  projectDisplayName: "Portable project",
  vaultRoot: "vault-root",
  fingerprint: "abc123",
  operations: [
    {
      kind: "createDirectory",
      relativePath: "10-Projects/portable-project/Worklog",
      content: null,
    },
    {
      kind: "createFile",
      relativePath: "10-Projects/portable-project/Project.md",
      content: "# Portable project\n",
    },
  ],
};

const noLegacy: LegacyMigrationPlan = {
  schema: 1,
  status: "noLegacy",
  workspaceId: "ws_portable",
  projectId: "portable-project",
  projectDisplayName: "Portable project",
  fingerprint: "f".repeat(64),
  migrationId: null,
  manifestSha256: null,
  sources: [],
  sourceSnapshots: [],
  counts: {
    sourceFiles: 0,
    memories: 0,
    checkpoints: 0,
    operations: 0,
    duplicates: 0,
    conflicts: 0,
  },
  operations: [],
  systemOperations: [],
  canApply: false,
  sourceRetained: true,
  createsLocalRecoveryBackup: false,
  writesCutoverLast: false,
  recovery: null,
};

function projectKnowledgeIpc(
  overrides: Partial<ProjectKnowledgeIpc> = {},
): ProjectKnowledgeIpc {
  return {
    previewProjectScaffold: vi.fn().mockResolvedValue(plan),
    applyProjectScaffold: vi.fn().mockResolvedValue({
      projectId: plan.projectId,
      created: plan.operations,
    }),
    previewLegacyMigration: vi.fn().mockResolvedValue(noLegacy),
    applyLegacyMigration: vi.fn(),
    rollbackLegacyMigration: vi.fn(),
    openProjectInObsidian: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("project knowledge setup", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  const render = async (element: React.ReactElement) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(element));
  };

  const button = (label: string) =>
    Array.from(container?.querySelectorAll("button") ?? []).find(
      (candidate) => candidate.textContent === label,
    );

  it("previews every operation before applying the exact plan and opening Obsidian", async () => {
    const ready = { ...plan, fingerprint: "ready", operations: [] };
    const ipc = projectKnowledgeIpc({
      previewProjectScaffold: vi
        .fn()
        .mockResolvedValueOnce(plan)
        .mockResolvedValueOnce(ready),
    });
    await render(<ProjectKnowledgeSetup workspaceId="ws_portable" ipc={ipc} />);

    expect(container?.querySelector("#project-knowledge-setup")).not.toBeNull();

    expect(container?.textContent).toContain(
      "approved legacy-memory migration copies eligible history into canonical notes while retaining every source",
    );

    await act(async () => button("Preview knowledge setup")?.click());

    expect(ipc.previewProjectScaffold).toHaveBeenCalledWith("ws_portable");
    expect(container?.textContent).toContain(
      "10-Projects/portable-project/Worklog",
    );
    expect(container?.textContent).toContain(
      "10-Projects/portable-project/Project.md",
    );
    expect(container?.textContent).toContain("# Portable project");
    const planDetails = container?.querySelector("details");
    expect(planDetails?.open).toBe(false);
    expect(planDetails?.querySelector("summary")?.textContent).toBe(
      "Plan details",
    );
    expect(button("Open in Obsidian")?.disabled).toBe(true);

    await act(async () => button("Create 2 missing items")?.click());

    expect(ipc.applyProjectScaffold).toHaveBeenCalledWith(
      "ws_portable",
      "abc123",
    );
    expect(container?.textContent).toContain(
      "Created 2 missing items. Existing notes were left unchanged.",
    );
    expect(container?.textContent).toContain("Project knowledge is ready.");
    expect(button("Open in Obsidian")?.disabled).toBe(false);

    await act(async () => button("Open in Obsidian")?.click());
    expect(ipc.openProjectInObsidian).toHaveBeenCalledWith("ws_portable");
  });

  it("keeps a stale-plan failure visible and offers a refresh", async () => {
    const ipc = projectKnowledgeIpc({
      applyProjectScaffold: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "project knowledge changed after preview; refresh the preview",
          ),
        ),
    });
    await render(<ProjectKnowledgeSetup workspaceId="ws_portable" ipc={ipc} />);
    await act(async () => button("Preview knowledge setup")?.click());
    await act(async () => button("Create 2 missing items")?.click());

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "project knowledge changed after preview",
    );
    expect(button("Refresh preview")).toBeDefined();
  });

  it("shows every legacy operation and retains backup-driven rollback", async () => {
    const readyScaffold = { ...plan, operations: [] };
    const migration: LegacyMigrationPlan = {
      ...noLegacy,
      status: "ready",
      migrationId: "kmig_1234",
      manifestSha256: "m".repeat(64),
      sources: [
        {
          workspaceId: "ws_portable",
          workspaceDisplayName: "Portable project",
          snapshotCount: 2,
        },
      ],
      counts: {
        sourceFiles: 1,
        memories: 2,
        checkpoints: 3,
        operations: 1,
        duplicates: 0,
        conflicts: 0,
      },
      operations: [
        {
          action: "replacePlaceholder",
          sourceKind: "state",
          sourceRelativePath: ".kodade/memory/STATE.md",
          sourceSha256: "s".repeat(64),
          targetRelativePath: "STATE.md",
          expectedTargetSha256: "e".repeat(64),
          targetSha256: "t".repeat(64),
          itemCount: 1,
          conflict: null,
        },
      ],
      systemOperations: [
        {
          sequence: 1,
          kind: "createRecoveryBackup",
          target: "Ködade app data recovery journal",
          localOnly: true,
        },
        {
          sequence: 2,
          kind: "writePendingAuthority",
          target: "Project.md migration-pending marker",
          localOnly: false,
        },
        {
          sequence: 3,
          kind: "rebuildDerivedIndex",
          target: "Local KödMem derived index",
          localOnly: true,
        },
        {
          sequence: 4,
          kind: "writeCutoverLast",
          target: "Project.md cutover receipt",
          localOnly: false,
        },
      ],
      canApply: true,
      createsLocalRecoveryBackup: true,
      writesCutoverLast: true,
    };
    const ipc = projectKnowledgeIpc({
      previewProjectScaffold: vi.fn().mockResolvedValue(readyScaffold),
      previewLegacyMigration: vi
        .fn()
        .mockResolvedValueOnce(migration)
        .mockResolvedValueOnce({ ...noLegacy, status: "complete" })
        .mockResolvedValueOnce(migration),
      applyLegacyMigration: vi.fn().mockResolvedValue({
        projectId: "portable-project",
        migrationId: "kmig_1234",
        manifestSha256: "m".repeat(64),
        written: 1,
        skipped: 0,
        backupPath: "/app-data/migrations/kmig_1234.json",
        sourceRetained: true,
      }),
      rollbackLegacyMigration: vi.fn().mockResolvedValue({
        projectId: "portable-project",
        migrationId: "kmig_1234",
        restored: 1,
        removed: 0,
        sourceRetained: true,
      }),
    });
    await render(<ProjectKnowledgeSetup workspaceId="ws_portable" ipc={ipc} />);

    await act(async () => button("Preview knowledge setup")?.click());
    expect(container?.textContent).toContain(".kodade/memory/STATE.md");
    expect(container?.textContent).toContain("STATE.md");
    expect(container?.textContent).toContain(
      "Target project: Portable project (portable-project)",
    );
    expect(container?.textContent).toContain("Sources remain");
    expect(container?.textContent).toContain(
      "writes the Project.md cutover receipt as the final vault change",
    );
    expect(container?.textContent).toContain("createRecoveryBackup");
    expect(container?.textContent).toContain(
      "Project.md migration-pending marker",
    );
    expect(container?.textContent).toContain("writeCutoverLast");

    await act(async () => button("Migrate and retain sources")?.click());
    expect(ipc.applyLegacyMigration).toHaveBeenCalledWith(
      "ws_portable",
      migration.fingerprint,
    );
    expect(container?.textContent).toContain(
      "/app-data/migrations/kmig_1234.json",
    );

    await act(async () =>
      button("Roll back unchanged migration outputs")?.click(),
    );
    expect(ipc.rollbackLegacyMigration).toHaveBeenCalledWith(
      "ws_portable",
      "kmig_1234",
      "m".repeat(64),
    );
    expect(container?.textContent).toContain("Legacy sources were retained");
  });

  it.each([
    ["prepared", true],
    ["markdownWritten", true],
    ["complete", false],
    ["rollingBack", false],
  ] as const)(
    "rediscovers %s migration recovery after a remount",
    async (phase, canRetry) => {
      const recoveryPlan: LegacyMigrationPlan = {
        ...noLegacy,
        status: phase === "complete" ? "complete" : phase === "rollingBack" ? "blocked" : "ready",
        migrationId: "kmig_recovery",
        manifestSha256: "a".repeat(64),
        canApply: canRetry,
        recovery: {
          migrationId: "kmig_recovery",
          manifestSha256: "a".repeat(64),
          phase,
          canRetry,
          canRollback: true,
        },
      };
      const ipc = projectKnowledgeIpc({
        previewProjectScaffold: vi.fn().mockResolvedValue({ ...plan, operations: [] }),
        previewLegacyMigration: vi
          .fn()
          .mockResolvedValueOnce(recoveryPlan)
          .mockResolvedValueOnce(noLegacy),
        rollbackLegacyMigration: vi.fn().mockResolvedValue({
          projectId: "portable-project",
          migrationId: "kmig_recovery",
          restored: 0,
          removed: 1,
          sourceRetained: true,
        }),
      });
      await render(<ProjectKnowledgeSetup workspaceId="ws_portable" ipc={ipc} />);

      await act(async () => button("Preview knowledge setup")?.click());
      const rollbackLabel =
        phase === "rollingBack"
          ? "Resume rollback"
          : "Roll back unchanged migration outputs";
      expect(button(rollbackLabel)).toBeDefined();
      if (phase === "rollingBack") {
        expect(container?.textContent).toContain("Rollback was interrupted");
        expect(container?.textContent).not.toContain("Nothing has been written");
      }
      await act(async () => button(rollbackLabel)?.click());
      expect(ipc.rollbackLegacyMigration).toHaveBeenCalledWith(
        "ws_portable",
        "kmig_recovery",
        "a".repeat(64),
      );
    },
  );

  it.each([
    ["prepared", "may include a pending authority marker"],
    ["markdownWritten", "canonical outputs were written"],
    ["cutover", "reached cutover"],
  ] as const)("reports blocked %s recovery truthfully", async (phase, copy) => {
    const recoveryPlan: LegacyMigrationPlan = {
      ...noLegacy,
      status: "blocked",
      migrationId: "kmig_blocked",
      manifestSha256: "b".repeat(64),
      canApply: false,
      recovery: {
        migrationId: "kmig_blocked",
        manifestSha256: "b".repeat(64),
        phase,
        canRetry: false,
        canRollback: true,
      },
    };
    await render(
      <ProjectKnowledgeSetup
        workspaceId="ws_portable"
        ipc={projectKnowledgeIpc({
          previewProjectScaffold: vi
            .fn()
            .mockResolvedValue({ ...plan, operations: [] }),
          previewLegacyMigration: vi.fn().mockResolvedValue(recoveryPlan),
        })}
      />,
    );
    await act(async () => button("Preview knowledge setup")?.click());
    expect(container?.textContent).toContain(copy);
    expect(container?.textContent).not.toContain("Nothing has been written");
  });
});
