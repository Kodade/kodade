import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { filesStore } from "../store/appStore";
import { filterMatches, type FileEdit } from "../store/files";
import type { DirEntry } from "../ipc/contract";
import { FileIcon, iconCategoryFor } from "../icons/file-icons";
import { canRevealInOs, capabilitiesStore } from "../platform/capabilities";
import { REVEAL_IN_FILE_MANAGER_LABEL } from "../platform/guidance";

// Live file tree of the active project, now a light file manager (v1.1): a
// toolbar (new file/folder, refresh, collapse-all), right-click context
// menu, inline rename/create, and trash-delete. The store owns all logic; this
// component renders and dispatches. Directories expand lazily.
export function FileTreePane() {
  const rootPath = useStore(filesStore, (s) => s.rootPath);
  const filter = useStore(filesStore, (s) => s.filter);
  const opError = useStore(filesStore, (s) => s.opError);
  const edit = useStore(filesStore, (s) => s.edit);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Dismiss the context menu on any outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    const onClick = () => setMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    window.addEventListener("contextmenu", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
      window.removeEventListener("contextmenu", onClick);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  return (
    <section className="flex h-full min-w-0 flex-col bg-surface">
      {/* Toolbar row: 38px, matches the pane header height (DESIGN.md §4.3).
          Lowercase chrome; theme tokens only. */}
      <header className="flex h-[38px] shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="mr-1 text-[11px] font-semibold tracking-[0.16em] text-text-dim">
          files
        </span>
        <ToolbarButton
          title="new file"
          onClick={() => rootPath && void filesStore.getState().beginCreate(rootPath, "file")}
          disabled={!rootPath}
        >
          <IconNewFile />
        </ToolbarButton>
        <ToolbarButton
          title="new folder"
          onClick={() => rootPath && void filesStore.getState().beginCreate(rootPath, "dir")}
          disabled={!rootPath}
        >
          <IconNewFolder />
        </ToolbarButton>
        <ToolbarButton
          title="refresh"
          onClick={() => void filesStore.getState().refreshAll()}
          disabled={!rootPath}
        >
          <IconRefresh />
        </ToolbarButton>
        <ToolbarButton
          title="collapse all"
          onClick={() => filesStore.getState().collapseAll()}
          disabled={!rootPath}
        >
          <IconCollapse />
        </ToolbarButton>
      </header>

      {opError && (
        <div className="shrink-0 border-b border-border bg-bg px-3 py-1 text-[11px] text-accent">
          {opError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {rootPath ? (
          <ul className="py-2 text-[13px] text-text-dim">
            {/* A brand-new entry being created directly under the root renders as
                an inline input at the top of the root listing. */}
            {edit?.kind === "create" && edit.parent === rootPath && (
              <InlineEditRow edit={edit} depth={0} />
            )}
            <TreeLevel dir={rootPath} depth={0} filter={filter} onContextMenu={openMenu} />
          </ul>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-text-dim">No project selected</p>
          </div>
        )}
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

// One directory's children. Recurses into expanded subdirectories. When a filter
// is active, a node stays visible if its own name matches OR any descendant does
// (so the path to a hit is navigable); matching dirs are force-expanded.
function TreeLevel({
  dir,
  depth,
  filter,
  onContextMenu,
}: {
  dir: string;
  depth: number;
  filter: string;
  onContextMenu: (e: React.MouseEvent, entry: DirEntry) => void;
}) {
  const entries = useStore(filesStore, (s) => s.children[dir]);
  const childMap = useStore(filesStore, (s) => s.children);
  if (!entries) return null;
  const needle = filter.trim().toLowerCase();
  return (
    <>
      {entries.map((entry) => {
        if (needle && !filterMatches(entry, needle, childMap)) return null;
        return (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={depth}
            filter={filter}
            onContextMenu={onContextMenu}
          />
        );
      })}
    </>
  );
}

// A single tree row: a clickable file, or an expandable directory that renders
// its children below when open. Right-click opens the context menu; a row in
// rename mode swaps to an inline input.
function TreeNode({
  entry,
  depth,
  filter,
  onContextMenu,
}: {
  entry: DirEntry;
  depth: number;
  filter: string;
  onContextMenu: (e: React.MouseEvent, entry: DirEntry) => void;
}) {
  const expanded = useStore(filesStore, (s) => !!s.expanded[entry.path]);
  const isSelected = useStore(filesStore, (s) => s.selectedPath === entry.path);
  const isRenaming = useStore(
    filesStore,
    (s) => s.edit?.kind === "rename" && s.edit.target === entry.path,
  );
  const creatingHere = useStore(
    filesStore,
    (s) => s.edit?.kind === "create" && s.edit.parent === entry.path,
  );
  const editForRow = useStore(filesStore, (s) => s.edit);
  const isDirty = useStore(
    filesStore,
    (s) =>
      !!s.dirtyPaths[entry.path] ||
      (s.selectedPath === entry.path &&
        (s.editorStatus === "dirty" || s.editorStatus === "conflict")),
  );
  // With a filter active, force-expand dirs so descendant hits are visible.
  const forceOpen = filter.trim() !== "";
  const showChildren = entry.isDir && (expanded || forceOpen);

  const onClick = () => {
    if (entry.isDir) void filesStore.getState().toggleDir(entry.path);
    else void filesStore.getState().selectFile(entry.path);
  };

  const paddingLeft = 12 + depth * 14;

  if (isRenaming && editForRow) {
    return <InlineEditRow edit={editForRow} depth={depth} />;
  }

  return (
    <>
      <li
        onClick={onClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
        title={entry.path}
        style={{ paddingLeft }}
        className={`flex h-7 cursor-pointer items-center gap-1.5 pr-3 hover:bg-surface-hover/50 ${
          isSelected ? "bg-surface-hover text-text" : ""
        }`}
      >
        <span className="flex w-3 shrink-0 items-center justify-center text-text-dim">
          {entry.isDir && (
            <svg
              viewBox="0 0 12 12"
              className={`h-2.5 w-2.5 transition-transform ${showChildren ? "rotate-90" : ""}`}
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M4 2.5 L8 6 L4 9.5 Z" />
            </svg>
          )}
        </span>
        <span className="flex w-3.5 shrink-0 items-center justify-center">
          <FileIcon
            category={entry.isDir ? (showChildren ? "folder-open" : "folder-closed") : iconCategoryFor(entry.path)}
            className="h-3.5 w-3.5"
          />
        </span>
        <span className="truncate">{entry.name}</span>
        {!entry.isDir && isDirty && (
          <span
            className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          />
        )}
      </li>
      {/* Inline new-entry row inside this directory (VS Code-style create). */}
      {creatingHere && editForRow && <InlineEditRow edit={editForRow} depth={depth + 1} />}
      {showChildren && (
        <TreeLevel dir={entry.path} depth={depth + 1} filter={filter} onContextMenu={onContextMenu} />
      )}
    </>
  );
}

// The inline input row for a create/rename. Autofocuses; for a rename of a file
// with an extension, pre-selects the base name (sans extension). Enter commits,
// Escape cancels, blur commits (VS Code behavior).
function InlineEditRow({ edit, depth }: { edit: FileEdit; depth: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const paddingLeft = 12 + depth * 14;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Pre-select the name sans a trivial extension on rename; whole value else.
    if (edit.kind === "rename" && edit.entryKind === "file") {
      const dot = edit.draft.lastIndexOf(".");
      if (dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    } else {
      el.select();
    }
    // Focus/selection are set once when the row mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <li className="flex h-7 items-center gap-1.5 pr-3" style={{ paddingLeft }}>
      <span className="flex w-3 shrink-0 items-center justify-center text-text-dim">
        {edit.entryKind === "dir" && (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="currentColor" aria-hidden="true">
            <path d="M4 2.5 L8 6 L4 9.5 Z" />
          </svg>
        )}
      </span>
      <span className="flex w-3.5 shrink-0 items-center justify-center">
        <FileIcon
          category={edit.entryKind === "dir" ? "folder-closed" : iconCategoryFor(edit.draft)}
          className="h-3.5 w-3.5"
        />
      </span>
      <input
        ref={inputRef}
        value={edit.draft}
        onChange={(e) => filesStore.getState().setEditDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void filesStore.getState().commitEdit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            filesStore.getState().cancelEdit();
          }
        }}
        onBlur={() => void filesStore.getState().commitEdit()}
        onClick={(e) => e.stopPropagation()}
        title={edit.error ?? ""}
        className={`min-w-0 flex-1 rounded border bg-bg px-1 py-0.5 text-[13px] text-text focus:outline-none ${
          edit.error ? "border-accent" : "border-border focus:border-accent"
        }`}
      />
    </li>
  );
}

export type MenuState = { x: number; y: number; entry: DirEntry };

// Lightweight context menu positioned at the cursor. Theme tokens only; no
// native menu plugin. Dismissal (click-away/Esc) is handled by the parent.
// Exported so the capability test can render it directly without standing up
// the whole file tree and a right-click.
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { entry } = menu;
  const run = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
    onClose();
  };
  return (
    <ul
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-50 min-w-[180px] rounded border border-border bg-surface py-1 text-[12px] text-text shadow-lg"
    >
      {entry.isDir && (
        <>
          <MenuItem onClick={run(() => void filesStore.getState().beginCreate(entry.path, "file"))}>
            new file
          </MenuItem>
          <MenuItem onClick={run(() => void filesStore.getState().beginCreate(entry.path, "dir"))}>
            new folder
          </MenuItem>
          <MenuDivider />
        </>
      )}
      <MenuItem onClick={run(() => filesStore.getState().beginRename(entry))}>rename</MenuItem>
      <MenuItem onClick={run(() => void filesStore.getState().trashEntry(entry))}>delete</MenuItem>
      <MenuDivider />
      {/* Some host platforms may not expose an OS file manager. */}
      {canRevealInOs(capabilitiesStore.getState().capabilities) && (
        <MenuItem onClick={run(() => void filesStore.getState().revealEntry(entry.path))}>
          {REVEAL_IN_FILE_MANAGER_LABEL}
        </MenuItem>
      )}
      <MenuItem onClick={run(() => void navigator.clipboard?.writeText(entry.path))}>
        copy path
      </MenuItem>
    </ul>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void }) {
  return (
    <li
      role="menuitem"
      onClick={onClick}
      className="cursor-pointer px-3 py-1 hover:bg-surface-hover"
    >
      {children}
    </li>
  );
}

function MenuDivider() {
  return <li className="my-1 border-t border-border" aria-hidden="true" />;
}

// A 22px square toolbar icon button. Lowercase tooltip via title.
function ToolbarButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-text-dim hover:bg-surface-hover hover:text-text disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

// --- Icons (currentColor, inherit the button's text token) ---

function IconNewFile() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M9 1.5H3.5v13H12.5V5L9 1.5Z" />
      <path d="M9 1.5V5h3.5" />
      <path d="M8 8v3M6.5 9.5h3" strokeLinecap="round" />
    </svg>
  );
}
function IconNewFolder() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M1.5 4.5 6 4.5 7.5 6H14.5v7.5H1.5Z" />
      <path d="M8 8.5v3M6.5 10h3" strokeLinecap="round" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M13 8a5 5 0 1 1-1.5-3.6" strokeLinecap="round" />
      <path d="M13 2.5V5h-2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconCollapse() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M4 6.5 8 10l4-3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 11h8" strokeLinecap="round" />
    </svg>
  );
}
