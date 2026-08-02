import { useEffect } from "react";
import { useStore } from "zustand";
import type { GithubItem } from "../github/parse";
import { externalUrls as tauriExternalUrls } from "../ipc/transport";
import { githubCliInstallGuidance } from "../platform/guidance";
import { appStore, githubStore } from "../store/appStore";

export function GithubPane() {
  const state = useStore(githubStore);
  const activeProject = useStore(appStore, (s) =>
    s.projects.find((project) => project.id === s.activeProjectId),
  );

  useEffect(() => {
    if (activeProject) void githubStore.getState().refresh(activeProject.path);
  }, [activeProject?.id, activeProject?.path]);

  if (!activeProject) return <Card>select a project to view github</Card>;
  if (state.auth === "idle" || state.auth === "checking") {
    return <CenteredText>checking gh…</CenteredText>;
  }
  const refresh = () => void githubStore.getState().refresh(activeProject.path);
  if (state.auth === "missing") return <MissingGhCard refresh={refresh} />;
  if (state.auth === "unauthenticated") return <UnauthenticatedCard refresh={refresh} />;
  if (state.repository === "unknown") return <CenteredText>checking remote…</CenteredText>;
  if (state.repository === "none") return <Card>no github remote</Card>;
  if (state.repository === "error") {
    return (
      <Card>
        <p className="text-sm text-text">could not load github repository</p>
        <p className="mt-1 text-xs text-text-dim">{state.repositoryError}</p>
        <RefreshButton refresh={refresh} />
      </Card>
    );
  }

  return (
    <div className="absolute inset-0 overflow-auto bg-bg p-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div className="flex items-center justify-between">
          <p className="text-xs text-text-dim">issues and pull requests</p>
          <button
            type="button"
            onClick={refresh}
            disabled={state.issuesLoading || state.pullRequestsLoading}
            className="rounded border border-border bg-surface px-2.5 py-1.5 text-xs text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
          >
            refresh
          </button>
        </div>
        <GithubSection
          title="open issues"
          kind="issue"
          items={state.issues}
          loading={state.issuesLoading}
          error={state.issuesError}
          repositoryUrl={state.repositoryUrl!}
        />
        <GithubSection
          title="open pull requests"
          kind="pull"
          items={state.pullRequests}
          loading={state.pullRequestsLoading}
          error={state.pullRequestsError}
          repositoryUrl={state.repositoryUrl!}
        />
      </div>
    </div>
  );
}

function GithubSection({
  title,
  kind,
  items,
  loading,
  error,
  repositoryUrl,
}: {
  title: string;
  kind: "issue" | "pull";
  items: GithubItem[];
  loading: boolean;
  error: string | null;
  repositoryUrl: string;
}) {
  return (
    <section className="overflow-hidden rounded border border-border bg-surface">
      <header className="border-b border-border px-3 py-2 text-[11px] font-semibold tracking-[0.12em] text-text-dim">
        {title}
      </header>
      {loading && <p className="px-3 py-5 text-xs text-text-dim">loading…</p>}
      {!loading && error && <p className="px-3 py-5 text-xs text-text-dim">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="px-3 py-5 text-xs text-text-dim">nothing open</p>
      )}
      {!loading &&
        !error &&
        items.map((item) => (
          <button
          type="button"
          key={item.number}
          onClick={() =>
            void tauriExternalUrls.openUrl(
              `${repositoryUrl}/${kind === "issue" ? "issues" : "pull"}/${item.number}`,
            )
          }
          className="flex w-full items-start gap-3 border-b border-border px-3 py-3 text-left last:border-b-0 hover:bg-surface-hover"
        >
          <span className="w-10 shrink-0 pt-0.5 text-xs text-text-dim">#{item.number}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-text">{item.title}</span>
            <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-dim">
              <span>{item.author}</span>
              <span>updated {relativeTime(item.updatedAt)}</span>
              {item.labels.map((label) => (
                <span key={label} className="rounded border border-border px-1.5 py-0.5 text-text-dim">
                  {label}
                </span>
              ))}
            </span>
          </span>
          </button>
        ))}
    </section>
  );
}

function MissingGhCard({ refresh }: { refresh: () => void }) {
  const { command, copyTitle } = githubCliInstallGuidance();
  return (
    <Card>
      <p className="text-sm text-text">install gh to view issues and pull requests</p>
      <button
        type="button"
        title={copyTitle}
        onClick={() => void navigator.clipboard.writeText(command)}
        className="mt-3 rounded border border-border bg-bg px-3 py-2 font-mono text-xs text-text-dim hover:bg-surface-hover hover:text-text"
      >
        {command} · copy
      </button>
      <RefreshButton refresh={refresh} />
    </Card>
  );
}

function UnauthenticatedCard({ refresh }: { refresh: () => void }) {
  return (
    <Card>
      <p className="text-sm text-text">sign in with the gh cli</p>
      <p className="mt-1 text-xs text-text-dim">
        authentication stays in gh; kodade never handles it
      </p>
      <button
        type="button"
        onClick={() => {
          void appStore
            .getState()
            .launchInSession("gh auth login", "gh")
            .catch((error) => console.error("kodade: gh auth launch failed:", error));
        }}
        className="mt-3 rounded border border-border bg-bg px-3 py-2 text-xs text-text-dim hover:bg-surface-hover hover:text-text"
      >
        open gh auth login
      </button>
      <RefreshButton refresh={refresh} />
    </Card>
  );
}

function RefreshButton({ refresh }: { refresh: () => void }) {
  return (
    <button
      type="button"
      onClick={refresh}
      className="ml-2 mt-3 rounded border border-border bg-bg px-3 py-2 text-xs text-text-dim hover:bg-surface-hover hover:text-text"
    >
      refresh
    </button>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-bg p-6">
      <div className="max-w-md rounded border border-border bg-surface p-5 text-center text-sm text-text-dim">
        {children}
      </div>
    </div>
  );
}

function CenteredText({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-sm text-text-dim">
      {children}
    </div>
  );
}

export function relativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
