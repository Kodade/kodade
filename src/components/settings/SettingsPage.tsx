// The full-page settings view: section nav on the left, cards on the right,
// "Restore defaults" for the active section top-right, and Back / Esc to
// return to the workspace. Opening it never touches persisted pane layout.

import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { settingsViewStore } from "../../store/settingsView";
import {
  availableSettingsSections,
  settingsSection,
  type SettingsSection,
  type SettingsSectionId,
} from "./registry";

export function SettingsPage({
  className = "",
}: {
  className?: string;
} = {}) {
  const activeId = useStore(settingsViewStore, (state) => state.section);
  const pageRef = useRef<HTMLDivElement>(null);
  const close = () => settingsViewStore.getState().close();

  // Esc returns to the workspace. Bubble phase on window: the shortcut
  // dispatcher owns capture phase but claims no Escape binding, and the voice
  // shortcut recorder stops Escape there while it is capturing.
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      settingsViewStore.getState().close();
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  // Move focus into the page so keyboard users land here, not behind it.
  useEffect(() => {
    pageRef.current?.focus();
  }, []);

  const sections = availableSettingsSections();
  const section = activeId ? settingsSection(activeId) : null;

  // A persisted or programmatic deep link can name a section that is not
  // available in this build. Keep the fallback and transient state aligned.
  useEffect(() => {
    if (activeId && section && activeId !== section.id) {
      settingsViewStore.getState().open(section.id as SettingsSectionId);
    }
  }, [activeId, section]);

  if (!activeId || !section) return null;

  return (
    <div
      ref={pageRef}
      role="region"
      aria-label="Settings"
      tabIndex={-1}
      className={`flex min-h-0 bg-bg text-text focus:outline-none ${className}`}
    >
      <nav
        aria-label="Settings sections"
        className="flex w-52 shrink-0 flex-col border-r border-border bg-bg px-2 py-3"
      >
        <h1 className="px-2 pb-2 text-xs font-semibold tracking-[0.12em] text-text">
          settings
        </h1>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {sections.map((entry) => (
            <li key={entry.id}>
              <SectionLink section={entry} active={entry.id === section.id} />
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={close}
          title="Back to the workspace — Esc"
          className="mt-2 flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-dim hover:bg-surface hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <span aria-hidden="true">←</span>
          <span>Back</span>
        </button>
      </nav>

      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        <header className="flex items-start justify-between gap-6 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text">{section.label}</h2>
            <p className="mt-0.5 text-[11px] text-text-dim">
              {section.description}
            </p>
          </div>
          <RestoreDefaults section={section} />
        </header>
        <div
          className={
            section.layout === "full"
              ? "min-h-0 flex-1 overflow-hidden"
              : "min-h-0 flex-1 overflow-y-auto px-6 py-5"
          }
        >
          <section.Content />
        </div>
      </div>
    </div>
  );
}

function SectionLink({
  section,
  active,
}: {
  section: SettingsSection;
  active: boolean;
}) {
  const Icon = section.icon;
  return (
    <button
      type="button"
      onClick={() =>
        settingsViewStore.getState().open(section.id as SettingsSectionId)
      }
      aria-current={active ? "page" : undefined}
      data-settings-nav-link={section.id}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs focus:outline-none focus:ring-1 focus:ring-accent ${
        active
          ? "bg-surface text-text"
          : "text-text-dim hover:bg-surface hover:text-text"
      }`}
    >
      <Icon />
      <span className="truncate">{section.label}</span>
    </button>
  );
}

// Two-step reset for the ACTIVE section only. Sections with nothing meaningful
// to reset (ködmem, and advanced in a public build) declare no restoreDefaults
// and get no button at all.
function RestoreDefaults({ section }: { section: SettingsSection }) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => setConfirming(false), [section.id]);

  const restore = section.restoreDefaults;
  if (!restore) return null;

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="shrink-0 rounded border border-border px-2 py-1 text-xs text-text-dim hover:bg-surface hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
      >
        Restore defaults
      </button>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2 text-[11px] text-text-dim">
      <span>
        {section.restorePrompt ?? `Reset ${section.label} to defaults?`}
      </span>
      <button
        type="button"
        onClick={() => {
          restore();
          setConfirming(false);
        }}
        className="rounded border border-accent px-2 py-1 text-accent hover:bg-surface focus:outline-none focus:ring-1 focus:ring-accent"
      >
        Reset
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded px-2 py-1 hover:bg-surface hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
      >
        Cancel
      </button>
    </div>
  );
}
