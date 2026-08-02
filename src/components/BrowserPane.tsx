import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useStore } from "zustand";
import { filesStore } from "../store/appStore";
import { settingsViewStore } from "../store/settingsView";
import { browser as tauriBrowser } from "../ipc/transport";
import type { BrowserBounds } from "../ipc/contract";
import { normalizeBrowserUrl } from "../browser/url";
import { EDITOR_BROWSER_ID } from "../browser/constants";
import { browserViewportDecision } from "../browser/visibility";
import {
  browserCreateReducer,
  initialBrowserCreateState,
} from "../browser/recovery";

export function BrowserPane({ url }: { url: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const boundsRef = useRef<BrowserBounds | null>(null);
  const createAttemptRef = useRef(0);
  const visibilityAttemptRef = useRef(0);
  const settingsOpen = useStore(
    settingsViewStore,
    (state) => state.section !== null,
  );
  const [draft, setDraft] = useState(url);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createState, dispatchCreate] = useReducer(
    browserCreateReducer,
    initialBrowserCreateState,
  );

  const createAtCurrentBounds = useCallback(async () => {
    const bounds = boundsRef.current;
    if (!url || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    if (settingsViewStore.getState().section !== null) {
      await tauriBrowser.hide(EDITOR_BROWSER_ID).catch(() => undefined);
      return;
    }
    const attempt = ++createAttemptRef.current;
    dispatchCreate({ type: "start", attempt });
    try {
      await tauriBrowser.create(EDITOR_BROWSER_ID, url, bounds);
      const hideIfCovered = async () => {
        if (settingsViewStore.getState().section !== null) {
          await tauriBrowser.hide(EDITOR_BROWSER_ID).catch(() => undefined);
        }
      };
      await hideIfCovered();
      const projectRoot = filesStore.getState().rootPath;
      try {
        if (projectRoot) await tauriBrowser.agentReady(projectRoot);
      } finally {
        await hideIfCovered();
      }
      dispatchCreate({ type: "success", attempt });
    } catch (err) {
      dispatchCreate({ type: "failure", attempt, error: String(err) });
    }
  }, [url]);

  useEffect(() => setDraft(url), [url]);

  useEffect(() => {
    let frame = 0;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      frame = 0;
      const rect = viewport.getBoundingClientRect();
      const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      boundsRef.current = bounds;
      const attempt = ++visibilityAttemptRef.current;
      const decision = browserViewportDecision(url, bounds, settingsOpen);
      if (decision === "hide") {
        void tauriBrowser.hide(EDITOR_BROWSER_ID).catch(() => undefined);
      } else if (decision === "place") {
        // A visible child normally exists already. If it was destroyed while
        // this pane was collapsed, idempotent create restores it in-place.
        void tauriBrowser
          .setBounds(EDITOR_BROWSER_ID, bounds)
          .then(() => {
            if (
              attempt !== visibilityAttemptRef.current ||
              settingsViewStore.getState().section !== null
            ) {
              return;
            }
            return tauriBrowser.show(EDITOR_BROWSER_ID);
          })
          .catch(() => {
            if (
              attempt === visibilityAttemptRef.current &&
              settingsViewStore.getState().section === null
            ) {
              return createAtCurrentBounds();
            }
          });
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      ++visibilityAttemptRef.current;
    };
  }, [createAtCurrentBounds, settingsOpen, url]);

  useEffect(() => {
    if (!url) {
      void tauriBrowser.destroy(EDITOR_BROWSER_ID).catch(() => undefined);
      return;
    }
    const frame = requestAnimationFrame(() => {
      void createAtCurrentBounds();
    });
    return () => cancelAnimationFrame(frame);
  }, [createAtCurrentBounds, url]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void tauriBrowser.onNavigated((event) => {
      if (event.id !== EDITOR_BROWSER_ID) return;
      filesStore.getState().setBrowserUrl(event.url);
      setDraft(event.url);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
      void tauriBrowser.agentReady(null).catch(() => undefined);
      void tauriBrowser.hide(EDITOR_BROWSER_ID).catch(() => undefined);
    };
  }, []);

  const go = () => {
    const normalized = normalizeBrowserUrl(draft);
    if (!normalized) {
      setActionError("enter an http or https url");
      return;
    }
    setActionError(null);
    const bounds = boundsRef.current;
    if (!bounds) return;
    filesStore.getState().setBrowserUrl(normalized);
  };

  const action = (run: () => Promise<void>) => {
    setActionError(null);
    void run().catch((err) => setActionError(String(err)));
  };

  const error = actionError ?? createState.error;

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col bg-bg">
      <form
        className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-surface px-2"
        onSubmit={(event) => { event.preventDefault(); go(); }}
      >
        <ChromeButton label="back" onClick={() => action(() => tauriBrowser.back(EDITOR_BROWSER_ID))}>←</ChromeButton>
        <ChromeButton label="forward" onClick={() => action(() => tauriBrowser.forward(EDITOR_BROWSER_ID))}>→</ChromeButton>
        <ChromeButton label="reload" onClick={() => action(() => tauriBrowser.reload(EDITOR_BROWSER_ID))}>↻</ChromeButton>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="url"
          placeholder="example.com"
          className="mx-1 min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent"
        />
        <button type="submit" className="rounded px-2 py-1 text-xs text-text-dim hover:bg-surface-hover hover:text-text">go</button>
      </form>
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs text-[var(--kd-error)]">
          <span className="min-w-0 flex-1">{error}</span>
          {!actionError && createState.error && url && (
            <button
              type="button"
              disabled={createState.pending}
              onClick={() => void createAtCurrentBounds()}
              className="rounded border border-[var(--kd-error)] px-2 py-0.5 disabled:opacity-50"
            >
              {createState.pending ? "retrying…" : "retry"}
            </button>
          )}
        </div>
      )}
      <div ref={viewportRef} className="relative min-h-0 flex-1">
        {!url && <div className="absolute inset-0 flex items-center justify-center text-xs text-text-dim">enter a url</div>}
      </div>
    </div>
  );
}

function ChromeButton({ label, onClick, children }: { label: string; onClick(): void; children: string }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded text-sm text-text-dim hover:bg-surface-hover hover:text-text">{children}</button>;
}
