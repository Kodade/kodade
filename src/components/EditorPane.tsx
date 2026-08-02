import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { filesStore, themeStore } from "../store/appStore";
import { loadLanguage, viewerKind } from "../editor/language";
import { toCodeMirrorTheme } from "../themes/applier";
import { labelFor } from "../shortcuts/bindings";
import { TabStrip } from "./TabStrip";
import { isMarkdownFile } from "../store/files";
import { openMarkdownLink, rawAllowedAnchorHref } from "../markdown/links";
import { renderMarkdown } from "../markdown/render";
import type { FileRead } from "../ipc/contract";
import { GithubPane } from "./GithubPane";
import { BrowserPane } from "./BrowserPane";
import { ReviewPane } from "./ReviewPane";
import { RemoteFilesPane } from "./RemoteFilesPane";
import { RemotePreviewPane } from "./RemotePreviewPane";
import { nativeBasename } from "../platform/native-path";

// Editable CodeMirror over the files store's open text file (M4b). The store
// owns the dirty/save/conflict state machine; this pane is a thin view:
//  - edits flow up via an update listener → store.setBuffer
//  - Mod+S saves via a local keymap binding; the global shortcut dispatcher
//    (M6a) defers save to this keymap while the editor is focused, so they
//    coexist without double-firing (see src/shortcuts/dispatcher.ts)
//  - external buffer changes (reload/keepMine) are pushed back into the view
//  - a dirty dot + a conflict banner reflect the store's editorStatus
export function EditorPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Observes the host so the view re-measures on pane resize/collapse/restore.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Theme lives in its own compartment so it reconfigures live (no view rebuild)
  // when the app theme changes — the one editor touch M5 needs.
  const themeCompartment = useRef(new Compartment());

  const selectedPath = useStore(filesStore, (s) => s.selectedPath);
  const fileContent = useStore(filesStore, (s) => s.fileContent);
  const loading = useStore(filesStore, (s) => s.loading);
  const buffer = useStore(filesStore, (s) => s.buffer);
  const editorStatus = useStore(filesStore, (s) => s.editorStatus);
  const saveError = useStore(filesStore, (s) => s.saveError);
  const deletedOnDisk = useStore(filesStore, (s) => s.deletedOnDisk);
  const activeTab = useStore(filesStore, (s) => s.activeTab);
  const tabModes = useStore(filesStore, (s) => s.tabModes);

  const isText = fileContent?.kind === "text";
  const viewer = selectedPath ? viewerKind(selectedPath) : null;
  const isMarkdown = selectedPath !== null && isMarkdownFile(selectedPath);
  const editorMode = selectedPath ? (tabModes[selectedPath] ?? "view") : "view";
  const showEditor = isText && !viewer && (!isMarkdown || editorMode === "edit");
  const isDirty = editorStatus === "dirty" || editorStatus === "conflict";

  // (Re)build the CodeMirror view when a different text file is opened. Keyed on
  // selectedPath (not content) so typing doesn't tear down the view — the buffer
  // now flows through the store. Language loads lazily by extension.
  useEffect(() => {
    if (!isText || !selectedPath || viewer) return;

    let disposed = false;
    void (async () => {
      const lang = await loadLanguage(selectedPath);
      if (disposed || !hostRef.current) return;

      viewRef.current?.destroy();
      // Push editor changes up to the store; skip programmatic doc swaps (below).
      const syncUp = EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((t) => t.annotation(fromStore))) {
          filesStore.getState().setBuffer(u.state.doc.toString());
        }
      });
      const saveKey = keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void filesStore.getState().saveFile();
            return true; // handled
          },
        },
      ]);

      const extensions = [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        saveKey,
        syncUp,
        // Theme from the app token system, in a compartment for live swaps;
        // default highlight style stays as a fallback for unstyled tags.
        themeCompartment.current.of(toCodeMirrorTheme(themeStore.getState().resolved)),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        // Constrain the editor to the pane: the scroller (not the page) scrolls,
        // and max-width:100% keeps long code lines from painting past the pane.
        EditorView.theme({
          "&": { height: "100%", maxWidth: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
        EditorView.lineWrapping,
      ];
      if (lang) extensions.push(lang);

      const view = new EditorView({
        // Seed from the store's current buffer (open resets it to disk content).
        state: EditorState.create({ doc: filesStore.getState().buffer, extensions }),
        parent: hostRef.current,
      });
      viewRef.current = view;

      // Reflow on pane resize/collapse/restore. CodeMirror usually re-measures on
      // its own, but a flex/panel resize doesn't always trip that — a
      // ResizeObserver on the host forces requestMeasure() so wrapping and the
      // scroller track the new width.
      const ro = new ResizeObserver(() => {
        // A hidden Markdown editor has no useful dimensions to measure; the
        // showEditor effect below remeasures it as soon as it returns onscreen.
        if (hostRef.current?.offsetParent) view.requestMeasure();
      });
      ro.observe(hostRef.current);
      resizeObserverRef.current = ro;
    })();

    return () => {
      disposed = true;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // Rebuild only on file switch — content is driven through the buffer effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, isText, viewer]);

  // The Markdown view hides rather than unmounts CodeMirror, preserving its
  // history, selection, and scroll position. A display:none host reports zero
  // dimensions to ResizeObserver, so explicitly remeasure once it is visible.
  useEffect(() => {
    if (!showEditor) return;
    const frame = requestAnimationFrame(() => viewRef.current?.requestMeasure());
    return () => cancelAnimationFrame(frame);
  }, [showEditor]);

  // Reconcile the view when the buffer changes in the store from outside the
  // editor (reload-from-disk, keep-mine, or a clean auto-reload). We annotate
  // the transaction so the update listener doesn't echo it back as a user edit.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === buffer) return; // already in sync (user edit)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: buffer },
      annotations: fromStore.of(true),
    });
  }, [buffer]);

  // Live editor re-theme: when the resolved theme changes, reconfigure the
  // theme compartment on the current view (no rebuild, no scroll jump).
  useEffect(() => {
    let lastId = themeStore.getState().resolved.id;
    return themeStore.subscribe((s) => {
      if (s.resolved.id === lastId) return; // ignore unrelated store updates
      lastId = s.resolved.id;
      viewRef.current?.dispatch({
        effects: themeCompartment.current.reconfigure(toCodeMirrorTheme(s.resolved)),
      });
    });
  }, []);

  return (
    <section className="flex h-full min-w-0 flex-col bg-bg">
      {/* The strip is always the pane header so its right-edge kind launchers
          remain available even before a file is open. */}
      <TabStrip />

      <div
        className={`min-h-0 flex-1 flex-col ${activeTab?.kind !== "file" && activeTab !== null ? "hidden" : "flex"}`}
      >
        {/* Slim status line: only surfaces the save hint / saving state, since
            the tab already carries the filename and dirty dot. */}
        {isText && (isDirty || editorStatus === "saving") && (
          <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-1 text-xs text-text-dim">
            {isDirty && (
              <span className="shrink-0">{labelFor("save-file")} to save</span>
            )}
            {editorStatus === "saving" && <span className="text-text-dim">saving…</span>}
          </div>
        )}

        {/* Conflict banner: the file changed on disk under unsaved edits. Inline,
            no modal — the user picks reload or keep. */}
        {editorStatus === "conflict" && (
          <div className="flex items-center gap-3 border-b border-[color-mix(in_srgb,var(--kd-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--kd-warning)_10%,transparent)] px-4 py-2 text-xs text-[var(--kd-warning)]">
            <span className="flex-1">
              {deletedOnDisk
                ? "This file was deleted on disk while you had unsaved edits."
                : "This file changed on disk while you had unsaved edits."}
            </span>
            <button
              type="button"
              className="rounded border border-[color-mix(in_srgb,var(--kd-warning)_55%,transparent)] px-2 py-1 hover:bg-[color-mix(in_srgb,var(--kd-warning)_16%,transparent)]"
              onClick={() => filesStore.getState().reloadFromDisk()}
            >
              {/* When deleted, there's nothing to reload — this closes the file. */}
              {deletedOnDisk ? "Close file" : "Reload from disk"}
            </button>
            <button
              type="button"
              className="rounded border border-[color-mix(in_srgb,var(--kd-warning)_55%,transparent)] px-2 py-1 hover:bg-[color-mix(in_srgb,var(--kd-warning)_16%,transparent)]"
              onClick={() => filesStore.getState().keepMine()}
            >
              {deletedOnDisk ? "Keep my version (re-create)" : "Keep my version"}
            </button>
          </div>
        )}

        {/* Save error banner: a failed write (read-only file, missing dir). The
            buffer is never lost — the user can fix perms and retry. */}
        {saveError && (
          <div className="border-b border-[color-mix(in_srgb,var(--kd-error)_45%,transparent)] bg-[color-mix(in_srgb,var(--kd-error)_10%,transparent)] px-4 py-2 text-xs text-[var(--kd-error)]">
            Could not save: {saveError}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {isText && (
            <div
              ref={hostRef}
              className={`absolute inset-0 overflow-hidden ${showEditor ? "" : "hidden"}`}
            />
          )}
          {isText && isMarkdown && editorMode === "view" && (
            <MarkdownView markdown={buffer} />
          )}
          {selectedPath && viewer === "image" && fileContent && fileContent.kind !== "tooLarge" && (
            <ImageViewer path={selectedPath} bytes={viewerBytes(fileContent)} />
          )}
          {selectedPath && viewer === "pdf" && fileContent && fileContent.kind !== "tooLarge" && (
            <PdfViewer path={selectedPath} bytes={viewerBytes(fileContent)} />
          )}
          {!selectedPath && <Placeholder text="Select a file to view it here" />}
          {loading && selectedPath && <Placeholder text="Loading…" />}
          {fileContent?.kind === "tooLarge" && (
            <Placeholder
              text={`File too large to preview (${formatBytes(fileContent.bytes)})`}
            />
          )}
          {fileContent?.kind === "binary" && !viewer && <Placeholder text="Binary file — no preview" />}
        </div>
      </div>
      {activeTab?.kind === "github" && (
        <div className="relative min-h-0 flex-1">
          <GithubPane />
        </div>
      )}
      {activeTab?.kind === "browser" && (
        <div className="relative min-h-0 flex-1">
          <BrowserPane url={activeTab.url} />
        </div>
      )}
      {activeTab?.kind === "review" && (
        <div className="relative min-h-0 flex-1">
          <ReviewPane />
        </div>
      )}
      {activeTab?.kind === "remote-files" && (
        <div className="relative min-h-0 flex-1">
          <RemoteFilesPane host={activeTab.host} path={activeTab.path} />
        </div>
      )}
      {activeTab?.kind === "remote-preview" && (
        <div className="relative min-h-0 flex-1">
          <RemotePreviewPane host={activeTab.host} path={activeTab.path} />
        </div>
      )}
    </section>
  );
}

function MarkdownView({ markdown }: { markdown: string }) {
  const html = renderMarkdown(markdown);

  return (
    <div className="absolute inset-0 overflow-auto">
      <article
        className="markdown-view"
        onClick={(event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const link = target.closest<HTMLAnchorElement>("a");
          if (!link) return;
          event.preventDefault();
          const href = rawAllowedAnchorHref(link);
          if (href) void openMarkdownLink(href);
        }}
        // renderMarkdown disables raw Markdown HTML and sanitizes its output.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function ImageViewer({ path, bytes }: { path: string; bytes: number }) {
  return (
    <figure className="document-image-stage absolute inset-0 flex min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {/* SVG stays an inert image resource; never insert its markup into the DOM. */}
        <img src={documentUrl(path)} alt={fileName(path)} className="max-h-full max-w-full object-contain" />
      </div>
      <DocumentMeta path={path} bytes={bytes} />
    </figure>
  );
}

function PdfViewer({ path, bytes }: { path: string; bytes: number }) {
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-surface">
      <div className="min-h-0 flex-1">
        <embed src={documentUrl(path)} type="application/pdf" title={fileName(path)} className="block h-full w-full" />
      </div>
      <DocumentMeta path={path} bytes={bytes} />
    </div>
  );
}

function DocumentMeta({ path, bytes }: { path: string; bytes: number }) {
  return (
    <div className="shrink-0 border-t border-border bg-surface px-3 py-1.5 text-xs text-text-dim">
      {fileName(path)} <span aria-hidden="true">·</span> {formatBytes(bytes)}
    </div>
  );
}

function documentUrl(path: string): string {
  return `kodade-doc://localhost/?path=${encodeURIComponent(path)}`;
}

function viewerBytes(fileContent: FileRead | null): number {
  if (!fileContent) return 0;
  if (fileContent.kind === "binary" || fileContent.kind === "tooLarge") {
    return fileContent.bytes ?? 0;
  }
  return new TextEncoder().encode(fileContent.content).length;
}

function fileName(path: string): string {
  return nativeBasename(path);
}

// Marks a doc change that originated from the store (reload/keep-mine/auto-reload)
// so the update listener doesn't bounce it back to setBuffer as a user edit.
const fromStore = Annotation.define<boolean>();

function Placeholder({ text }: { text: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <p className="text-sm text-text-dim">{text}</p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
