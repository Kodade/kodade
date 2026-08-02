import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDiff } from "../review/model";
import type { ReviewCommentEntry } from "../store/review";
import { DiffView, type DiffCommenting } from "./DiffView";

// Flush the loadLanguage() → EditorView build chain (a couple of microtasks).
// A ".txt" path has no grammar in language.ts, so loadLanguage resolves null
// immediately and no heavy grammar import runs — the editor renders plain but
// still mounts lines + decorations, which is all these tests inspect.
async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
}

// One modified file with a context, a deletion, and an addition line.
function fileDiff(): FileDiff {
  return {
    oldPath: "a.txt",
    newPath: "a.txt",
    status: "modified",
    adds: 1,
    dels: 1,
    binary: false,
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: "context", content: "keep me", oldLine: 1, newLine: 1 },
          { kind: "del", content: "old line", oldLine: 2, newLine: null },
          { kind: "add", content: "new line", oldLine: null, newLine: 2 },
        ],
      },
    ],
  };
}

describe("DiffView", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("renders a unified diff in a themed CodeMirror editor with add/del line tints", async () => {
    await act(async () =>
      root?.render(<DiffView file={fileDiff()} path="a.txt" viewMode="unified" />),
    );
    await flush();

    expect(container!.querySelector('[data-diff-view="unified"]')).not.toBeNull();
    // The parsed content renders inside a CodeMirror editor.
    expect(container!.querySelector(".cm-editor")).not.toBeNull();
    expect(container!.textContent).toContain("keep me");
    expect(container!.textContent).toContain("old line");
    expect(container!.textContent).toContain("new line");
    // Add and del lines carry their tint decoration (asserted by data attr).
    expect(container!.querySelector('[data-diff="add"]')).not.toBeNull();
    expect(container!.querySelector('[data-diff="del"]')).not.toBeNull();
  });

  it("renders split view as two columns: deletions on the left, additions on the right", async () => {
    await act(async () =>
      root?.render(<DiffView file={fileDiff()} path="a.txt" viewMode="split" />),
    );
    await flush();

    expect(container!.querySelector('[data-diff-view="split"]')).not.toBeNull();
    const oldCol = container!.querySelector('[data-diff-column="old"]');
    const newCol = container!.querySelector('[data-diff-column="new"]');
    expect(oldCol).not.toBeNull();
    expect(newCol).not.toBeNull();
    // The old column shows the deletion (and context) but not the addition;
    // the new column shows the addition (and context) but not the deletion.
    expect(oldCol!.textContent).toContain("old line");
    expect(oldCol!.textContent).not.toContain("new line");
    expect(newCol!.textContent).toContain("new line");
    expect(newCol!.textContent).not.toContain("old line");
  });

  it("shows an honest message when there are no textual hunks", async () => {
    const file = { ...fileDiff(), hunks: [] };
    await act(async () => root?.render(<DiffView file={file} path="a.txt" viewMode="unified" />));
    await flush();

    expect(container!.textContent).toContain("no line changes to show");
    expect(container!.querySelector(".cm-editor")).toBeNull();
  });

  it("renders no comment thread when `commenting` is absent (free path unchanged)", async () => {
    await act(async () => root?.render(<DiffView file={fileDiff()} path="a.txt" viewMode="unified" />));
    await flush();
    expect(container!.querySelector("[data-comment-thread]")).toBeNull();
  });

  function commenting(comments: ReviewCommentEntry[] = []) {
    const onAdd = vi.fn<(startLine: number, endLine: number, body: string) => void>();
    const onUpdate = vi.fn<(id: string, body: string) => void>();
    const onDelete = vi.fn<(id: string) => void>();
    const dep: DiffCommenting = { comments, onAdd, onUpdate, onDelete };
    return { ...dep, onAdd, onUpdate, onDelete };
  }

  function fire(el: Element, type: string) {
    act(() => el.dispatchEvent(new (type === "input" ? Event : MouseEvent)(type, { bubbles: true })));
  }
  function setValue(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("adds a line comment: pick a changed line, type, save → onAdd(line, line, body)", async () => {
    const c = commenting();
    await act(async () => root?.render(<DiffView file={fileDiff()} path="a.txt" viewMode="unified" commenting={c} />));
    await flush();

    const addBtn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "add comment")!;
    fire(addBtn, "click");
    await flush();

    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="new comment"]')!;
    setValue(textarea, "tighten this");
    await flush();

    const saveBtn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "save")!;
    fire(saveBtn, "click");
    await flush();

    // The only changed line in the fixture is line 2 (del/add both address 2).
    expect(c.onAdd).toHaveBeenCalledWith(2, 2, "tighten this");
  });

  it("renders existing comments and wires edit + delete", async () => {
    const c = commenting([{ id: "c1", path: "a.txt", startLine: 2, endLine: 2, body: "original" }]);
    await act(async () => root?.render(<DiffView file={fileDiff()} path="a.txt" viewMode="unified" commenting={c} />));
    await flush();

    expect(container!.querySelector("[data-comment]")).not.toBeNull();
    expect(container!.textContent).toContain("original");

    const editBtn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "edit")!;
    fire(editBtn, "click");
    await flush();
    const editArea = container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="edit comment"]')!;
    setValue(editArea, "revised");
    await flush();
    const saveBtn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "save")!;
    fire(saveBtn, "click");
    await flush();
    expect(c.onUpdate).toHaveBeenCalledWith("c1", "revised");

    const deleteBtn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "delete")!;
    fire(deleteBtn, "click");
    await flush();
    expect(c.onDelete).toHaveBeenCalledWith("c1");
  });
});
