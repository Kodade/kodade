/** Compatibility exports for the KödLocal CLI and delegate boundary. */
export {
  boundProviderMemory,
  formatProjectMemory,
} from "../memory/provider-context";
export type {
  ProjectCheckpoint,
  ProjectMemoryContext,
  ProjectMemoryRecord,
} from "../memory/provider-context";

export type MemoryCheckpointInput = {
  workspaceRoot: string;
  summary: string;
  nextActions: string[];
  sessionId: string;
  idempotencyKey: string;
  updateState: false;
};

/** KödMCP is an optional process boundary, so the loop only needs this narrow seam. */
export type MemoryCheckpointClient = {
  checkpoint(input: MemoryCheckpointInput): Promise<unknown>;
};
