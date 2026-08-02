import { useRef, type ReactNode } from "react";
import type { WorkspaceActions } from "./WorkspaceCard";

export function WorkspaceHeader({
  query,
  onQueryChange,
  actions,
  launcher,
}: {
  query: string;
  onQueryChange(query: string): void;
  actions: WorkspaceActions;
  // Optional agent quick-launch control (store-connected, injected so this
  // header stays a pure component for the sidebar seam tests).
  launcher?: ReactNode;
}) {
  const addTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className="relative mb-3 flex shrink-0 gap-1"
    >
      <label className="sr-only" htmlFor="workspace-search">Search workspaces</label>
      <input
        id="workspace-search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        type="search"
        placeholder="Search workspaces"
        aria-label="Search workspaces"
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none placeholder:text-text-dim focus:border-accent"
      />
      <button
        ref={addTriggerRef}
        type="button"
        aria-label="Add project"
        title="Add project"
        onClick={() => {
          void Promise.resolve(actions.addProject())
            .catch((error) => {
              console.error("kodade: project picker failed", error);
            })
            .finally(() => addTriggerRef.current?.focus());
        }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <span aria-hidden="true">+</span>
      </button>
      {launcher}
    </div>
  );
}
