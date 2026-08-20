// The Ködade background prompt (issue #63), inside the KödHarness block.
//
// Progressive disclosure: a one-line summary the user can ignore, with the
// actual text behind a disclosure. The prompt is invisible at runtime, so this
// is the one place it can be read, rewritten, or switched off.

import { useEffect, useState } from "react";
import { useStore } from "zustand";
import {
  MAX_AMBIENT_PROMPT_LENGTH,
  ambientPrompt,
} from "../../harness/ambient";
import { appStore } from "../../store/appStore";

export function AmbientPromptSettings() {
  const enabled = useStore(appStore, (state) => state.ambientPromptEnabled);
  const override = useStore(appStore, (state) => state.ambientPromptOverride);
  const [open, setOpen] = useState(false);
  // Local draft so typing stays responsive and a half-written prompt is never
  // persisted mid-keystroke; committed on blur.
  const [draft, setDraft] = useState(() => ambientPrompt(override));

  // Follow the store when the value changes elsewhere (reset, hydration).
  useEffect(() => {
    setDraft(ambientPrompt(override));
  }, [override]);

  const commit = (value: string) => {
    const trimmed = value.trim();
    appStore
      .getState()
      .setAmbientPromptOverride(
        trimmed.length === 0 || trimmed === ambientPrompt(null) ? null : trimmed,
      );
  };

  return (
    <section className="rounded-md border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 items-start gap-2 text-left focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span aria-hidden="true" className="mt-0.5 text-[10px] text-text-dim">
            {open ? "▾" : "▸"}
          </span>
          <span className="min-w-0">
            <span className="block text-xs text-text">Background prompt</span>
            <span className="mt-0.5 block text-[11px] text-text-dim">
              Sent invisibly to every agent Ködade starts in chat and KödWork.
            </span>
          </span>
        </button>
        <label className="flex shrink-0 items-center gap-2 text-[11px] text-text-dim">
          <input
            type="checkbox"
            aria-label="background prompt"
            checked={enabled}
            onChange={(event) =>
              appStore.getState().setAmbientPromptEnabled(event.target.checked)
            }
          />
          {enabled ? "On" : "Off"}
        </label>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <textarea
            aria-label="background prompt text"
            rows={5}
            maxLength={MAX_AMBIENT_PROMPT_LENGTH}
            disabled={!enabled}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 text-[11px] leading-relaxed text-text disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-text-dim">
              Never written to CLAUDE.md, AGENTS.md, or any file on disk.
            </p>
            <button
              type="button"
              disabled={override === null}
              onClick={() => appStore.getState().setAmbientPromptOverride(null)}
              className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-text hover:bg-surface disabled:opacity-40"
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
