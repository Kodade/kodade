import { useMemo } from "react";
import { useStore } from "zustand";
import { filesStore, kodworkStore } from "../store/appStore";
import { isMarkdownFile } from "../store/files";
import { viewerKind } from "../editor/language";
import { KODWORK_TAB_LABEL, REVIEW_TAB_LABEL, tabLabels } from "../store/tab-labels";
import { FileIcon, iconCategoryFor } from "../icons/file-icons";
import { encodeTab, tabsEqual, type Tab as TabModel } from "../store/tabs";
import { remoteTargetKey } from "../ssh/model";
import { remoteTargetLabels } from "../ssh/labels";

// The editor tab strip (v1.1). A thin view over the files store: renders one
// tab per open file, marks the active one, dots dirty files, and dispatches
// open/close. All ordering/dedup/neighbor logic lives in the store. Overflowing
// tabs scroll horizontally (no dropdown) so the density stays flat.
export function TabStrip() {
  const openTabs = useStore(filesStore, (s) => s.openTabs);
  const activeTab = useStore(filesStore, (s) => s.activeTab);
  const dirtyPaths = useStore(filesStore, (s) => s.dirtyPaths);
  const editorStatus = useStore(filesStore, (s) => s.editorStatus);
  const tabModes = useStore(filesStore, (s) => s.tabModes);
  // KödWork tab labels come from the task's distilled title (never the outcome
  // text itself), falling back to the fixed label until the task loads.
  const kodworkTasks = useStore(kodworkStore, (s) => s.tasks);

  // Disambiguating labels: two files with the same basename get a parent suffix.
  const filePaths = useMemo(
    () => openTabs.filter((tab) => tab.kind === "file").map((tab) => tab.path),
    [openTabs],
  );
  const labels = useMemo(() => tabLabels(filePaths), [filePaths]);
  const remoteLabels = useMemo(
    () =>
      remoteTargetLabels(
        openTabs
          .filter((tab) => tab.kind === "remote-files")
          .map((tab) => ({ host: tab.host, path: tab.path })),
      ),
    [openTabs],
  );

  const activePath = activeTab?.kind === "file" ? activeTab.path : null;
  const isMarkdown = activePath !== null && isMarkdownFile(activePath);
  const mode = activePath ? (tabModes[activePath] ?? "view") : "view";
  const nextMode = mode === "view" ? "edit" : "view";

  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border bg-surface">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist">
        {openTabs.map((tab) => {
          const isActive = tabsEqual(tab, activeTab);
          const path = tab.kind === "file" ? tab.path : null;
          // Dirty when stashed-dirty, or the active file with unsaved edits.
          const isDirty =
            tab.kind === "file" &&
            !viewerKind(tab.path) &&
            (!!dirtyPaths[tab.path] ||
              (isActive && (editorStatus === "dirty" || editorStatus === "conflict")));
          return (
            <Tab
              key={encodeTab(tab)}
              tab={tab}
              label={
                path
                  ? (labels[path] ?? path)
                  : tab.kind === "browser"
                    ? browserLabel(tab.url)
                    : tab.kind === "review"
                          ? REVIEW_TAB_LABEL
                          : tab.kind === "remote-files"
                            ? `${
                                remoteLabels.get(remoteTargetKey(tab))
                                  ?.primary ?? tab.path
                              } (${tab.host})`
                            : tab.kind === "remote-preview"
                              ? remoteFileLabel(tab.path)
                              : tab.kind === "kodwork"
                                ? (kodworkTasks[tab.taskId]?.title ??
                                  KODWORK_TAB_LABEL)
                            : "github"
              }
              active={isActive}
              dirty={isDirty}
            />
          );
        })}
      </div>
      {isMarkdown && (
        <button
          type="button"
          title={nextMode}
          aria-label={nextMode}
          onClick={() => filesStore.getState().toggleActiveTabMode()}
          className="flex w-10 shrink-0 items-center justify-center border-l border-border text-text-dim hover:bg-surface-hover hover:text-text"
        >
          {mode === "view" ? <PencilIcon /> : <EyeIcon />}
        </button>
      )}
    </div>
  );
}

// A checklist glyph: KödWork's plan-driven progress surface.
export function KodworkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4">
      <path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

// A split-diff glyph: two stacked change bars, matching KödPR's read surface.
export function ReviewIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4">
      <path d="M4 6h9M4 12h5M4 18h9" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M17 4v7M20.5 7.5h-7" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

// Bare filename for a remote preview tab label — POSIX split, not the local
// platform's native-path splitter (a remote path always uses '/').
function remoteFileLabel(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function EyeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4">
      <path strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" strokeWidth="1.8" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4">
      <path strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5 4 16.5Z" />
      <path strokeWidth="1.8" strokeLinecap="round" d="m14.5 6 3.5 3.5" />
    </svg>
  );
}

function Tab({
  tab,
  label,
  active,
  dirty,
}: {
  tab: TabModel;
  label: string;
  active: boolean;
  dirty: boolean;
}) {
  const close = (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    filesStore.getState().closeTab(tab);
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      title={
        tab.kind === "file"
          ? tab.path
          : tab.kind === "browser"
            ? tab.url || "browser"
            : tab.kind === "review"
                  ? "review working-tree changes"
                  : tab.kind === "remote-files"
                    ? `${tab.host}:${tab.path}`
                    : tab.kind === "remote-preview"
                      ? `${tab.host}:${tab.path} (read-only)`
                      : tab.kind === "kodwork"
                        ? "KödWork task"
                    : "github issues and pull requests"
      }
      onClick={() => filesStore.getState().activateTab(tab)}
      // Middle-click closes the tab (matches editors/browsers).
      onAuxClick={(e) => {
        if (e.button === 1) close(e);
      }}
      // Same flush, full-height box as before — only the fill is softened. The
      // top corners round so the active tab reads as a card lifting off the
      // strip instead of a hard rectangle; the bottom stays square where it
      // meets the editor.
      className={`group flex h-full cursor-pointer items-center gap-1.5 rounded-t-md border-r border-border px-3 text-xs whitespace-nowrap ${
        active
          ? "bg-bg text-text"
          : "text-text-dim hover:bg-surface-hover/50 hover:text-text"
      }`}
    >
      {/* Dirty dot (the app's unsaved-changes language) shown before the name. */}
      {dirty && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          aria-label="unsaved changes"
        />
      )}
      {tab.kind === "github" && <GithubIcon />}
      {tab.kind === "browser" && <BrowserIcon />}
      {tab.kind === "review" && <ReviewIcon />}
      {tab.kind === "kodwork" && <KodworkIcon />}
      {(tab.kind === "remote-files" || tab.kind === "remote-preview") && <RemoteFileIcon />}
      {tab.kind === "file" && (
        <FileIcon
          category={iconCategoryFor(tab.path)}
          className="h-3.5 w-3.5 shrink-0"
        />
      )}
      <span className="truncate">{label}</span>
      {/* Close affordance: an x that appears on hover (or always for the active
          tab so it's always closable without hunting). While invisible it's also
          pointer-events-none so a click on the hidden × activates the tab instead
          of closing it (it re-enables on hover / when active). */}
      <button
        type="button"
        aria-label={`close ${label}`}
        onClick={close}
        className={`ml-1 shrink-0 rounded-full px-1 leading-none text-text-dim hover:bg-surface-hover hover:text-text ${
          active
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
        }`}
      >
        ×
      </button>
    </div>
  );
}

function browserLabel(url: string): string {
  if (!url) return "browser";
  try {
    return new URL(url).hostname || "browser";
  } catch {
    return "browser";
  }
}

export function BrowserIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4">
      <circle cx="12" cy="12" r="9" strokeWidth="1.7" />
      <path d="M3.5 12h17M12 3c2.3 2.5 3.5 5.5 3.5 9S14.3 18.5 12 21c-2.3-2.5-3.5-5.5-3.5-9S9.7 5.5 12 3Z" strokeWidth="1.7" />
    </svg>
  );
}

// A dashed-outline document — the "remote, read-only" visual language shared
// by both the file-tree tab and the individual preview tab.
export function RemoteFileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4">
      <path
        d="M6.5 3.5h7l4 4v13h-11v-17Z"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeDasharray="2.6 2.2"
      />
      <path d="M13.5 3.5v4h4" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function GithubIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-4 w-4"
    >
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.77c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}
