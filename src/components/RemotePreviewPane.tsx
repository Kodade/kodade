// KödSSH remote file preview pane (M11d, Pro): a READ-ONLY CodeMirror view of
// one remote file's capped content, rendered as the "remote-preview" tab's
// content in EditorPane. Editing remote files is out of scope: this view has
// no update listener, no save
// keymap, nothing that writes back.

import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { remoteFilesStore as defaultRemoteFilesStore, themeStore } from "../store/appStore";
import type { RemoteFilesState } from "../store/remoteFiles";
import { loadLanguage } from "../editor/language";
import { toCodeMirrorTheme } from "../themes/applier";
import { remoteBasename } from "../ssh/remoteTree";
import { entitlements as defaultEntitlements, type Entitlements } from "../app/entitlements";
import type { StoreApi } from "zustand/vanilla";

export function RemotePreviewPane({
  host,
  path,
  store = defaultRemoteFilesStore,
  entitlements = defaultEntitlements,
}: {
  host: string;
  path: string;
  store?: StoreApi<RemoteFilesState>;
  entitlements?: Entitlements;
}) {
  const state = useStore(store);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Subscribing (rather than a one-shot getState read) keeps the preview's
  // colors live across theme switches: the build effect below depends on it,
  // and a full rebuild is fine for a read-only view (no compartment needed).
  const resolvedTheme = useStore(themeStore, (s) => s.resolved);
  const key = `${host}\0${path}`;
  const preview = state.previews[key];

  // Same defense-in-depth posture as RemoteFilesPane: a persisted tab could
  // outlive a downgraded entitlement.
  const entitled = entitlements.hasFeature("ssh.pro");

  useEffect(() => {
    if (!entitled) return;
    if (!preview) void store.getState().fetchPreview(host, path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitled, host, path]);

  // Build a read-only CodeMirror view once the content is ready. Rebuilt on
  // every distinct file (host+path) — previews aren't edited, so there's no
  // buffer-sync effect to maintain like EditorPane's editable view.
  useEffect(() => {
    if (!entitled || preview?.status !== "ready" || !hostRef.current) return;
    let disposed = false;
    void (async () => {
      const lang = await loadLanguage(remoteBasename(path));
      if (disposed || !hostRef.current) return;
      viewRef.current?.destroy();
      const view = new EditorView({
        state: EditorState.create({
          doc: preview.content,
          extensions: [
            lineNumbers(),
            EditorView.editable.of(false),
            EditorState.readOnly.of(true),
            toCodeMirrorTheme(resolvedTheme),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            EditorView.lineWrapping,
            EditorView.theme({
              "&": { height: "100%", maxWidth: "100%" },
              ".cm-scroller": { overflow: "auto" },
            }),
            ...(lang ? [lang] : []),
          ],
        }),
        parent: hostRef.current,
      });
      viewRef.current = view;
    })();
    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entitled,
    preview?.status,
    preview?.status === "ready" ? preview.content : null,
    path,
    resolvedTheme, // theme switch rebuilds the read-only view with new colors
  ]);

  if (!entitled) {
    return <Placeholder text="Remote file preview is a kodade Pro feature." />;
  }

  return (
    <section className="flex h-full min-w-0 flex-col bg-bg">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-[11px] text-text-dim">
        <span className="min-w-0 flex-1 truncate">
          <span className="text-text">{host}</span>:{path}
        </span>
        <span className="shrink-0 rounded border border-border px-1.5 py-0.5">read-only</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {!preview || preview.status === "pending" ? (
          <Placeholder text={`Loading from ${host}…`} />
        ) : preview.status === "failed" ? (
          <Placeholder text={`Could not read file on ${host}: ${preview.reason}`} />
        ) : preview.status === "binary" ? (
          <Placeholder text="Binary file — no preview" />
        ) : (
          <>
            {preview.truncated && (
              <p role="status" className="shrink-0 border-b border-border bg-surface px-3 py-1 text-[11px] text-[var(--kd-warning)]">
                preview truncated at the size cap
              </p>
            )}
            <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
          </>
        )}
      </div>
    </section>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
      <p className="text-sm text-text-dim">{text}</p>
    </div>
  );
}
