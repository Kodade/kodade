// KödSSH remote file tree pane (M11d, Pro): a read-only browser for one
// pinned remote target's tree, rendered in the far-right files pane just like
// the local FileTreePane. The whole tree comes back in one capped `find` probe
// (src/store/remoteFiles.ts), so expand/collapse here is purely local UI state
// over already-fetched data — no per-directory round trips like the local tree.

import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { remoteFilesStore as defaultRemoteFilesStore, filesStore as defaultFilesStore } from "../store/appStore";
import type { RemoteFilesState } from "../store/remoteFiles";
import type { RemoteTreeNode } from "../ssh/remoteTree";
import type { RemoteTarget } from "../ssh/model";
import { entitlements as defaultEntitlements, type Entitlements } from "../app/entitlements";
import type { StoreApi } from "zustand/vanilla";
import { FileIcon, iconCategoryFor } from "../icons/file-icons";

export function RemoteFilesPane({
  host,
  path,
  store = defaultRemoteFilesStore,
  entitlements = defaultEntitlements,
  openPreview = (h: string, p: string) => defaultFilesStore.getState().openRemotePreviewTab(h, p),
}: {
  host: string;
  path: string;
  store?: StoreApi<RemoteFilesState>;
  entitlements?: Entitlements;
  openPreview?: (host: string, path: string) => void;
}) {
  const state = useStore(store);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const target: RemoteTarget = { host, path };
  const key = `${host}\0${path}`;
  const listing = state.listings[key];

  // Defense in depth: a persisted tab could outlive a downgraded entitlement
  // (tabs aren't re-validated against Pro status on load). Gate rendering,
  // not just the affordance that opens the tab.
  const entitled = entitlements.hasFeature("ssh.pro");

  useEffect(() => {
    if (!entitled) return;
    if (!listing) void store.getState().listTarget(target);
    // Re-list whenever the target changes; a re-render with the same
    // host/path and an existing listing is a no-op (ready/pending/failed all
    // stay put until the user hits refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitled, host, path]);

  if (!entitled) {
    return <Placeholder text="Remote file browsing is a kodade Pro feature." />;
  }

  return (
    <section className="flex h-full min-w-0 flex-col bg-surface">
      <header className="flex h-[38px] shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="shrink-0 text-[11px] font-semibold tracking-[0.16em] text-text-dim">
          files
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-text-dim"
          title={`${host}:${path}`}
        >
          <span className="text-text">{host}</span>:{path}
        </span>
        <button
          type="button"
          title="refresh"
          aria-label="refresh remote listing"
          onClick={() => void store.getState().listTarget(target)}
          disabled={listing?.status === "pending"}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-40"
        >
          ↻
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {!listing || listing.status === "pending" ? (
          <Placeholder text={`Listing files on ${host}…`} />
        ) : listing.status === "unsupported" ? (
          <Placeholder
            text={`${host} doesn't look like a POSIX host kodade can browse (find/sh not found).`}
          />
        ) : listing.status === "failed" ? (
          <Placeholder text={`Could not list files on ${host}: ${listing.reason}`} />
        ) : (
          <>
            {listing.listing.truncated && (
              <p role="status" className="border-b border-border bg-bg px-3 py-1 text-[11px] text-[var(--kd-warning)]">
                listing truncated at the entry cap — some files may be hidden
              </p>
            )}
            {listing.listing.nodes.length === 0 ? (
              <Placeholder text="empty directory" />
            ) : (
              <ul className="py-2 text-[13px] text-text-dim">
                {listing.listing.nodes.map((node) => (
                  <TreeRow
                    key={node.path}
                    node={node}
                    depth={0}
                    expanded={expanded}
                    onToggle={(p) =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(p)) next.delete(p);
                        else next.add(p);
                        return next;
                      })
                    }
                    onOpenFile={(p) => openPreview(host, p)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  onOpenFile,
}: {
  node: RemoteTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isOpen = node.type === "dir" && expanded.has(node.path);
  return (
    <li>
      <button
        type="button"
        onClick={() => (node.type === "dir" ? onToggle(node.path) : onOpenFile(node.path))}
        title={node.path}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        className="flex h-6 w-full min-w-0 items-center gap-1.5 pr-2 text-left hover:bg-surface-hover hover:text-text"
      >
        <span className="w-3 shrink-0 text-center text-[10px]">
          {node.type === "dir" && (
            <svg
              viewBox="0 0 12 12"
              className={`h-2.5 w-2.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M4 2.5 8 6 4 9.5Z" />
            </svg>
          )}
        </span>
        <span className="flex w-3.5 shrink-0 items-center justify-center">
          <FileIcon
            category={
              node.type === "dir"
                ? isOpen
                  ? "folder-open"
                  : "folder-closed"
                : iconCategoryFor(node.path)
            }
            className="h-3.5 w-3.5"
          />
        </span>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
      {node.type === "dir" && isOpen && node.children && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center">
      <p className="text-sm text-text-dim">{text}</p>
    </div>
  );
}
