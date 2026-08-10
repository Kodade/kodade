import { invoke } from "@tauri-apps/api/core";
import {
  CMD,
  type AuditEntry,
  type AuditQuery,
  type ActivityEvent,
  type Checkpoint,
  type CheckpointSearchHit,
  type DeletedMemoryQuery,
  type ExportResult,
  type MemoryIpc,
  type MemoryMcpBinaryPath,
  type MemoryRecord,
  type MemorySearchHit,
  type MemoryWorkspace,
  type Page,
  type ProjectsVault,
  type ProjectScaffoldApply,
  type ProjectScaffoldPlan,
  type RetentionReport,
  type Tombstone,
  type WorkspaceContext,
  type WorkingMemoryStatus,
  type WorkspaceProjectMapping,
} from "./contract";

// KödMem's sole frontend-to-native boundary. All database work stays behind
// these async commands; React and stores only handle typed values.
export const tauriMemory: MemoryIpc = {
  registerWorkspace: (root, displayName, color) =>
    invoke<MemoryWorkspace>(CMD.memoryRegisterWorkspace, { root, displayName, color }),
  resolveWorkspace: (root) =>
    invoke<MemoryWorkspace | null>(CMD.memoryResolveWorkspace, { root }),
  listWorkspaces: () =>
    invoke<MemoryWorkspace[]>(CMD.memoryListWorkspaces),
  relinkWorkspace: (workspaceId, expectedRoot, newRoot, sourceClient) =>
    invoke<MemoryWorkspace>(CMD.memoryRelinkWorkspace, {
      workspaceId,
      expectedRoot,
      newRoot,
      sourceClient,
    }),
  projectsVault: () =>
    invoke<ProjectsVault | null>(CMD.memoryProjectsVault),
  registerProjectsVault: (root) =>
    invoke<ProjectsVault>(CMD.memoryRegisterProjectsVault, { root }),
  workspaceProjectMapping: (workspaceId) =>
    invoke<WorkspaceProjectMapping | null>(CMD.memoryWorkspaceProjectMapping, {
      workspaceId,
    }),
  mapWorkspaceToProject: (
    workspaceId,
    expectedProjectId,
    projectId,
    projectDisplayName,
  ) =>
    invoke<WorkspaceProjectMapping>(CMD.memoryMapWorkspaceToProject, {
      workspaceId,
      expectedProjectId,
      projectId,
      projectDisplayName,
    }),
  projectWorkspaceMappings: (projectId) =>
    invoke<WorkspaceProjectMapping[]>(CMD.memoryProjectWorkspaceMappings, {
      projectId,
    }),
  previewProjectScaffold: (workspaceId) =>
    invoke<ProjectScaffoldPlan>(CMD.memoryPreviewProjectScaffold, {
      workspaceId,
    }),
  applyProjectScaffold: (workspaceId, expectedFingerprint) =>
    invoke<ProjectScaffoldApply>(CMD.memoryApplyProjectScaffold, {
      workspaceId,
      expectedFingerprint,
    }),
  openProjectInObsidian: (workspaceId) =>
    invoke<void>(CMD.memoryOpenProjectInObsidian, { workspaceId }),
  context: (workspaceId) =>
    invoke<WorkspaceContext>(CMD.memoryContext, { workspaceId }),
  search: (query) => invoke<Page<MemorySearchHit>>(CMD.memorySearch, { query }),
  get: (id) => invoke<MemoryRecord>(CMD.memoryGet, { id }),
  listDeleted: (query) =>
    invoke<Page<MemoryRecord>>(CMD.memoryListDeleted, { query }),
  remember: (input) => invoke<MemoryRecord>(CMD.memoryRemember, { input }),
  revise: (input, expectedContentHash) => invoke<MemoryRecord>(CMD.memoryRevise, {
    input,
    ...(expectedContentHash ? { expectedContentHash } : {}),
  }),
  forget: (id, expectedVersion, sourceClient, sessionId, expectedContentHash) =>
    invoke<Tombstone>(CMD.memoryForget, {
      id,
      expectedVersion,
      sourceClient,
      sessionId,
      ...(expectedContentHash ? { expectedContentHash } : {}),
    }),
  restore: (id, expectedVersion, sourceClient, sessionId, expectedContentHash) =>
    invoke<MemoryRecord>(CMD.memoryRestore, {
      id,
      expectedVersion,
      sourceClient,
      sessionId,
      ...(expectedContentHash ? { expectedContentHash } : {}),
    }),
  checkpoint: (input, expectedStateHash) => invoke<Checkpoint>(CMD.memoryCheckpoint, {
    input,
    ...(expectedStateHash ? { expectedStateHash } : {}),
  }),
  searchCheckpoints: (query) =>
    invoke<Page<CheckpointSearchHit>>(CMD.memorySearchCheckpoints, { query }),
  workingStatus: (workspaceId) =>
    invoke<WorkingMemoryStatus | null>(CMD.memoryWorkingStatus, { workspaceId }),
  activateWorking: (workspaceId, mode, exportExisting) =>
    invoke<WorkingMemoryStatus>(CMD.memoryActivateWorking, {
      workspaceId,
      mode,
      exportExisting,
    }),
  syncWorking: (workspaceId) =>
    invoke<number>(CMD.memorySyncWorking, { workspaceId }),
  observeCommit: (workspaceId, head) =>
    invoke<Checkpoint | null>(CMD.memoryObserveCommit, { workspaceId, head }),
  audit: (query) => invoke<Page<AuditEntry>>(CMD.memoryAudit, { query }),
  setRetention: (workspaceId, settings, provenance) =>
    invoke<MemoryWorkspace>(CMD.memorySetRetention, { workspaceId, settings, provenance }),
  runRetention: (workspaceId, now, batchSize, provenance) =>
    invoke<RetentionReport>(CMD.memoryRunRetention, { workspaceId, now, batchSize, provenance }),
  drainRetention: (workspaceId, provenance) =>
    invoke<RetentionReport>(CMD.memoryDrainRetention, { workspaceId, provenance }),
  exportToDirectory: (workspaceId, destination) =>
    invoke<ExportResult>(CMD.memoryExportToDirectory, { workspaceId, destination }),
  purgeWorkspace: (workspaceId) =>
    invoke<void>(CMD.memoryPurgeWorkspace, { workspaceId }),
  recordActivity: (input) =>
    invoke<ActivityEvent | null>(CMD.memoryRecordActivity, { input }),
  databasePath: () => invoke<string>(CMD.memoryDatabasePath),
  mcpBinaryPath: () => invoke<MemoryMcpBinaryPath>(CMD.memoryMcpBinaryPath),
};
