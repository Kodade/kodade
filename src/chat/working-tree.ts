// KödChat's passive working-tree summary is intentionally separate from
// KödPR's interactive review store. Refreshing this small projection must not
// change the review pane's selected branch/PR scope or carry another project's
// totals into the active chat.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { GitIpc } from "../ipc/contract";
import { parseNumstat } from "../review/parse";

export type WorkingTreeSummary = {
  files: number;
  adds: number;
  dels: number;
};

export type WorkingTreeSummaryState = {
  projectRoot: string | null;
  summary: WorkingTreeSummary | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load(projectRoot: string): Promise<void>;
  reset(): void;
};

const EMPTY_STATE = {
  projectRoot: null,
  summary: null,
  loading: false,
  loaded: false,
  error: null,
} satisfies Pick<
  WorkingTreeSummaryState,
  "projectRoot" | "summary" | "loading" | "loaded" | "error"
>;

export function createWorkingTreeSummaryStore(
  git: GitIpc,
): StoreApi<WorkingTreeSummaryState> {
  let generation = 0;

  return createStore<WorkingTreeSummaryState>((set) => ({
    ...EMPTY_STATE,

    async load(projectRoot) {
      const currentGeneration = ++generation;
      // Clear first, even for a same-root refresh: a failed current read must
      // never leave an older positive summary visible in chat.
      set({
        projectRoot,
        summary: null,
        loading: true,
        loaded: false,
        error: null,
      });

      try {
        const output = await git.run(projectRoot, ["diff", "--numstat", "-z"]);
        if (currentGeneration !== generation) return;
        const parsed = parseNumstat(output.stdout);
        const summary = parsed.items.reduce<WorkingTreeSummary>(
          (totals, file) => ({
            files: totals.files + 1,
            adds: totals.adds + (file.adds ?? 0),
            dels: totals.dels + (file.dels ?? 0),
          }),
          { files: 0, adds: 0, dels: 0 },
        );
        set({ summary, loading: false, loaded: true, error: null });
      } catch (error) {
        if (currentGeneration !== generation) return;
        set({
          summary: null,
          loading: false,
          loaded: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    reset() {
      generation++;
      set(EMPTY_STATE);
    },
  }));
}
