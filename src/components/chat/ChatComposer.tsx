// The composer: prompt box, attachments, and the per-thread run controls —
// provider, model, and access level — styled like a chat app, not a CLI
// (t3-style): one rounded input surface, chip menus with brand logos, and a
// round send button.
//
// Enter sends, Shift+Enter starts a new line — the convention every chat
// surface uses, and the one thing users try first.

import { useState, type KeyboardEvent } from "react";
import type { ChatAccessLevel, Provider } from "../../providers/catalog";
import { ACCESS_LEVELS, supportsChat } from "../../providers/catalog";
import { ComposerMenu } from "./ComposerMenu";
import { ProviderLogo } from "./ProviderLogo";

export function ChatComposer({
  providers,
  providerId,
  model,
  access,
  attachments,
  working,
  disabled,
  onProviderChange,
  onModelChange,
  onAccessChange,
  onRemoveAttachment,
  onSend,
  onCancel,
}: {
  providers: Provider[];
  providerId: string;
  model: string | null;
  access: ChatAccessLevel;
  attachments: string[];
  working: boolean;
  disabled?: boolean;
  onProviderChange(providerId: string): void;
  onModelChange(model: string | null): void;
  onAccessChange(access: ChatAccessLevel): void;
  onRemoveAttachment(path: string): void;
  onSend(text: string): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState("");
  const selected = providers.find((provider) => provider.id === providerId);
  const chatCapable = selected ? supportsChat(selected) : false;
  const models = selected?.stream?.models ?? [];
  const canSend =
    !working &&
    !disabled &&
    chatCapable &&
    (draft.trim().length > 0 || attachments.length > 0);

  const send = () => {
    if (!canSend) return;
    onSend(draft);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  };

  const accessLevel = ACCESS_LEVELS.find((level) => level.id === access);
  // "" is the menu id for "let the CLI pick" — a null model on the thread.
  const modelLabel =
    models.find((entry) => entry.id === model)?.label ?? "Default model";

  return (
    <div className="shrink-0 border-t border-border bg-bg px-3 py-3">
      {selected && !chatCapable && (
        <p className="mb-2 text-[11px] text-text-dim">
          {selected.name} is not yet supported in KödChat. Open a terminal to
          use it.
        </p>
      )}
      <div className="rounded-xl border border-border bg-surface focus-within:border-accent/70">
        {attachments.length > 0 && (
          <ul
            className="flex flex-wrap gap-1.5 px-3 pt-2.5"
            aria-label="Attached files"
          >
            {attachments.map((path) => (
              <li
                key={path}
                className="flex max-w-full items-center gap-1 rounded-md border border-border bg-bg px-1.5 py-0.5 text-[11px] text-text-dim"
                title={path}
              >
                <span className="max-w-[240px] truncate">{fileName(path)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${fileName(path)}`}
                  onClick={() => onRemoveAttachment(path)}
                  className="text-text-dim hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={3}
          aria-label="Message"
          placeholder="Ask the agent to do something… (drop files to attach)"
          className="w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm text-text placeholder:text-text-dim focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <ComposerMenu
            label="Provider"
            value={providerId}
            onSelect={onProviderChange}
            options={providers.map((provider) => ({
              id: provider.id,
              label: provider.name,
              icon: <ProviderLogo providerId={provider.id} size={20} />,
              disabled: !supportsChat(provider),
              disabledHint: `${provider.name} is terminal-only for now`,
              description: supportsChat(provider) ? undefined : "terminal only",
            }))}
          >
            <ProviderLogo providerId={providerId} size={18} />
            <span className="max-w-[130px] truncate">
              {selected?.name ?? providerId}
            </span>
          </ComposerMenu>
          {chatCapable && models.length > 0 && (
            <ComposerMenu
              label="Model"
              value={model ?? ""}
              onSelect={(id) => onModelChange(id || null)}
              options={[
                { id: "", label: "Default model" },
                ...models.map((entry) => ({ id: entry.id, label: entry.label })),
              ]}
              menuWidthClass="min-w-[190px]"
            >
              <span className="max-w-[150px] truncate">{modelLabel}</span>
            </ComposerMenu>
          )}
          {chatCapable && (
            <ComposerMenu
              label="Access level"
              value={access}
              onSelect={(id) => onAccessChange(id as ChatAccessLevel)}
              options={ACCESS_LEVELS.map((level) => ({
                id: level.id,
                label: level.label,
                description: level.description,
              }))}
              menuWidthClass="min-w-[260px]"
            >
              <AccessGlyph access={access} />
              <span>{accessLevel?.label}</span>
            </ComposerMenu>
          )}
          {working && (
            <span
              data-testid="chat-working"
              className="flex items-center gap-1.5 pl-1 text-[11px] text-text-dim"
            >
              <span
                aria-hidden="true"
                className="kd-dot-pulse h-1.5 w-1.5 rounded-full bg-accent"
              />
              Working…
            </span>
          )}
          <div className="flex-1" />
          {working ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop"
              title="Stop this turn"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-bg text-text hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              aria-label="Send"
              title="Send (Enter)"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-accent-text hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// The access chip's glyph mirrors the posture: closed lock (plan only), a
// shield (standard), open lock (full access).
function AccessGlyph({ access }: { access: ChatAccessLevel }) {
  const common = {
    viewBox: "0 0 16 16",
    className: "h-3.5 w-3.5 text-text-dim",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    "aria-hidden": true,
  } as const;
  if (access === "plan") {
    return (
      <svg {...common}>
        <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      </svg>
    );
  }
  if (access === "full") {
    return (
      <svg {...common}>
        <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5-.7" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M8 2.5 13 4.5v3.6c0 2.9-2 5-5 5.9-3-.9-5-3-5-5.9V4.5Z" />
    </svg>
  );
}

// The chip shows just the basename; the full path stays in the title tooltip.
function fileName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}
