// The transcript half of KödChat: user bubbles, streaming assistant markdown,
// collapsible thinking, compact tool activity, and the two failure cards.
//
// All styling is tokens-only so it re-skins with every app theme.

import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "../../markdown/render";
import { rawAllowedAnchorHref } from "../../markdown/links";
import type { ChatEntry, ChatThread } from "../../chat/model";

export function ChatTranscript({
  thread,
  onOpenLink,
  onOpenLoginTerminal,
}: {
  thread: ChatThread;
  onOpenLink(url: string): void;
  onOpenLoginTerminal(): void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const entryCount = thread.entries.length;
  const lastText =
    thread.entries.at(-1)?.kind === "message"
      ? (thread.entries.at(-1) as { text: string }).text.length
      : 0;

  // Follow the stream. Keyed on the last entry's length as well as the count so
  // a growing assistant message keeps the view pinned to the bottom.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entryCount, lastText]);

  if (thread.entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-sm text-text-dim">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col gap-3 overflow-y-auto px-3 py-3"
      data-testid="chat-transcript"
    >
      {transcriptRows(thread.entries).map((row) =>
        row.kind === "tools" ? (
          <ToolActivitySummary key={row.entries[0].id} entries={row.entries} />
        ) : (
          <TranscriptEntry
            key={row.entry.id}
            entry={row.entry}
            onOpenLink={onOpenLink}
            onOpenLoginTerminal={onOpenLoginTerminal}
          />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}

function TranscriptEntry({
  entry,
  onOpenLink,
  onOpenLoginTerminal,
}: {
  entry: ChatEntry;
  onOpenLink(url: string): void;
  onOpenLoginTerminal(): void;
}) {
  if (entry.kind === "message") {
    return entry.role === "user" ? (
      <div className="flex justify-end">
        <div
          data-chat-role="user"
          className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-surface px-3 py-2 text-sm text-text"
        >
          {entry.text}
        </div>
      </div>
    ) : (
      <div
        data-chat-role="assistant"
        data-streaming={entry.streaming ? "true" : undefined}
        className="markdown-view max-w-none text-sm text-text"
        onClick={(event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const link = target.closest<HTMLAnchorElement>("a");
          if (!link) return;
          event.preventDefault();
          const href = rawAllowedAnchorHref(link);
          if (href) onOpenLink(href);
        }}
        // Sanitized by renderMarkdown (markdown-it with html:false, then
        // DOMPurify) — the same boundary the editor preview uses.
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(entry.text, { decorateGithubLinks: true }),
        }}
      />
    );
  }

  if (entry.kind === "thinking") {
    return (
      <Collapsible label="Thinking" tone="dim">
        <pre className="whitespace-pre-wrap break-words text-xs text-text-dim">
          {entry.text}
        </pre>
      </Collapsible>
    );
  }

  if (entry.kind === "plan") {
    return (
      <div className="rounded-md border border-border bg-surface px-3 py-2">
        <p className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-text-dim">
          Plan
        </p>
        <ul className="flex flex-col gap-0.5">
          {entry.items.map((item, index) => (
            <li key={`${item.text}-${index}`} className="flex gap-2 text-xs text-text">
              <span aria-hidden="true" className="text-text-dim">
                {item.status === "completed" ? "×" : item.status === "in-progress" ? "›" : "·"}
              </span>
              <span className={item.status === "completed" ? "text-text-dim line-through" : ""}>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // Tool entries are compacted by transcriptRows before reaching this branch.
  if (entry.kind === "tool") return null;

  // An auth failure is the one error with a real remedy: log in through the
  // CLI's own flow, in a terminal. Kodade never proxies those credentials.
  return (
    <div
      data-testid={entry.auth ? "chat-auth-card" : "chat-error-card"}
      className="rounded-md border border-red-400/40 bg-surface px-3 py-2"
    >
      <p className="text-xs text-red-400">{entry.message}</p>
      {entry.auth && (
        <button
          type="button"
          onClick={onOpenLoginTerminal}
          className="mt-2 rounded border border-border px-2 py-1 text-xs text-text hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
        >
          Open a terminal to log in
        </button>
      )}
    </div>
  );
}

type ToolEntry = Extract<ChatEntry, { kind: "tool" }>;
type TranscriptRow =
  | { kind: "entry"; entry: Exclude<ChatEntry, ToolEntry> }
  | { kind: "tools"; entries: ToolEntry[] };

// Tool activity is derived from persisted rows rather than stored as another
// transcript shape. A text, thinking, plan, or error row ends the group.
function transcriptRows(entries: ChatEntry[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let tools: ToolEntry[] = [];
  const flushTools = () => {
    if (tools.length > 0) rows.push({ kind: "tools", entries: tools });
    tools = [];
  };
  for (const entry of entries) {
    if (entry.kind === "tool") {
      tools.push(entry);
      continue;
    }
    flushTools();
    rows.push({ kind: "entry", entry });
  }
  flushTools();
  return rows;
}

function ToolActivitySummary({ entries }: { entries: ToolEntry[] }) {
  const [open, setOpen] = useState(false);
  const running = entries.some((entry) => entry.outcome === null);
  const failures = entries.filter((entry) => entry.outcome?.status === "error").length;
  const denied = entries.filter((entry) => entry.outcome?.status === "denied").length;
  const state = running
    ? "working"
    : failures > 0
      ? "failed"
      : denied > 0
        ? "needs approval"
        : "completed";
  const count = `${entries.length} action${entries.length === 1 ? "" : "s"}`;

  return (
    <section
      data-testid="chat-tool-activity"
      className="rounded-md border border-border bg-surface px-3 py-2 text-xs"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={
            running
              ? "mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent kd-dot-pulse"
              : "mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-text-dim"
          }
        />
        <div className="min-w-0 flex-1">
          <p className="text-text">{activityLabel(entries)}</p>
          <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-text-dim">
            <span>{count}</span>
            <span>{state}</span>
            {failures > 0 && (
              <span className="text-[var(--kd-error)]">{failures} failed</span>
            )}
            {denied > 0 && <span className="text-[var(--kd-warning)]">{denied} denied</span>}
          </p>
        </div>
        <button
          type="button"
          aria-label={open ? "Hide tool details" : "Show tool details"}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="shrink-0 text-[11px] text-text-dim hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          Details
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          {entries.map((entry) => (
            <div key={entry.id} className="rounded bg-bg px-2 py-1.5">
              <p className="mb-1 font-medium text-text-dim">{toolLabel(entry)}</p>
              <pre className="mb-1 whitespace-pre-wrap break-words text-xs text-text-dim">
                {bound(formatArgs(entry.call.args))}
              </pre>
              {entry.outcome && (
                <pre className="whitespace-pre-wrap break-words text-xs text-text">
                  {bound(entry.outcome.result || "(no output)")}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function activityLabel(entries: ToolEntry[]): string {
  const labels = entries.map(toolLabel);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  if (labels.length === 3) return `${labels[0]}, ${labels[1]}, and ${labels[2]}`;
  return `${labels.slice(0, 3).join(", ")}, and ${labels.length - 3} more`;
}

function toolLabel(entry: ToolEntry): string {
  const args = entry.call.args;
  const tool = entry.call.tool.toLowerCase();
  const path =
    stringArg(args, "file_path") ??
    stringArg(args, "filePath") ??
    stringArg(args, "path");
  const query = stringArg(args, "query") ?? stringArg(args, "pattern");
  const command = stringArg(args, "command");
  if (tool === "read" || tool === "read_file") return path ? `Read ${path}` : "Read a file";
  if (tool.includes("search") || tool.includes("grep") || tool.includes("find")) {
    if (query) return `Searched ${query}${path ? ` in ${path}` : ""}`;
    return path ? `Searched ${path}` : "Searched";
  }
  if (tool === "shell" || tool.includes("command") || tool === "bash") {
    return command ? `Ran ${shorten(command)}` : "Ran a command";
  }
  if (tool === "edit" || tool.includes("patch") || tool.includes("write")) {
    const files = Array.isArray(args.files)
      ? args.files.filter((file): file is string => typeof file === "string")
      : [];
    return files.length > 0
      ? `Edited ${files.length} file${files.length === 1 ? "" : "s"}`
      : path
        ? `Edited ${path}`
        : "Edited files";
  }
  if (tool.includes("browser") || tool.includes("web")) {
    const url = stringArg(args, "url");
    if (url) return `Opened ${hostName(url)}`;
    return "Opened the browser";
  }
  return entry.call.tool;
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function shorten(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}…` : value;
}

function hostName(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return shorten(value);
  }
}

const DETAIL_LIMIT = 1_600;
function bound(value: string): string {
  return value.length > DETAIL_LIMIT ? `${value.slice(0, DETAIL_LIMIT)}…` : value;
}

function Collapsible({
  label,
  badge,
  tone,
  testId,
  children,
}: {
  label: string;
  badge?: string;
  tone: "dim" | "danger";
  testId?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-border bg-surface"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-dim hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {badge && (
          <span className={tone === "danger" ? "text-red-400" : "text-text-dim"}>
            {badge}
          </span>
        )}
      </button>
      {open && <div className="border-t border-border px-3 py-2">{children}</div>}
    </div>
  );
}

// Tool arguments are shown verbatim so a user can audit what an agent did.
function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "(no arguments)";
  return entries
    .map(([key, value]) =>
      `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join("\n");
}
