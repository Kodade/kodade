// Files store (Zustand vanilla, headless-testable). Owns the file-tree state
// for the active project: which directories are loaded and expanded, the
// watcher lifecycle (tied to the active project — switching projects stops the
// old watcher and starts a new one), refresh-on-change, and the selected file
// shown in the editor. All deps (the FilesIpc) are injected so tests drive it
// against a mock. Components are thin views over this store.

import { createStore } from "zustand/vanilla";
import type { FileActivityFact } from "../activity/adapters";
import type { DirEntry, FileRead, FilesIpc, Unlisten } from "../ipc/contract";
import { viewerKind } from "../editor/language";
import { decodeTabs, encodeTab, encodeTabs, tabsEqual, type Tab } from "./tabs";
import {
  nativeBasename,
  nativeDirname,
  nativeEquals,
  nativeIsDescendant,
  nativeJoin,
  normalizeNativeAbsolutePath,
  remapNativePath,
  validateNativeName,
} from "../platform/native-path";

export type FilesDeps = {
  files: FilesIpc;
  // Notified whenever a root's open-tab list changes (v1.1), so the app can
  // persist tabs per project. Optional: tests that don't care omit it.
  onTabsChanged?: (root: string, tabs: string[]) => void;
  // Low-sensitivity editor facts. Individual file paths and contents never
  // leave this store. The workspace root leaves only for registered-project
  // routing and is stripped before forwarding metadata to ActivityModule.
  onActivity?: (fact: FileActivityFact) => void;
  // Native browser ownership lives outside the headless files store. Every
  // browser-tab close, active or not, must still tear down that native child.
  onBrowserTabClosed?: () => void;
  // KödSSH (M11d): a remote preview tab closed — lets the app drop that
  // file's cached preview from remoteFilesStore so a later reopen re-fetches
  // instead of showing stale content.
  onRemotePreviewClosed?: (host: string, path: string) => void;
  // KödSSH (M11d): a remote-files (tree) tab closed — same idea, drops the
  // target's cached listing so reopening re-lists from scratch.
  onRemoteFilesClosed?: (host: string, path: string) => void;
  // Low-sensitivity metadata hooks. Only native paths are passed; the app
  // adapter converts them to workspace-relative paths before persistence.
  onFileOpened?: (root: string, path: string) => void;
  onFileSaved?: (root: string, path: string) => void;
};

// Editor state machine (M4b). Lives here next to the file tree so the whole
// dirty/save/conflict flow is headless-testable against MockFiles:
//   clean   → buffer matches what's on disk; external change auto-reloads
//   dirty   → buffer differs from disk (unsaved edits)
//   saving  → a write is in flight
//   conflict→ the file changed on disk while we had unsaved edits; the user
//             must choose reloadFromDisk() or keepMine()
export type EditorStatus = "clean" | "dirty" | "saving" | "conflict";
export type EditorMode = "view" | "edit";

// Markdown files start in their rendered view; every other text file stays in
// the normal editor. Kept pure so tab-mode defaults are headlessly testable.
export function defaultEditorMode(path: string): EditorMode {
  const base = nativeBasename(path);
  const ext = base.slice(base.lastIndexOf(".") + 1).toLowerCase();
  return ext === "md" || ext === "markdown" ? "view" : "edit";
}

export function isMarkdownFile(path: string): boolean {
  return defaultEditorMode(path) === "view";
}

// An in-flight inline edit in the tree (v1.1). "create" adds a new file/folder
// inside `parent` (like VS Code's inline new-entry row); "rename" edits an
// existing entry's `target` path. `draft` is the current text in the input;
// `error` is the live validation message (empty name, slash, collision).
export type FileEdit = {
  kind: "create" | "rename";
  entryKind: "file" | "dir"; // what's being created/renamed
  parent: string; // directory the entry lives in
  target: string | null; // existing path (rename) or null (create)
  draft: string; // current input text
  error: string | null; // inline validation message
};

// What we stash for a dirty/conflicted file when the user switches away, so
// switching back restores their in-progress edits instead of re-seeding from
// disk. Keyed by path in a closure-level map (bookkeeping, not view data).
type EditorStash = {
  buffer: string;
  savedContent: string;
  status: "dirty" | "conflict";
};

export type FilesState = {
  rootPath: string | null; // active project root ("" / null = none)
  children: Record<string, DirEntry[]>; // dirPath -> its listed entries (loaded lazily)
  expanded: Record<string, boolean>; // dirPath -> is expanded in the tree
  selectedPath: string | null; // file open in the editor (the ACTIVE tab)
  fileContent: FileRead | null; // result of reading the selected file
  loading: boolean; // a file read is in flight

  // --- Editor tabs (v1.1) ---
  // Ordered list of open file paths for the ACTIVE project's root. selectedPath
  // is the active tab within this list. Per-project: switching roots swaps this
  // for the new root's set (kept in a closure-level map keyed by root). The #9
  // per-path stash still owns dirty buffers across switches — tabs only track
  // which files are open and in what order.
  openTabs: Tab[];
  // The active typed tab. selectedPath remains the loaded file path so a
  // non-file tab can cover the editor without discarding its file buffer.
  activeTab: Tab | null;
  // Session-only per-tab view state. Markdown opens rendered; other text opens
  // in the editor. This is deliberately not part of persisted project tabs.
  tabModes: Record<string, EditorMode>;

  // --- Editor (M4b) ---
  editorStatus: EditorStatus; // state machine for the open text file
  buffer: string; // current editor text (only meaningful for a text file)
  savedContent: string; // baseline the buffer is diffed against (last known disk)
  diskContent: string | null; // disk content for Reload; null = deleted on disk
  saveError: string | null; // last save failure message (read-only file, etc.)
  // Paths with stashed unsaved edits (switched-away dirty/conflicted files), so
  // the file tree can show a dirty dot next to them. Mirrors the stash map keys.
  dirtyPaths: Record<string, boolean>;
  // True when the open file was deleted on disk under unsaved edits — the
  // conflict banner then offers "Close file" instead of "Reload from disk".
  deletedOnDisk: boolean;

  // --- File manager (v1.1) ---
  // Substring filter on entry names (case-insensitive). Empty = show everything.
  // The tree component narrows visible rows against this; matching a file also
  // keeps its ancestor dirs visible so the path to a hit stays navigable.
  filter: string;
  // The active inline edit, if any: creating a brand-new entry (parent dir known,
  // no path yet) or renaming an existing one. The tree renders an input for it;
  // committing runs the matching op and clears this. null = no edit in flight.
  edit: FileEdit | null;
  // Last op failure surfaced to the toolbar/inline row (collision, escape,
  // trash failure). Cleared when a new edit begins or an op succeeds.
  opError: string | null;

  // Point the tree at a project root: stop the old watcher, reset tree state,
  // start the new watcher, load the root listing. null clears everything.
  setRoot(root: string | null): Promise<void>;
  // Select a pinned remote project's tab scope. It has no local tree/watcher,
  // but its read-only remote tabs remain isolated like any local project.
  setRemoteScope(projectId: string): Promise<void>;
  // Expand/collapse a directory (loads its children on first expand).
  toggleDir(path: string): Promise<void>;
  // Open a file in the editor (reads it through Rust with the size/binary cap).
  selectFile(path: string): Promise<void>;
  // Begin listening for fs change batches. Returns an unlisten; call once.
  startWatchingChanges(): Promise<Unlisten>;

  // --- Editor actions (M4b) ---
  // Editor reports its current text; marks dirty/clean vs the saved baseline.
  setBuffer(text: string): void;
  // Write the buffer to disk atomically. On success clears dirty; on failure
  // keeps the buffer and surfaces saveError (never truncates on a failed write).
  saveFile(): Promise<void>;
  // Conflict resolution: discard my edits and take the on-disk version. If the
  // file was deleted on disk, this closes the file (nothing to reload).
  reloadFromDisk(): void;
  // Conflict resolution: keep my edits; disk becomes the new save baseline so
  // the next save overwrites it (and the conflict banner clears).
  keepMine(): void;

  // --- File-manager actions (v1.1) ---
  // Set the name filter (case-insensitive substring on entry names).
  setFilter(text: string): void;
  // Re-list every currently-loaded directory (the refresh button).
  refreshAll(): Promise<void>;
  // Collapse everything back to just the root expanded (collapse-all button).
  collapseAll(): void;
  // Begin an inline "new file" / "new folder" edit inside `parent`. Expands the
  // parent so the new-entry row is visible. Only one edit runs at a time.
  beginCreate(parent: string, entryKind: "file" | "dir"): Promise<void>;
  // Begin an inline rename of an existing entry.
  beginRename(entry: DirEntry): void;
  // Update the in-flight edit's draft text and re-run validation.
  setEditDraft(text: string): void;
  // Commit the in-flight edit: validate, run the create/rename op, relist the
  // affected dir, and (for rename) follow the open file. Clears the edit on
  // success; keeps it with an inline error on validation/op failure.
  commitEdit(): Promise<void>;
  // Cancel the in-flight edit without touching the filesystem.
  cancelEdit(): void;
  // Move an entry to the OS trash. If it's the open file (or an ancestor of it),
  // the editor closes/conflicts per the #9 deleted-on-disk semantics.
  trashEntry(entry: DirEntry): Promise<void>;
  // Reveal an entry in the OS file manager (Finder or Explorer).
  revealEntry(path: string): Promise<void>;

  // --- Editor tab actions (v1.1) ---
  // Close a tab. Removes it from openTabs; if it was active, activates the
  // neighbor (prefers the left one). Closing the last tab clears the editor.
  closeTab(tab: Tab): void;
  // Activate an already-open tab (re-reads it into the editor). No-op if the
  // path isn't an open tab or is already active.
  activateTab(tab: Tab): void;
  // Open the singleton GitHub tab for the active project, or activate it when
  // it already exists.
  openGithubTab(): void;
  // Open or activate the project's singleton browser tab at its current URL.
  openBrowserTab(): void;
  // Open the singleton review tab for the active project, or activate it when it
  // already exists (KödPR, M12). One review tab per project.
  openReviewTab(): void;
  // Open (or activate) one KödWork task's detail tab (#43). One tab per task.
  openKodworkTab(taskId: string): void;
  // Open (or activate) the browsable tree tab for one pinned remote target
  // (KödSSH, M11d, Pro). One tab per host:path, mirroring the memory tab's
  // per-workspace singleton behavior.
  openRemoteFilesTab(host: string, path: string): void;
  // Open (or activate) a read-only preview tab for one remote file (KödSSH,
  // M11d, Pro). One tab per host:path.
  openRemotePreviewTab(host: string, path: string): void;
  // Follow native navigation/redirects without replacing the tab's position.
  setBrowserUrl(url: string): void;
  // Move to the next/prev tab within the active project, wrapping around.
  // No-op with fewer than two tabs.
  cycleTab(direction: 1 | -1): void;
  // Flip the active markdown tab between rendered view and the CodeMirror edit
  // surface. Other file types are always edit mode and ignore this action.
  toggleActiveTabMode(): void;
  // Restore a set of open tabs for a root (persistence). Only paths that read
  // as text survive; a failed read closes that tab. The last valid path becomes
  // active. Called by the app after a project's root is set.
  restoreTabs(root: string, paths: string[]): Promise<void>;
  // The open-tab paths currently recorded for a root (for persistence). Returns
  // the live list for the active root, or the stashed list for a background one.
  getTabsForRoot(root: string): Tab[];
  // Drop a root's tab closure entry entirely (project removed). If it's also the
  // active root, clear the visible openTabs state too. Additive cleanup so a
  // removed-then-re-added folder starts with no stale tabs.
  dropTabsForRoot(root: string): void;
};

export function createFilesStore(deps: FilesDeps) {
  // Monotonic root generation: bumped by every setRoot call. Every async step
  // captures it and bails if a newer setRoot has started — so overlapping
  // project switches always converge on the NEWEST root's watcher and tree,
  // and a stale dir listing can never resurrect entries after a switch.
  let rootGen = 0;

  const onTabsChanged = deps.onTabsChanged;

  return createStore<FilesState>((set, get) => {
    // Self-save suppression: the exact bytes we last wrote to `selectedPath`.
    // Our own atomic write fires the watcher; when the change event's fresh disk
    // read matches this, it's our echo — ignore it so we never flag a conflict
    // against ourselves. Cleared whenever a different file is selected. Kept in
    // the closure (not state) since it's bookkeeping, not view data.
    let lastSaved: { path: string; content: string } | null = null;

    // Per-path stash of unsaved edits for files switched away from while
    // dirty/conflicted. Restored on re-select so switching files never discards
    // work. Cleared for a path when it's saved or its conflict is resolved.
    const stash = new Map<string, EditorStash>();

    // Path of the write currently in flight (status === "saving"), if any. A
    // rename during an in-flight save rewrites this via followRename so the
    // save's completion compares against the file's CURRENT path and doesn't
    // strand the editor in "saving" (Fix 7). null when no save is in flight.
    let savingPath: string | null = null;

    // Old paths of in-flight rename/trash ops. reconcileOpenFile's missing-file
    // branch ignores a path in this set: the op's own completion owns the
    // bookkeeping, so a watcher-driven reconcile racing the op must not close or
    // false-flag the editor (Fix 6). Entries are added BEFORE the IPC call and
    // cleared in a finally.
    const pendingOps = new Set<string>();

    // Monotonic inline-edit session token. Every beginCreate/beginRename bumps
    // it; commitEdit captures the current token and no-ops if a newer edit has
    // started since — so a stale blur-commit from a previous row can't fire after
    // a new edit began (Fix 8).
    let editToken = 0;

    // Per-root open-tab lists (v1.1). Keyed by root path so each project keeps
    // its own tab set; the active root's list is mirrored into state.openTabs.
    // Background roots keep their list here until their root is set again.
    const tabsByRoot = new Map<string, Tab[]>();
    // Mirrors tabsByRoot but stays entirely in this session; project persistence
    // records only paths, never whether a markdown tab was being read or edited.
    const tabModesByRoot = new Map<string, Record<string, EditorMode>>();

    let remoteScope: string | null = null;
    // Local projects key tabs by native root; remote projects key them by
    // their stable synthetic project id while rootPath intentionally stays null.
    const activeRoot = () => get().rootPath ?? remoteScope;

    // Mirror the active root's tab list into state, and persist the change out
    // to whoever wired onTabsChanged (the app persists per project).
    const syncTabs = () => {
      const root = activeRoot();
      const tabs = root ? (tabsByRoot.get(root) ?? []) : [];
      set({ openTabs: tabs });
      if (root) onTabsChanged?.(root, encodeTabs(tabs));
    };

    const setTabMode = (path: string, mode: EditorMode) => {
      const root = activeRoot();
      if (root) {
        const modes = { ...(tabModesByRoot.get(root) ?? {}), [path]: mode };
        tabModesByRoot.set(root, modes);
        set({ tabModes: modes });
        return;
      }
      set((s) => ({ tabModes: { ...s.tabModes, [path]: mode } }));
    };

    const removeTabMode = (path: string) => {
      const root = activeRoot();
      const modes = { ...(root ? tabModesByRoot.get(root) : get().tabModes) };
      delete modes[path];
      if (root) tabModesByRoot.set(root, modes);
      set({ tabModes: modes });
    };

    // Reflect the stash's keys into state so the file tree can dot dirty files.
    const syncDirtyPaths = () => {
      const dirtyPaths: Record<string, boolean> = {};
      for (const p of stash.keys()) {
        if (!viewerKind(p)) dirtyPaths[p] = true;
      }
      set({ dirtyPaths });
    };

    // Reset the editor state machine for a freshly-read text file.
    const openText = (content: string) => {
      set({
        editorStatus: "clean",
        buffer: content,
        savedContent: content,
        diskContent: content,
        saveError: null,
        deletedOnDisk: false,
      });
    };

    // True when `path` is itself a pending-op path or sits under one (an
    // ancestor-dir rename/trash registers the dir; the open file is a
    // descendant). Component-aware so /a/b doesn't match a pending /a/bee.
    const isPendingOp = (path: string): boolean => {
      for (const p of pendingOps) {
        if (nativeEquals(path, p) || isUnder(path, p)) return true;
      }
      return false;
    };

    // Handle an external filesystem change to the currently-open file: reconcile
    // the editor against fresh disk content. Runs only for the selected path.
    const reconcileOpenFile = async (path: string) => {
      let read: FileRead;
      try {
        read = await deps.files.readFile(path);
      } catch {
        // Read-back failed. If the file still exists this may be a transient
        // error, but a delete is the common case; treat it as delete-under-edit.
        if (get().selectedPath !== path) return;
        // A rename/trash op for this path (or an ancestor) is in flight: the
        // read fails only because the op is mid-move. The op's own completion
        // (followRename / trash's reconcile) owns the bookkeeping — a watcher
        // race here must not close or false-flag the editor (Fix 6).
        if (isPendingOp(path)) return;
        const s = get();
        // A pending self-save echo for a now-unreadable file is meaningless —
        // consume it so it can't suppress a later genuine change (one-shot).
        if (lastSaved && lastSaved.path === path) lastSaved = null;
        if (s.editorStatus === "dirty" || s.editorStatus === "conflict") {
          // Unsaved edits over a deleted file: hold the buffer in a conflict the
          // user must resolve, flagged as a deletion (diskContent null so the
          // banner offers "Close file" instead of a reload to stale bytes).
          set({
            editorStatus: "conflict",
            diskContent: null,
            deletedOnDisk: true,
          });
        } else {
          // Clean and gone: nothing to preserve — close the file.
          closeEditor();
        }
        return;
      }
      // A newer selection superseded this file while the read was in flight.
      if (get().selectedPath !== path) return;
      // Only text files participate in the edit/conflict flow.
      if (read.kind !== "text") return;
      const disk = read.content;

      // Our own save's echo — the watcher fired for the bytes we just wrote.
      // One-shot: whether it matches (suppress) or not (fall through as an
      // external change), it's consumed here so it can never linger to suppress
      // a later legitimate external write of these same old bytes.
      if (lastSaved && lastSaved.path === path) {
        const echo = lastSaved.content === disk;
        lastSaved = null;
        if (echo) return; // our own write landing back — ignore it
      }

      const s = get();
      // Disk already equals what we have — nothing to do. (A save in flight is
      // NOT skipped: an external write during a save must still be reconciled.)
      if (disk === s.savedContent && s.editorStatus !== "conflict") return;

      if (
        s.editorStatus === "dirty" ||
        s.editorStatus === "conflict" ||
        s.editorStatus === "saving"
      ) {
        // Unsaved edits (or an in-flight save) under an external change: enter/
        // refresh conflict exposing the disk version for Reload; buffer untouched.
        set({
          editorStatus: "conflict",
          diskContent: disk,
          deletedOnDisk: false,
        });
      } else {
        // Clean buffer: seamlessly adopt the on-disk version.
        set({
          buffer: disk,
          savedContent: disk,
          diskContent: disk,
          fileContent: read,
          editorStatus: "clean",
          deletedOnDisk: false,
        });
      }
    };

    // Close the open file: clear the selection and reset the editor machine.
    // Used when a clean, open file is deleted on disk.
    const closeEditor = () => {
      lastSaved = null;
      const current = get();
      const activeTab =
        current.activeTab?.kind === "file" &&
        current.activeTab.path === current.selectedPath
          ? null
          : current.activeTab;
      set({
        selectedPath: null,
        activeTab,
        fileContent: null,
        loading: false,
        editorStatus: "clean",
        buffer: "",
        savedContent: "",
        diskContent: null,
        saveError: null,
        deletedOnDisk: false,
      });
    };

    // Re-list a directory we already have loaded, replacing its entries.
    // Missing/deleted dirs drop out of `children` so the tree prunes cleanly.
    const relist = async (dir: string) => {
      if (!(dir in get().children)) return; // only refresh what's on screen
      const gen = rootGen;
      try {
        const entries = await deps.files.listDir(dir);
        if (gen !== rootGen) return; // root switched under this listing
        set((s) => ({ children: { ...s.children, [dir]: entries } }));
      } catch {
        if (gen !== rootGen) return;
        // Dir vanished (deleted): drop it and its expanded flag.
        set((s) => {
          const children = { ...s.children };
          const expanded = { ...s.expanded };
          delete children[dir];
          delete expanded[dir];
          return { children, expanded };
        });
      }
    };

    return {
      rootPath: null,
      children: {},
      expanded: {},
      selectedPath: null,
      fileContent: null,
      loading: false,
      openTabs: [],
      activeTab: null,
      tabModes: {},
      editorStatus: "clean",
      buffer: "",
      savedContent: "",
      diskContent: "",
      saveError: null,
      dirtyPaths: {},
      deletedOnDisk: false,
      filter: "",
      edit: null,
      opError: null,

      async setRoot(root: string | null) {
        if (get().rootPath === root && remoteScope === null) return;
        remoteScope = null;
        const gen = ++rootGen; // this call owns the tree until a newer one starts
        // Switching projects abandons the old project's editor/stash state.
        stash.clear();
        lastSaved = null;
        // Stop the previous project's watcher before anything else.
        await deps.files.unwatch(gen);
        if (gen !== rootGen) return; // superseded mid-switch (A→B→A)

        if (!root) {
          set({
            rootPath: null,
            children: {},
            expanded: {},
            selectedPath: null,
            fileContent: null,
            dirtyPaths: {},
            filter: "",
            edit: null,
            opError: null,
            openTabs: [],
            activeTab: null,
            tabModes: {},
          });
          return;
        }

        // Reset tree for the new project; keep root expanded by default. A new
        // project clears any in-flight edit, filter, and op error. Swap the
        // visible tab set to whatever this root already had open (empty on first
        // visit; restoreTabs may seed it after a restart).
        set({
          rootPath: root,
          children: {},
          expanded: { [root]: true },
          selectedPath: null,
          fileContent: null,
          filter: "",
          edit: null,
          opError: null,
          openTabs: tabsByRoot.get(root) ?? [],
          activeTab: null,
          tabModes: tabModesByRoot.get(root) ?? {},
        });

        await deps.files.watch(root, gen);
        if (gen !== rootGen) return; // a newer switch owns the watcher now
        // Load the root listing (tolerate an unreadable root — empty tree).
        try {
          const entries = await deps.files.listDir(root);
          if (gen !== rootGen) return;
          set((s) => ({ children: { ...s.children, [root]: entries } }));
        } catch {
          /* leave root empty */
        }
      },

      async setRemoteScope(projectId: string) {
        if (!projectId || (get().rootPath === null && remoteScope === projectId))
          return;
        const gen = ++rootGen;
        stash.clear();
        lastSaved = null;
        await deps.files.unwatch(gen);
        if (gen !== rootGen) return;
        remoteScope = projectId;
        const tabs = tabsByRoot.get(projectId) ?? [];
        set({
          rootPath: null,
          children: {},
          expanded: {},
          selectedPath: null,
          fileContent: null,
          loading: false,
          dirtyPaths: {},
          filter: "",
          edit: null,
          opError: null,
          openTabs: tabs,
          activeTab: tabs.at(-1) ?? null,
          tabModes: {},
        });
      },

      async toggleDir(path: string) {
        const isExpanded = !!get().expanded[path];
        if (isExpanded) {
          set((s) => ({ expanded: { ...s.expanded, [path]: false } }));
          return;
        }
        set((s) => ({ expanded: { ...s.expanded, [path]: true } }));
        // Load children on first expand only.
        if (!(path in get().children)) {
          const gen = rootGen;
          try {
            const entries = await deps.files.listDir(path);
            if (gen !== rootGen) return; // root switched under this expand
            set((s) => ({ children: { ...s.children, [path]: entries } }));
          } catch {
            /* unreadable dir: leave it empty but expanded */
          }
        }
      },

      async selectFile(path: string) {
        const prev = get();
        // Re-selecting the already-open file is a no-op — don't reset the buffer.
        if (prev.selectedPath === path) {
          set({ activeTab: { kind: "file", path } });
          return;
        }

        // Open (or re-activate) a tab for this file. Dedup: an already-open path
        // just becomes active; a new one is appended to the active root's list.
        const root = prev.rootPath;
        if (root) {
          const tabs = tabsByRoot.get(root) ?? [];
          const fileTab: Tab = { kind: "file", path };
          if (!tabs.some((tab) => tabsEqual(tab, fileTab))) {
            tabsByRoot.set(root, [...tabs, fileTab]);
            syncTabs();
          }
        }
        if (!(path in prev.tabModes)) setTabMode(path, defaultEditorMode(path));
        // Directories can NEVER open in the editor. Even if a caller routes a dir
        // path here, treat it as a no-op — readFile on a dir would reject and fall
        // through to the "Binary file" placeholder (the reported bug). The tree
        // marks dirs via isDir on each entry; the root is always a dir too.
        if (isKnownDir(prev, path)) return;
        deps.onActivity?.({ type: "file-opened", root: prev.rootPath });

        // Stash the file we're leaving if it has unsaved work, so switching back
        // restores it instead of re-seeding from disk. Save/resolve clears it.
        // "saving" is stashed too (as dirty): if the in-flight write FAILS after
        // we've left, the buffer would otherwise be gone (Fix: mid-save close).
        // saveFile's completion reconciles this stash for a no-longer-selected
        // path — success deletes it (clean), failure leaves it (recoverable).
        if (
          prev.selectedPath !== null &&
          prev.fileContent?.kind === "text" &&
          (prev.editorStatus === "dirty" ||
            prev.editorStatus === "conflict" ||
            prev.editorStatus === "saving")
        ) {
          stash.set(prev.selectedPath, {
            buffer: prev.buffer,
            savedContent: prev.savedContent,
            status: prev.editorStatus === "conflict" ? "conflict" : "dirty",
          });
        }

        // Switching files drops any pending self-save echo (it belonged to the
        // file we're leaving) and resets the editor before the read lands.
        lastSaved = null;
        set({
          selectedPath: path,
          activeTab: { kind: "file", path },
          loading: true,
          fileContent: null,
          editorStatus: "clean",
          buffer: "",
          savedContent: "",
          diskContent: "",
          saveError: null,
          deletedOnDisk: false,
        });
        syncDirtyPaths();
        try {
          const result = await deps.files.readFile(path);
          // A newer selection may have superseded this read.
          if (get().selectedPath !== path) return;
          set({ fileContent: result, loading: false });
          if (root) deps.onFileOpened?.(root, path);
          if (result.kind !== "text") return;

          const saved = stash.get(path);
          if (saved) {
            // Restore stashed edits, reconciling against the fresh disk read so a
            // change while we were away still surfaces.
            const disk = result.content;
            let status: EditorStatus;
            if (saved.buffer === disk) {
              // Edits now match disk exactly — nothing unsaved. Clean.
              status = "clean";
            } else if (
              saved.status === "conflict" ||
              disk !== saved.savedContent
            ) {
              // Was already conflicted, or disk drifted from the baseline the
              // stash was diffed against (changed under us) — conflict.
              status = "conflict";
            } else {
              // Disk unchanged; buffer still differs — plain dirty.
              status = "dirty";
            }
            if (status === "clean") {
              stash.delete(path);
              // Adopt disk as the clean baseline; buffer already equals it.
              openText(disk);
            } else {
              set({
                buffer: saved.buffer,
                savedContent: saved.savedContent,
                diskContent: disk,
                editorStatus: status,
                saveError: null,
                deletedOnDisk: false,
              });
            }
            syncDirtyPaths();
          } else {
            openText(result.content);
          }
        } catch {
          if (get().selectedPath !== path) return;
          set({ fileContent: { kind: "binary" }, loading: false });
        }
      },

      async startWatchingChanges() {
        return deps.files.onChanged((e) => {
          // Refresh every loaded directory touched by the batch. The affected
          // paths include both changed entries and their parent dirs (Rust
          // emits both), so re-listing the ones we have loaded picks up
          // creates, renames, and deletes. Simple and correct beats clever.
          const loaded = get().children;
          const dirs = new Set<string>();
          for (const p of e.paths) {
            if (p in loaded) dirs.add(p); // the path itself is a loaded dir
            const parent = parentDir(p);
            if (parent && parent in loaded) dirs.add(parent);
          }
          for (const dir of dirs) void relist(dir);

          // If the open file is among the changed paths, reconcile the editor
          // (auto-reload when clean, conflict when dirty, ignore our own save).
          const open = get().selectedPath;
          if (open && e.paths.includes(open)) void reconcileOpenFile(open);
        });
      },

      setBuffer(text: string) {
        const s = get();
        if (s.selectedPath === null || s.fileContent?.kind !== "text") return;
        // A conflict stays a conflict until the user resolves it — typing under
        // an unresolved conflict doesn't clear the banner, but the buffer tracks.
        if (s.editorStatus === "conflict") {
          set({ buffer: text });
          return;
        }
        set({
          buffer: text,
          editorStatus: text === s.savedContent ? "clean" : "dirty",
          saveError: null, // a fresh edit clears a stale save error
        });
      },

      async saveFile() {
        const s = get();
        // Only the active real text-file tab can be saved. A non-file tab may
        // cover a dirty editor buffer, but Mod-S there must not write it unseen.
        if (
          s.activeTab?.kind !== "file" ||
          s.activeTab.path !== s.selectedPath ||
          s.fileContent?.kind !== "text"
        )
          return;
        if (s.editorStatus === "saving") return; // save already in flight
        // A conflict must be resolved via the banner (Reload / Keep mine) — a
        // blind Mod-S must not overwrite the disk version behind the banner.
        if (s.editorStatus === "conflict") return;
        const path = s.selectedPath;
        const root = s.rootPath;
        // Capture the exact bytes we're writing NOW. Typing during the in-flight
        // write must not be marked clean by this save's completion.
        const savedBuffer = s.buffer;

        // Track the in-flight save's path so a rename during the write (which
        // rewrites savingPath via followRename) doesn't strand us in "saving"
        // (Fix 7). The write itself targets the ORIGINAL path (that's where the
        // bytes go); completion reconciles against the possibly-rewritten path.
        savingPath = path;
        set({ editorStatus: "saving", saveError: null });
        try {
          await deps.files.writeFile(path, savedBuffer);
          deps.onActivity?.({ type: "file-saved", root });
          // The file may have been renamed mid-write (savingPath rewritten) or a
          // different file selected. Reconcile against the current save path.
          const curPath = savingPath;
          if (root && curPath) deps.onFileSaved?.(root, curPath);
          if (curPath === null || get().selectedPath !== curPath) {
            // We saved a path that's no longer the active editor (the user
            // switched away / closed the tab mid-save — its buffer was stashed).
            // The write SUCCEEDED, so if the stash still holds exactly the bytes
            // we just wrote, it's clean now: drop it so no stale dirty dot lingers
            // (Fix: close-during-save). A stash that has since diverged is left.
            if (curPath !== null) {
              const stashed = stash.get(curPath);
              if (stashed && stashed.buffer === savedBuffer) {
                stash.delete(curPath);
                syncDirtyPaths();
              }
            }
            return;
          }
          const now = get();
          // An external change landed during the write and flipped us into a
          // conflict — the banner now owns reconciliation. Don't blanket-clean.
          // (We deliberately do NOT set lastSaved here: our own echo is only
          // meaningful for the file we cleanly saved.)
          if (now.editorStatus === "conflict") return;
          // Remember the exact bytes so the watcher echo of our own write is
          // suppressed instead of flagged as an external conflict. Key on the
          // CURRENT path (a rename mid-save moved us) so the echo for the new
          // path is matched.
          lastSaved = { path: curPath, content: savedBuffer };
          // The write succeeded — this path has no unsaved work to stash anymore.
          stash.delete(curPath);
          set({
            savedContent: savedBuffer,
            diskContent: savedBuffer,
            // Only clean if the buffer still matches what we wrote; edits typed
            // during the in-flight save keep it dirty.
            editorStatus: now.buffer === savedBuffer ? "clean" : "dirty",
            saveError: null,
            fileContent: { kind: "text", content: savedBuffer },
          });
          syncDirtyPaths();
        } catch (err) {
          // Reconcile against the current save path (a rename may have moved us).
          const curPath = savingPath;
          // Path is no longer the active editor (switched away / closed mid-save):
          // the write FAILED, so leave the stash untouched — the buffer is
          // recoverable when the file is reopened (Fix: close-during-save).
          if (curPath === null || get().selectedPath !== curPath) return;
          // Write failed (read-only file, missing dir): keep the buffer intact
          // and surface the error. Disk was never truncated (atomic write). The
          // buffer still differs from disk, so we're back to dirty.
          set({
            editorStatus: "dirty",
            saveError: err instanceof Error ? err.message : String(err),
          });
        } finally {
          // This save is no longer in flight (whether it committed, was
          // superseded, or failed) — stop tracking its path. Only one save runs
          // at a time (the "saving" guard above), so this always clears our own.
          savingPath = null;
        }
      },

      reloadFromDisk() {
        const s = get();
        if (s.editorStatus !== "conflict") return;
        if (s.selectedPath !== null) stash.delete(s.selectedPath); // resolved
        // If the file was deleted on disk there's nothing to reload — "Reload
        // from disk" acts as "Close file" (least surprising: the file is gone).
        if (s.deletedOnDisk || s.diskContent === null) {
          closeEditor();
          syncDirtyPaths();
          return;
        }
        // Discard my edits; take the on-disk version as the new clean baseline.
        set({
          buffer: s.diskContent,
          savedContent: s.diskContent,
          editorStatus: "clean",
          saveError: null,
          deletedOnDisk: false,
          fileContent: { kind: "text", content: s.diskContent },
        });
        syncDirtyPaths();
      },

      keepMine() {
        const s = get();
        if (s.editorStatus !== "conflict") return;
        if (s.selectedPath !== null) stash.delete(s.selectedPath); // resolved
        // File deleted on disk: keeping mine means the buffer is now unsaved
        // content with no disk baseline — treat it as dirty against empty disk
        // so the next save re-creates the file.
        if (s.deletedOnDisk || s.diskContent === null) {
          set({
            savedContent: "",
            editorStatus: s.buffer === "" ? "clean" : "dirty",
            saveError: null,
            deletedOnDisk: false,
          });
          syncDirtyPaths();
          return;
        }
        // Keep my buffer; adopt disk as the baseline so we're back to plain
        // "dirty" (my buffer differs from disk) and the next save overwrites it.
        set({
          savedContent: s.diskContent,
          editorStatus: s.buffer === s.diskContent ? "clean" : "dirty",
          saveError: null,
        });
        syncDirtyPaths();
      },

      // --- File-manager actions (v1.1) ---

      setFilter(text: string) {
        set({ filter: text });
      },

      async refreshAll() {
        // Re-list every dir we currently have loaded (the ones on screen).
        const dirs = Object.keys(get().children);
        await Promise.all(dirs.map((d) => relist(d)));
      },

      collapseAll() {
        const root = get().rootPath;
        // Reset expansion to just the root (or nothing if no project). Cached
        // children stay so re-expanding is instant; only the flags reset.
        set({ expanded: root ? { [root]: true } : {} });
      },

      async beginCreate(parent: string, entryKind: "file" | "dir") {
        // Invalidate any pending blur-commit from a previous edit row (Fix 8).
        editToken++;
        // Make sure the parent is expanded and its children are loaded so the
        // new-entry input renders inside it (VS Code-style inline create).
        if (!get().expanded[parent] || !(parent in get().children)) {
          set((s) => ({ expanded: { ...s.expanded, [parent]: true } }));
          if (!(parent in get().children)) {
            const gen = rootGen;
            try {
              const entries = await deps.files.listDir(parent);
              if (gen !== rootGen) return;
              set((s) => ({ children: { ...s.children, [parent]: entries } }));
            } catch {
              /* leave empty */
            }
          }
        }
        set({
          edit: {
            kind: "create",
            entryKind,
            parent,
            target: null,
            draft: "",
            error: null,
          },
          opError: null,
        });
      },

      beginRename(entry: DirEntry) {
        // Invalidate any pending blur-commit from a previous edit row (Fix 8).
        editToken++;
        set({
          edit: {
            kind: "rename",
            entryKind: entry.isDir ? "dir" : "file",
            parent: parentDir(entry.path) ?? entry.path,
            target: entry.path,
            draft: entry.name,
            error: null,
          },
          opError: null,
        });
      },

      setEditDraft(text: string) {
        const edit = get().edit;
        if (!edit) return;
        set({
          edit: {
            ...edit,
            draft: text,
            error: validateName(get(), edit, text),
          },
        });
      },

      async commitEdit() {
        const edit = get().edit;
        if (!edit) return;
        // Capture the edit session token. A blur-commit that fires AFTER a new
        // inline edit has begun (which bumped the token) is stale and no-ops, so
        // an old row's late commit can't clobber the new edit (Fix 8).
        const token = editToken;
        const name = edit.draft.trim();
        // Validate the raw draft before applying the existing whitespace trim.
        // Windows rejects trailing spaces rather than silently changing the
        // requested name, while Unix keeps its established trimmed-name flow.
        const error = validateName(get(), edit, edit.draft);
        if (error) {
          // A stale commit must not mutate the (now different) live edit.
          if (token !== editToken) return;
          // Keep editing with the inline error shown.
          set({ edit: { ...edit, error } });
          return;
        }
        const root = get().rootPath;
        if (!root) return;
        const newPath = joinPath(edit.parent, name);

        // A rename registers its OLD path in the pending set before the IPC call
        // so a watcher-driven reconcile racing the move doesn't close/false-flag
        // the editor (Fix 6). Cleared in the finally below.
        const isRename =
          edit.kind === "rename" && !!edit.target && edit.target !== newPath;
        if (isRename && edit.target) pendingOps.add(edit.target);
        try {
          if (edit.kind === "create") {
            if (edit.entryKind === "dir")
              await deps.files.createDir(root, newPath);
            else await deps.files.createFile(root, newPath);
          } else if (isRename && edit.target) {
            await deps.files.rename(root, edit.target, newPath);
          }
        } catch (err) {
          // A stale commit (superseded by a newer edit) must not overwrite it.
          if (token !== editToken) return;
          // Op rejected (collision on disk, confinement escape): keep editing.
          set({
            edit: {
              ...edit,
              error: err instanceof Error ? err.message : String(err),
            },
          });
          return;
        } finally {
          if (isRename && edit.target) pendingOps.delete(edit.target);
        }

        // A stale commit succeeded on disk but must not touch the newer edit's UI.
        if (token !== editToken) return;

        // A rename remaps all dirty bookkeeping (open file, background stashes,
        // in-flight save) to the new location.
        if (isRename && edit.target) {
          followRename(edit.target, newPath);
        }

        set({ edit: null, opError: null });
        // Immediate relist of the affected dir so the UI doesn't wait for the
        // 150ms watcher debounce; the watcher event later reconciles the same.
        await relist(edit.parent);
      },

      cancelEdit() {
        set({ edit: null, opError: null });
      },

      async trashEntry(entry: DirEntry) {
        const root = get().rootPath;
        if (!root) return;
        const open = get().selectedPath;
        // The OPEN file (or an open file inside a trashed dir) keeps the #9
        // deleted-on-disk conflict semantics — its stash is handled by that flow,
        // not cleaned up here. Register it in the pending set so a watcher-driven
        // reconcile racing the trash doesn't fire its own missing-file handling
        // before the op completes (Fix 6).
        const openAffected =
          !!open && (open === entry.path || isUnder(open, entry.path));
        if (openAffected && open) pendingOps.add(open);
        try {
          await deps.files.trash(root, entry.path);
        } catch (err) {
          set({ opError: err instanceof Error ? err.message : String(err) });
          return;
        } finally {
          if (openAffected && open) pendingOps.delete(open);
        }
        // Trashing recovers the bytes into the OS trash, so any orphaned stash
        // for a BACKGROUND dirty file under the trashed path is a leak — remove
        // stash + dirtyPaths entries for the trashed path and its descendants.
        // The open file is excluded (its conflict flow owns its stash).
        for (const key of [...stash.keys()]) {
          if (key === open) continue; // open file keeps its #9 conflict + stash
          if (key === entry.path || isUnder(key, entry.path)) stash.delete(key);
        }
        // Close every BACKGROUND tab under the trashed path — the files are gone,
        // so their tabs shouldn't linger. The open/active file is excluded: it
        // keeps its tab so the #9 deleted-on-disk conflict flow can be resolved
        // in the editor. If any tab closed, mirror the list into state and fire
        // onTabsChanged so persistence drops them too.
        const tabs = tabsByRoot.get(root) ?? [];
        const nextTabs = tabs.filter((tab) => {
          if (tab.kind !== "file") return true;
          const p = tab.path;
          if (p === open) return true; // open file keeps its tab (#9 conflict)
          return !(p === entry.path || isUnder(p, entry.path));
        });
        if (nextTabs.length !== tabs.length) {
          tabsByRoot.set(root, nextTabs);
          const modes = { ...(tabModesByRoot.get(root) ?? {}) };
          for (const tab of tabs) {
            if (
              tab.kind === "file" &&
              !nextTabs.some((next) => tabsEqual(next, tab))
            ) {
              delete modes[tab.path];
            }
          }
          tabModesByRoot.set(root, modes);
          set({ tabModes: modes });
          syncTabs();
        }
        // If the open file was trashed (directly, or inside a trashed dir),
        // reconcile the editor with the #9 deleted-on-disk semantics.
        if (openAffected && open) {
          await reconcileOpenFile(open);
        }
        set({ opError: null });
        syncDirtyPaths();
        // Optimistic relist so the row disappears immediately.
        await relist(parentDir(entry.path) ?? entry.path);
      },

      async revealEntry(path: string) {
        const root = get().rootPath;
        if (!root) return;
        try {
          await deps.files.reveal(root, path);
          set({ opError: null });
        } catch (err) {
          set({ opError: err instanceof Error ? err.message : String(err) });
        }
      },

      // --- Editor tab actions (v1.1) ---

      closeTab(tab: Tab) {
        const root = activeRoot();
        const tabs = root ? (tabsByRoot.get(root) ?? []) : get().openTabs;
        const key = encodeTab(tab);
        const idx = tabs.findIndex((candidate) => encodeTab(candidate) === key);
        if (idx === -1) return;

        const next = tabs.filter((candidate) => encodeTab(candidate) !== key);
        if (root) tabsByRoot.set(root, next);
        else set({ openTabs: next });
        if (tab.kind === "file") removeTabMode(tab.path);
        if (tab.kind === "browser") deps.onBrowserTabClosed?.();
        if (tab.kind === "remote-preview") deps.onRemotePreviewClosed?.(tab.host, tab.path);
        if (tab.kind === "remote-files") deps.onRemoteFilesClosed?.(tab.host, tab.path);
        // Spec (#30): closing a dirty tab must NOT silently discard edits — the
        // per-path stash keeps them, so reopening the file restores the buffer
        // (and the tree keeps its dirty dot). Clean tabs have no stash entry.
        const closing = get();
        if (
          tab.kind === "file" &&
          closing.selectedPath === tab.path &&
          (closing.editorStatus === "dirty" ||
            closing.editorStatus === "conflict" ||
            closing.editorStatus === "saving")
        ) {
          stash.set(tab.path, {
            buffer: closing.buffer,
            savedContent: closing.savedContent,
            status: closing.editorStatus === "conflict" ? "conflict" : "dirty",
          });
        }

        // If we closed the active tab, activate a neighbor (prefer the left
        // one); selectFile's stash-on-leave preserves any unsaved edits. When
        // it was the LAST tab, stash explicitly before resetting the editor —
        // closeEditor alone would silently drop a dirty buffer.
        if (tabsEqual(get().activeTab, tab)) {
          if (next.length === 0) {
            closeEditor();
            set({ activeTab: null });
          } else {
            const neighbor =
              next[idx - 1] ?? next[idx] ?? next[next.length - 1];
            get().activateTab(neighbor);
          }
        }
        if (root) syncTabs();
        syncDirtyPaths();
      },

      activateTab(tab: Tab) {
        const root = activeRoot();
        const tabs = root ? (tabsByRoot.get(root) ?? []) : get().openTabs;
        if (
          !tabs.some((candidate) => tabsEqual(candidate, tab))
        )
          return;
        if (tab.kind === "file" && root) void get().selectFile(tab.path);
        else set({ activeTab: tab });
      },

      openGithubTab() {
        const root = get().rootPath;
        if (!root) return;
        const github: Tab = { kind: "github" };
        const tabs = tabsByRoot.get(root) ?? [];
        if (!tabs.some((tab) => tabsEqual(tab, github))) {
          tabsByRoot.set(root, [...tabs, github]);
          syncTabs();
        }
        set({ activeTab: github });
      },

      openReviewTab() {
        const root = get().rootPath;
        if (!root) return;
        const review: Tab = { kind: "review" };
        const tabs = tabsByRoot.get(root) ?? [];
        if (!tabs.some((tab) => tabsEqual(tab, review))) {
          tabsByRoot.set(root, [...tabs, review]);
          syncTabs();
        }
        set({ activeTab: review });
      },

      openKodworkTab(taskId: string) {
        const root = get().rootPath;
        if (!root || !taskId) return;
        const kodwork: Tab = { kind: "kodwork", taskId };
        const tabs = tabsByRoot.get(root) ?? [];
        if (!tabs.some((tab) => tabsEqual(tab, kodwork))) {
          tabsByRoot.set(root, [...tabs, kodwork]);
          syncTabs();
        }
        set({ activeTab: kodwork });
      },

      openRemoteFilesTab(host: string, path: string) {
        const root = activeRoot();
        if (!host || !path) return;
        const remote: Tab = { kind: "remote-files", host, path };
        const tabs = root ? (tabsByRoot.get(root) ?? []) : get().openTabs;
        if (!tabs.some((tab) => tabsEqual(tab, remote))) {
          const next = [...tabs, remote];
          if (root) {
            tabsByRoot.set(root, next);
            syncTabs();
          } else {
            set({ openTabs: next });
          }
        }
        set({ activeTab: remote });
      },

      openRemotePreviewTab(host: string, path: string) {
        const root = activeRoot();
        if (!host || !path) return;
        const remote: Tab = { kind: "remote-preview", host, path };
        const tabs = root ? (tabsByRoot.get(root) ?? []) : get().openTabs;
        if (!tabs.some((tab) => tabsEqual(tab, remote))) {
          const next = [...tabs, remote];
          if (root) {
            tabsByRoot.set(root, next);
            syncTabs();
          } else {
            set({ openTabs: next });
          }
        }
        set({ activeTab: remote });
      },

      openBrowserTab() {
        const root = get().rootPath;
        if (!root) return;
        const tabs = tabsByRoot.get(root) ?? [];
        const existing = tabs.find((tab) => tab.kind === "browser");
        const browser: Tab = existing ?? { kind: "browser", url: "" };
        if (!existing) {
          tabsByRoot.set(root, [...tabs, browser]);
          syncTabs();
        }
        set({ activeTab: browser });
      },

      setBrowserUrl(url: string) {
        const root = get().rootPath;
        const active = get().activeTab;
        if (!root || active?.kind !== "browser") return;
        const browser: Tab = { kind: "browser", url };
        tabsByRoot.set(
          root,
          (tabsByRoot.get(root) ?? []).map((tab) =>
            tab.kind === "browser" ? browser : tab,
          ),
        );
        set({ activeTab: browser });
        syncTabs();
      },

      cycleTab(direction: 1 | -1) {
        const root = activeRoot();
        const tabs = root ? (tabsByRoot.get(root) ?? []) : get().openTabs;
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((tab) => tabsEqual(tab, get().activeTab));
        const from = idx === -1 ? (direction === 1 ? -1 : 0) : idx;
        const next = (from + direction + tabs.length) % tabs.length;
        get().activateTab(tabs[next]);
      },

      toggleActiveTabMode() {
        const active = get().activeTab;
        const path = active?.kind === "file" ? active.path : null;
        if (!path || !isMarkdownFile(path)) return;
        const current = get().tabModes[path] ?? defaultEditorMode(path);
        setTabMode(path, current === "view" ? "edit" : "view");
      },

      getTabsForRoot(root: string): Tab[] {
        return tabsByRoot.get(root) ?? [];
      },

      dropTabsForRoot(root: string) {
        // Forget this root's persisted tab closure entry. If it's the active
        // root, also clear the visible openTabs so the strip empties immediately.
        // (Persistence is owned by the projects store, which drops the removed
        // project's openTabs entry in the same removeProject flow — we don't fire
        // onTabsChanged here, that would re-persist a root that no longer exists.)
        const had = tabsByRoot.delete(root);
        tabModesByRoot.delete(root);
        if (!had) return;
        if (activeRoot() === root)
          set({ openTabs: [], activeTab: null, tabModes: {} });
      },

      async restoreTabs(root: string, paths: string[]) {
        // Seed a root's tabs from persistence. Text and supported viewer files
        // survive; missing, unknown binary, and too-large files drop gracefully.
        if (activeRoot() !== root) return;
        // Capture the root generation at the start. A restore paused in readFile
        // can survive an A→B→A switch (rootPath is /repo again, but it's a NEWER
        // /repo generation with its own watcher/tree). Bail after every await if
        // the generation moved so a stale restore can't clobber the new root.
        const gen = rootGen;
        // Snapshot the tab list we're restoring onto. If the user opens/closes a
        // tab DURING the restore (same generation, live tab activity), the list
        // diverges from this snapshot — their state wins, so we yield instead of
        // publishing our stale `valid` over it.
        const startTabs = tabsByRoot.get(root) ?? [];
        // De-dupe while preserving order; ignore empties.
        const seen = new Set<string>();
        const wanted = decodeTabs(paths).filter((tab) => {
          const key = encodeTab(tab);
          if (
            seen.has(key) ||
            (tab.kind === "file" && !isRestorablePathUnderRoot(tab.path, root))
          )
            return false;
          seen.add(key);
          return true;
        });

        const valid: Tab[] = [];
        for (const tab of wanted) {
          if (tab.kind !== "file") {
            valid.push(tab);
            continue;
          }
          try {
            const read = await deps.files.readFile(tab.path);
            if (
              read.kind === "text" ||
              (read.kind === "binary" && viewerKind(tab.path))
            ) {
              valid.push(tab);
            }
          } catch {
            /* unreadable/deleted — drop this tab */
          }
          if (activeRoot() !== root || gen !== rootGen) return; // superseded
        }

        // A newer root generation took over while we were reading, or the user
        // touched tabs mid-restore — either way, don't publish stale state.
        if (activeRoot() !== root || gen !== rootGen) return;
        const nowTabs = tabsByRoot.get(root) ?? [];
        if (
          nowTabs.length !== startTabs.length ||
          nowTabs.some((tab, i) => !tabsEqual(tab, startTabs[i]))
        ) {
          return; // user opened/closed tabs during restore — their state wins
        }

        tabsByRoot.set(root, valid);
        syncTabs();
        // Activate the last valid tab (mirrors "most recently open"); if none
        // survived, leave the editor empty.
        if (valid.length > 0 && get().activeTab === null) {
          get().activateTab(valid[valid.length - 1]);
        }
      },
    };

    // Follow a rename across ALL dirty bookkeeping, not just the open file. A
    // rename of `from` to `to` (a file, or an ancestor dir carrying descendants)
    // must remap every stash key, the open selection, lastSaved, and any
    // in-flight save path that sits at `from` or beneath it — otherwise a
    // background dirty file loses its stash+dot across the rename, or an
    // in-flight save strands in "saving" (Fixes 4 + 7). Editor buffer/status are
    // untouched. Remapping is component-aware (remapPath): /a/b never matches
    // /a/bee.
    function followRename(from: string, to: string) {
      // Remap every stash entry whose key is `from` or a descendant of it.
      for (const key of [...stash.keys()]) {
        const next = remapPath(key, from, to);
        if (next && next !== key) {
          const val = stash.get(key)!;
          stash.delete(key);
          stash.set(next, val);
        }
      }
      // Move the self-save echo bookkeeping with its file.
      if (lastSaved) {
        const next = remapPath(lastSaved.path, from, to);
        if (next) lastSaved.path = next;
      }
      // Move an in-flight save's tracked path so its completion reconciles
      // against the new location instead of stranding in "saving" (Fix 7).
      if (savingPath) {
        const next = remapPath(savingPath, from, to);
        if (next) savingPath = next;
      }
      // Swap the open selection if it (or its ancestor dir) was renamed.
      const open = get().selectedPath;
      if (open) {
        const next = remapPath(open, from, to);
        if (next && next !== open) set({ selectedPath: next });
      }
      // Remap every open tab under `from` to its new path so the tab strip shows
      // the new name/path (active tab included). Tabs only ever belong to the
      // active root, so only that root's list can carry the renamed file. If any
      // path moved, mirror the list into state and fire onTabsChanged so
      // persistence follows the rename.
      const root = activeRoot();
      if (root) {
        const tabs = tabsByRoot.get(root) ?? [];
        let changed = false;
        const remapped = tabs.map((tab) => {
          if (tab.kind !== "file") return tab;
          const next = remapPath(tab.path, from, to);
          if (next && next !== tab.path) {
            changed = true;
            return { kind: "file", path: next } satisfies Tab;
          }
          return tab;
        });
        if (changed) {
          tabsByRoot.set(root, remapped);
          const modes = tabModesByRoot.get(root) ?? {};
          const remappedModes: Record<string, EditorMode> = {};
          for (const [path, mode] of Object.entries(modes)) {
            remappedModes[remapPath(path, from, to) ?? path] = mode;
          }
          tabModesByRoot.set(root, remappedModes);
          set({ tabModes: remappedModes });
          const active = get().activeTab;
          if (active?.kind === "file") {
            const next = remapPath(active.path, from, to);
            if (next) set({ activeTab: { kind: "file", path: next } });
          }
          syncTabs();
        }
      }
      // dirtyPaths mirrors the stash keys, which just moved.
      syncDirtyPaths();
    }
  });
}

// Is `path` inside directory `dir` (a strict descendant)?
function isUnder(path: string, dir: string): boolean {
  return nativeIsDescendant(path, dir);
}

// Restored tab paths are persisted data, so normalize lexical traversal before
// admitting them under the active root. The native handler remains the final
// canonical/symlink authority when it serves a document.
function isRestorablePathUnderRoot(path: string, root: string): boolean {
  return isUnder(normalizeAbsolutePath(path), normalizeAbsolutePath(root));
}

function normalizeAbsolutePath(path: string): string {
  return normalizeNativeAbsolutePath(path);
}

// If `path` is exactly `from` or a component-wise descendant of it, return the
// path with the `from` prefix swapped to `to`; otherwise null. Component-aware,
// so a rename of /a/b never remaps /a/bee (a plain startsWith would). Shared by
// followRename and trash cleanup.
export function remapPath(
  path: string,
  from: string,
  to: string,
): string | null {
  return remapNativePath(path, from, to);
}

// Join a parent dir and child name without changing the native path style.
function joinPath(parent: string, name: string): string {
  return nativeJoin(parent, name);
}

// Validate a new/renamed entry name against the store's current tree. Returns an
// error message or null. Pure so the inline-edit flow is fully testable.
function validateName(
  state: FilesState,
  edit: FileEdit,
  raw: string,
): string | null {
  const nativeError = validateNativeName(raw, edit.parent);
  if (nativeError) return nativeError;
  const name = raw.trim();
  if (name === "") return "name cannot be empty";
  if (name === "." || name === "..") return "invalid name";
  // A rename to the same name is a no-op, not a collision.
  const targetName = edit.target ? baseName(edit.target) : null;
  const targetPath = joinPath(edit.parent, name);
  if (
    edit.kind === "rename" &&
    edit.target &&
    (name === targetName || nativeEquals(targetPath, edit.target))
  ) {
    return null;
  }
  // Collision with an existing sibling in the parent's loaded listing.
  const siblings = state.children[edit.parent] ?? [];
  if (siblings.some((entry) => nativeEquals(entry.path, targetPath))) {
    return "a file with this name already exists";
  }
  return null;
}

// Final path component.
function baseName(path: string): string {
  return nativeBasename(path);
}

// Does an entry survive the name filter? A file matches on its own name; a
// directory matches on its own name OR if any LOADED descendant matches (so the
// path to a hit stays navigable). `needle` is expected already-lowercased and
// trimmed; an empty needle matches everything. Pure, so the tree's filtering is
// testable without a DOM. Shared by the FileTreePane view.
export function filterMatches(
  entry: DirEntry,
  needle: string,
  children: Record<string, DirEntry[]>,
): boolean {
  if (needle === "") return true;
  if (entry.name.toLowerCase().includes(needle)) return true;
  if (!entry.isDir) return false;
  const kids = children[entry.path];
  if (!kids) return false; // not loaded — can't claim a hidden hit
  return kids.some((k) => filterMatches(k, needle, children));
}

// Is `path` a known directory in the current tree? A dir is known if it's the
// root, if we've already loaded/expanded it, or if it appears as an isDir entry
// in any loaded parent listing. Used to keep directories out of the file-read
// path at the store level (defense in depth beside the component's routing).
function isKnownDir(state: FilesState, path: string): boolean {
  if (path === state.rootPath) return true;
  if (path in state.children || path in state.expanded) return true;
  for (const entries of Object.values(state.children)) {
    for (const e of entries) {
      if (e.path === path) return e.isDir;
    }
  }
  return false;
}

// Parent directory of an absolute native path returned by Rust.
function parentDir(path: string): string | null {
  return nativeDirname(path);
}
