// The v2 shell's dedicated KödWork task surface (#95, #97).
//
// A running or finished task is its own top-level destination — like Claude
// Cowork or ChatGPT's task views — completely independent of whatever project
// is active or whatever KödChat workspace is open on the Code tab. Selecting a
// task (from the sidebar, from a native KödWork notification, or from an
// Agents-tab launch) only ever writes `agentsStore.selectedRunTaskId` and
// `shellLayout.activeTab`; it never touches the active project or a
// files-store tab, so switching away and back never bleeds state either way.
//
// Reuses `agentsStore.selectedRunTaskId` rather than a new store: the Agents
// tab already tracked "which run is being looked at" for its own (now
// removed) embedded run pane, and that selection is exactly what this tab
// needs to mirror.

import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { agentsStore as defaultAgentsStore, kodworkStore } from "../../store/appStore";
import type { AgentsState } from "../../agents/agents-store";
import type { KodworkState } from "../../kodwork/store";
import { KodworkPane } from "../kodwork/KodworkPane";
import { Pane } from "../Pane";

export function TaskTab({
  store = defaultAgentsStore,
  workStore = kodworkStore,
}: {
  store?: StoreApi<AgentsState>;
  workStore?: StoreApi<KodworkState>;
} = {}) {
  const selectedRunTaskId = useStore(store, (s) => s.selectedRunTaskId);

  return (
    <Pane title="task">
      <div className="relative h-full min-h-0 min-w-0">
        {selectedRunTaskId ? (
          <KodworkPane taskId={selectedRunTaskId} workStore={workStore} />
        ) : (
          <EmptyState />
        )}
      </div>
    </Pane>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-xs text-text-dim">
      <p className="max-w-xs leading-relaxed">
        Pick a KödWork task from the sidebar, or prepare a run from the Agents
        tab, to see its progress here.
      </p>
    </div>
  );
}
