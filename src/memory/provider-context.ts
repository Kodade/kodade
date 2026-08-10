import type { ProjectKnowledgeContext } from "../ipc/contract";

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
  projectKnowledge?: ProjectKnowledgeContext | null;
};

export const PROVIDER_MEMORY_MAX_CHARS = 12_000;
const MAX_RECORD_CHARS = 600;
const MAX_PROJECT_SOURCE_CHARS = 4_000;

function truncateCharacters(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  if (limit <= 0) return "";
  if (limit === 1) return "…";
  return `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

/** One provider-facing character budget shared by KödLocal and KödChat. */
export function boundProviderMemory(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return truncateCharacters(normalized, PROVIDER_MEMORY_MAX_CHARS);
}

function short(value: string | undefined): string {
  if (!value) return "";
  return truncateCharacters(value.replace(/\s+/g, " ").trim(), MAX_RECORD_CHARS);
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

function mappedProject(context: ProjectKnowledgeContext | null | undefined): string | null {
  if (!context) return null;
  const heading = `### Mapped project · ${context.projectDisplayName} (${context.projectId})`;
  if (context.sync.status === "error") {
    return [
      heading,
      "Mapped project sync error",
      "Refresh failed. Repair the mapped project in the local Memory pane, then retry.",
    ].join("\n");
  }
  const sources = context.sources.map((source) => [
    `#### ${source.title}`,
    `${source.relativePath} · sha256:${source.sha256.slice(0, 12)}`,
    truncateCharacters(source.content, MAX_PROJECT_SOURCE_CHARS),
  ].join("\n"));
  return [
    heading,
    `Indexed ${context.sync.indexedDocuments} Markdown documents${context.sync.truncated ? " · bounded" : ""}.`,
    ...sources,
  ].join("\n\n");
}

/** Render bounded KödMem context without local absolute paths for providers. */
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
    mappedProject(context.projectKnowledge),
    checkpointSection,
    records("Pinned decisions", context.pinnedDecisions),
    records("Open tasks", context.openTasks),
    records("Recent memories", context.recentMemories),
  ].filter((section): section is string => Boolean(section));
  return boundProviderMemory(sections.join("\n\n")) ?? "";
}
