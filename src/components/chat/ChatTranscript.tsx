// The transcript half of KödChat: user bubbles, streaming assistant markdown,
// collapsible thinking and tool cards, and the two failure cards.
//
// All styling is tokens-only so it re-skins with every app theme.

import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "../../markdown/render";
import type { ChatEntry, ChatThread } from "../../chat/model";
import type { ToolOutcome } from "../../local/tools";

export function ChatTranscript({
  thread,
  onOpenLoginTerminal,
}: {
  thread: ChatThread;
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
      {thread.entries.map((entry) => (
        <TranscriptEntry
          key={entry.id}
          entry={entry}
          onOpenLoginTerminal={onOpenLoginTerminal}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function TranscriptEntry({
  entry,
  onOpenLoginTerminal,
}: {
  entry: ChatEntry;
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
        // Sanitized by renderMarkdown (markdown-it with html:false, then
        // DOMPurify) — the same boundary the editor preview uses.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }}
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

  if (entry.kind === "tool") {
    const running = entry.outcome === null;
    return (
      <Collapsible
        label={entry.call.tool}
        badge={running ? "running" : outcomeBadge(entry.outcome!)}
        tone={entry.outcome?.status === "error" ? "danger" : "dim"}
        testId="chat-tool-card"
      >
        <pre className="mb-2 whitespace-pre-wrap break-words text-xs text-text-dim">
          {formatArgs(entry.call.args)}
        </pre>
        {entry.outcome && (
          <pre className="whitespace-pre-wrap break-words text-xs text-text">
            {entry.outcome.result || "(no output)"}
          </pre>
        )}
      </Collapsible>
    );
  }

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

function outcomeBadge(outcome: ToolOutcome): string {
  switch (outcome.status) {
    case "error":
      return "failed";
    case "denied":
      return "denied";
    case "suggested":
      return "suggested";
    default:
      return "done";
  }
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
