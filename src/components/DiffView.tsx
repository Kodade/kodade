import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, type DecorationSet } from "@codemirror/view";
import { themeStore } from "../store/appStore";
import { loadLanguage } from "../editor/language";
import { toCodeMirrorTheme } from "../themes/applier";
import type { DiffLine, FileDiff } from "../review/model";
import type { ReviewCommentEntry } from "../store/review";

// Line-comment wiring passed down from ReviewPane (Pro, M12e). `comments` is
// pre-filtered to this file; the callbacks are already bound to its path. When
// absent (free tier, or a scope with no send-to-agent), DiffView renders no
// comment UI at all — the diff-only render path is unchanged.
export type DiffCommenting = {
  comments: ReviewCommentEntry[];
  onAdd: (startLine: number, endLine: number, body: string) => void;
  onUpdate: (id: string, body: string) => void;
  onDelete: (id: string) => void;
};

// KödPR diff renderer (M12c). Renders one parsed FileDiff with CodeMirror 6
// read-only editors themed by the app token system, syntax-highlighted by file
// extension. Unified mounts one editor per file (the plan's "one editor per
// expanded file" cost guard); split mounts two (old | new) — the same parsed
// model, two layouts. Add/del line tints reuse the derived --kd-success/
// --kd-error status tokens via color-mix, so no new theme tokens are needed.

export type DiffViewMode = "unified" | "split";

// One display row: a source line, or a hunk-header separator between hunks.
type DiffRow = {
  kind: DiffLine["kind"] | "hunk";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

// Line-background tints. color-mix keeps them legible on both light and dark
// themes (same trick HarnessPane uses for its status chrome).
const ROW_STYLE: Record<DiffRow["kind"], string> = {
  add: "background-color: color-mix(in srgb, var(--kd-success) 16%, transparent)",
  del: "background-color: color-mix(in srgb, var(--kd-error) 16%, transparent)",
  context: "",
  hunk: "color: var(--kd-text-dim); background-color: var(--kd-surface)",
};

// Build the display rows for one side of the diff. "unified" keeps every line;
// "old" drops additions (left column); "new" drops deletions (right column).
function buildRows(file: FileDiff, side: "unified" | "old" | "new"): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of file.hunks) {
    rows.push({ kind: "hunk", text: hunk.header, oldLine: null, newLine: null });
    for (const line of hunk.lines) {
      if (side === "old" && line.kind === "add") continue;
      if (side === "new" && line.kind === "del") continue;
      rows.push({
        kind: line.kind,
        text: line.content,
        oldLine: line.oldLine,
        newLine: line.newLine,
      });
    }
  }
  return rows;
}

// The line number to show in the gutter for a row, given the column.
function lineNoFor(row: DiffRow, side: "unified" | "old" | "new"): string {
  if (row.kind === "hunk") return "";
  const n = side === "old" ? row.oldLine : side === "new" ? row.newLine : (row.newLine ?? row.oldLine);
  return n == null ? "" : String(n);
}

// A static decoration field: the doc never changes (read-only), so the line
// tints are computed once from the rows and returned unchanged on update.
function decorationsField(rows: DiffRow[]): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      const builder = [];
      for (let i = 0; i < rows.length && i < state.doc.lines; i++) {
        const row = rows[i];
        const style = ROW_STYLE[row.kind];
        const line = state.doc.line(i + 1);
        builder.push(
          Decoration.line({
            attributes: { "data-diff": row.kind, ...(style ? { style } : {}) },
          }).range(line.from),
        );
      }
      return Decoration.set(builder);
    },
    update(value) {
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return field;
}

// One read-only CodeMirror editor over a column's rows. Rebuilds on theme or row
// change (only expanded files reach here, so the cost is bounded).
function DiffColumn({
  rows,
  path,
  side,
}: {
  rows: DiffRow[];
  path: string;
  side: "unified" | "old" | "new";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const theme = useStore(themeStore, (s) => s.resolved);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let view: EditorView | null = null;

    void (async () => {
      const lang = await loadLanguage(path);
      if (disposed || !hostRef.current) return;
      const extensions: Extension[] = [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        lineNumbers({ formatNumber: (n) => lineNoFor(rows[n - 1] ?? rows[0], side) }),
        decorationsField(rows),
        toCodeMirrorTheme(theme),
        EditorView.theme({
          "&": { maxWidth: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ];
      if (lang) extensions.push(lang);
      view = new EditorView({
        state: EditorState.create({ doc: rows.map((r) => r.text).join("\n"), extensions }),
        parent: hostRef.current,
      });
    })();

    return () => {
      disposed = true;
      view?.destroy();
    };
  }, [rows, path, side, theme]);

  return <div ref={hostRef} className="min-w-0 overflow-hidden text-xs" data-diff-column={side} />;
}

export function DiffView({
  file,
  path,
  viewMode,
  commenting,
}: {
  file: FileDiff;
  path: string;
  viewMode: DiffViewMode;
  commenting?: DiffCommenting;
}) {
  const unifiedRows = useMemo(() => buildRows(file, "unified"), [file]);
  const oldRows = useMemo(() => buildRows(file, "old"), [file]);
  const newRows = useMemo(() => buildRows(file, "new"), [file]);

  if (file.hunks.length === 0) {
    // A modified file with no textual hunks (e.g. mode-only change).
    return <p className="px-3 py-2 text-xs text-text-dim">no line changes to show</p>;
  }

  const diff =
    viewMode === "split" ? (
      <div className="grid grid-cols-2 gap-px bg-border" data-diff-view="split">
        <div className="bg-bg">
          <DiffColumn rows={oldRows} path={path} side="old" />
        </div>
        <div className="bg-bg">
          <DiffColumn rows={newRows} path={path} side="new" />
        </div>
      </div>
    ) : (
      <div className="bg-bg" data-diff-view="unified">
        <DiffColumn rows={unifiedRows} path={path} side="unified" />
      </div>
    );

  if (!commenting) return diff;
  return (
    <div>
      {diff}
      <CommentThread file={file} commenting={commenting} />
    </div>
  );
}

// Changed (add/del) line numbers of a file, for the "comment on a line"
// selector — commenting on unchanged context isn't the workflow, so only
// touched lines are offered. Deduped, in ascending line order.
function changedLines(file: FileDiff): { line: number; kind: "add" | "del" }[] {
  const out: { line: number; kind: "add" | "del" }[] = [];
  const seen = new Set<number>();
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === "context") continue;
      const n = l.newLine ?? l.oldLine;
      if (n == null || seen.has(n)) continue;
      seen.add(n);
      out.push({ line: n, kind: l.kind });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// The per-file comment affordance: pick a changed line, write a comment; edit
// or delete existing ones inline. Plain-DOM form controls (no CodeMirror
// coupling), themed like the rest of the review pane.
function CommentThread({ file, commenting }: { file: FileDiff; commenting: DiffCommenting }) {
  const lines = useMemo(() => changedLines(file), [file]);
  const [adding, setAdding] = useState(false);
  const [line, setLine] = useState<number | null>(lines[0]?.line ?? null);
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");

  const submit = () => {
    if (line == null || !body.trim()) return;
    commenting.onAdd(line, line, body.trim());
    setBody("");
    setAdding(false);
  };

  const saveEdit = (id: string) => {
    if (!editBody.trim()) return;
    commenting.onUpdate(id, editBody.trim());
    setEditingId(null);
  };

  return (
    <div className="border-t border-border bg-surface px-3 py-2 text-xs" data-comment-thread>
      {commenting.comments.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1.5">
          {commenting.comments.map((c) => (
            <li key={c.id} className="rounded border border-border bg-bg px-2 py-1.5" data-comment>
              <div className="flex items-center justify-between gap-2 text-text-dim">
                <span className="tabular-nums">💬 line {c.startLine}</span>
                {editingId !== c.id && (
                  <span className="flex gap-2">
                    <button
                      type="button"
                      className="hover:text-text"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditBody(c.body);
                      }}
                    >
                      edit
                    </button>
                    <button type="button" className="hover:text-[var(--kd-error)]" onClick={() => commenting.onDelete(c.id)}>
                      delete
                    </button>
                  </span>
                )}
              </div>
              {editingId === c.id ? (
                <div className="mt-1 flex flex-col gap-1">
                  <textarea
                    aria-label="edit comment"
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    className="w-full resize-y rounded border border-border bg-bg px-2 py-1 text-text"
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover" onClick={() => saveEdit(c.id)}>
                      save
                    </button>
                    <button type="button" className="text-text-dim hover:text-text" onClick={() => setEditingId(null)}>
                      cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-0.5 whitespace-pre-wrap text-text">{c.body}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-text-dim">
            line
            <select
              aria-label="comment line"
              value={line ?? ""}
              onChange={(e) => setLine(Number(e.target.value))}
              className="rounded border border-border bg-bg px-1 py-0.5 text-text"
            >
              {lines.map((l) => (
                <option key={l.line} value={l.line}>
                  {l.kind === "add" ? "+" : "−"} {l.line}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="new comment"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="leave a comment for the agent…"
            className="w-full resize-y rounded border border-border bg-bg px-2 py-1 text-text"
            rows={2}
          />
          <div className="flex gap-2">
            <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover" onClick={submit}>
              save
            </button>
            <button type="button" className="text-text-dim hover:text-text" onClick={() => setAdding(false)}>
              cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={lines.length === 0}
          onClick={() => setAdding(true)}
          className="rounded border border-border px-2 py-0.5 text-text-dim hover:bg-surface-hover hover:text-text disabled:opacity-50"
        >
          add comment
        </button>
      )}
    </div>
  );
}
