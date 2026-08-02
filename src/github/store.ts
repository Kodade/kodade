import { createStore } from "zustand/vanilla";
import type { GithubIpc } from "../ipc/contract";
import {
  errorMessage,
  isNoGithubRemoteError,
  parseAuthStatus,
  parseGithubList,
  parseGithubRepoUrl,
  type AuthStatus,
  type GithubItem,
} from "./parse";

const LIST_FIELDS = "number,title,author,labels,updatedAt";

export type GithubState = {
  projectRoot: string | null;
  auth: "idle" | "checking" | AuthStatus;
  repository: "unknown" | "github" | "none" | "error";
  repositoryUrl: string | null;
  repositoryError: string | null;
  issues: GithubItem[];
  pullRequests: GithubItem[];
  issuesLoading: boolean;
  pullRequestsLoading: boolean;
  issuesError: string | null;
  pullRequestsError: string | null;
  refresh(projectRoot: string): Promise<void>;
};

export function createGithubStore(ipc: GithubIpc) {
  let generation = 0;
  return createStore<GithubState>((set) => ({
    projectRoot: null,
    auth: "idle",
    repository: "unknown",
    repositoryUrl: null,
    repositoryError: null,
    issues: [],
    pullRequests: [],
    issuesLoading: false,
    pullRequestsLoading: false,
    issuesError: null,
    pullRequestsError: null,

    async refresh(projectRoot: string) {
      const gen = ++generation;
      set({
        projectRoot,
        auth: "checking",
        repository: "unknown",
        repositoryUrl: null,
        repositoryError: null,
        issues: [],
        pullRequests: [],
        issuesLoading: false,
        pullRequestsLoading: false,
        issuesError: null,
        pullRequestsError: null,
      });

      try {
        await ipc.run(projectRoot, ["auth", "status"]);
      } catch (error) {
        if (gen !== generation) return;
        set({ auth: parseAuthStatus({ ok: false, error }) });
        return;
      }
      if (gen !== generation) return;
      set({ auth: "ok" });

      let repositoryUrl: string;
      try {
        const result = await ipc.run(projectRoot, ["repo", "view", "--json", "url"]);
        repositoryUrl = parseGithubRepoUrl(result.stdout);
      } catch (error) {
        if (gen !== generation) return;
        if (isNoGithubRemoteError(error)) set({ repository: "none" });
        else set({ repository: "error", repositoryError: errorMessage(error) });
        return;
      }
      if (gen !== generation) return;

      set({
        repository: "github",
        repositoryUrl,
        issuesLoading: true,
        pullRequestsLoading: true,
      });

      const load = async (kind: "issue" | "pr") => {
        try {
          const result = await ipc.run(projectRoot, [
            kind,
            "list",
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            LIST_FIELDS,
          ]);
          const items = parseGithubList(result.stdout);
          if (gen !== generation) return;
          if (kind === "issue") set({ issues: items, issuesLoading: false });
          else set({ pullRequests: items, pullRequestsLoading: false });
        } catch (error) {
          if (gen !== generation) return;
          const message = errorMessage(error);
          if (kind === "issue") set({ issuesError: message, issuesLoading: false });
          else set({ pullRequestsError: message, pullRequestsLoading: false });
        }
      };
      await Promise.all([load("issue"), load("pr")]);
    },
  }));
}
