// Main-screen agent quick-launch: the same one-click "start a CLI in a new
// terminal" that lives in Settings → providers, surfaced next to the
// workspace search so starting an agent never requires the settings detour.

import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { appStore, providersStore } from "../store/appStore";

export function AgentLaunchMenu() {
  const [open, setOpen] = useState(false);
  const providers = useStore(providersStore, (s) => s.providers);
  const statuses = useStore(providersStore, (s) => s.statuses);
  const launchingProviderId = useStore(providersStore, (s) => s.launchingProviderId);
  const hasProject = useStore(appStore, (s) => s.activeProjectId !== null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Click-away dismisses; Escape returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", dismiss);
    return () => window.removeEventListener("mousedown", dismiss);
  }, [open]);

  const installed = providers.filter(
    (provider) => statuses[provider.id]?.status === "installed",
  );

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Start an agent in a new terminal"
        title={hasProject ? "Start an agent in a new terminal" : "Open a project first"}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!hasProject}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg
          viewBox="0 0 16 16"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="2" y="2.5" width="12" height="11" rx="1" />
          <path d="m5 6.5 2 2-2 2M8.5 10.5H11" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Start an agent"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          }}
          className="absolute right-0 top-9 z-50 w-44 rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          {installed.length === 0 && (
            <p className="px-2 py-1.5 text-[11px] text-text-dim">
              No agent CLIs detected yet.
            </p>
          )}
          {installed.map((provider) => {
            const launching = launchingProviderId === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                role="menuitem"
                disabled={launchingProviderId !== null}
                onClick={() => {
                  setOpen(false);
                  void providersStore.getState().launch(provider.id);
                }}
                title={`Start ${provider.name} in a new terminal`}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                {launching && (
                  <span className="text-[10px] text-accent">starting…</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
