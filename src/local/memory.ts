/** The small, client-facing subset of KödMCP's get_context response. */
export type ProjectMemoryRecord = {
  title?: string;
  body?: string;
};

export type ProjectCheckpoint = {
  summary?: string;
  nextActions?: string[];
};

export type ProjectMemoryContext = {
  workspace?: { canonicalRoot?: string; displayName?: string };
  latestCheckpoint?: ProjectCheckpoint | null;
  pinnedDecisions?: ProjectMemoryRecord[];
  openTasks?: ProjectMemoryRecord[];
  recentMemories?: ProjectMemoryRecord[];
};

export type MemoryCheckpointInput = {
  workspaceRoot: string;
  summary: string;
  nextActions: string[];
  sessionId: string;
  idempotencyKey: string;
};

/** KödMCP is an optional process boundary, so the loop only needs this narrow seam. */
export type MemoryCheckpointClient = {
  checkpoint(input: MemoryCheckpointInput): Promise<unknown>;
};

const MAX_RECORD_CHARS = 600;
const MAX_MEMORY_CHARS = 12_000;

function short(value: string | undefined): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_RECORD_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_RECORD_CHARS - 1).trimEnd()}…`;
}

function records(
  title: string,
  values: readonly ProjectMemoryRecord[] | undefined,
): string | null {
  if (!values?.length) return null;
  const lines = values.map((value) => {
    const label = short(value.title);
    const body = short(value.body);
    return `- ${label}${label && body ? ": " : ""}${body || "(no detail)"}`;
  });
  return `### ${title}\n${lines.join("\n")}`;
}

/** Render a bounded, explicitly-delimited KödMem section for the agent's system context. */
export function formatProjectMemory(context: ProjectMemoryContext): string {
  const checkpoint = context.latestCheckpoint;
  const checkpointSection = checkpoint?.summary
    ? [
        "### Latest checkpoint",
        short(checkpoint.summary),
        ...(checkpoint.nextActions?.length
          ? [
              "Next actions:",
              ...checkpoint.nextActions
                .slice(0, 5)
                .map((action) => `- ${short(action)}`),
            ]
          : []),
      ].join("\n")
    : null;
  const sections = [
    "## Project memory (KödMem)",
    "Use this local, durable project context when it is relevant. It may be incomplete or stale; verify before making risky claims.",
    checkpointSection,
    records("Pinned decisions", context.pinnedDecisions),
    records("Open tasks", context.openTasks),
    records("Recent memories", context.recentMemories),
  ].filter((section): section is string => Boolean(section));
  const rendered = sections.join("\n\n");
  return rendered.length <= MAX_MEMORY_CHARS
    ? rendered
    : `${rendered.slice(0, MAX_MEMORY_CHARS - 1).trimEnd()}…`;
}
