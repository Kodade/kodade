import type { StoreApi } from "zustand/vanilla";
import { appStore } from "../store/appStore";
import type { ProjectsState } from "../store/projects";
import { labelFor } from "../shortcuts/bindings";

// Collapse/expand control for the right files pane (issue #8), mirroring the
// projects SidebarToggle. The chevron points the way the pane's edge moves:
// right to collapse toward the window edge, left to expand back out.
export function FilesPaneToggle({
  collapsed,
  store = appStore,
}: {
  collapsed: boolean;
  store?: StoreApi<ProjectsState>;
}) {
  const action = collapsed ? "Expand files sidebar" : "Collapse files sidebar";

  return (
    <button
      onClick={() => store.getState().toggleFilesPanel()}
      title={`${action} — ${labelFor("toggle-files")}`}
      aria-label={action}
      aria-pressed={collapsed}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
    >
      <svg
        viewBox="0 0 16 16"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M2.5 3.5h11v9h-11zM10 3.5v9" />
        <path d={collapsed ? "m7.5 6-2 2 2 2" : "m5.5 6 2 2-2 2"} />
      </svg>
    </button>
  );
}
