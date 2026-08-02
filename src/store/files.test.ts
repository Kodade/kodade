// Files store logic against the MockFiles IPC — no CodeMirror, no Tauri. Pins
// down tree building, lazy expansion, the watcher lifecycle on project switch,
// change-event refresh, and large/binary handling.

import { beforeEach, describe, expect, it } from "vitest";
import { MockFiles } from "../ipc/mock";
import { createFilesStore, defaultEditorMode, filterMatches, remapPath } from "./files";
import type { DirEntry } from "../ipc/contract";
import { encodeTabs, type Tab } from "./tabs";

const tabStrings = (tabs: Tab[]) => encodeTabs(tabs);

function dir(name: string, path: string): DirEntry {
  return { name, path, isDir: true };
}
function file(name: string, path: string): DirEntry {
  return { name, path, isDir: false };
}

function makeStore() {
  const files = new MockFiles();
  const store = createFilesStore({ files });
  return { store, files };
}

describe("files store", () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });

  it("setRoot starts a watcher, loads the root listing, and expands the root", async () => {
    const { store, files } = ctx;
    files.tree.set("/repo", [dir("src", "/repo/src"), file("README.md", "/repo/README.md")]);

    await store.getState().setRoot("/repo");

    const s = store.getState();
    expect(s.rootPath).toBe("/repo");
    expect(files.watchCalls).toEqual(["/repo"]);
    expect(files.currentRoot).toBe("/repo");
    expect(s.expanded["/repo"]).toBe(true);
    expect(s.children["/repo"].map((e) => e.name)).toEqual(["src", "README.md"]);
  });

  it("switching projects stops the old watcher and starts the new one", async () => {
    const { store, files } = ctx;
    files.tree.set("/a", [file("a.ts", "/a/a.ts")]);
    files.tree.set("/b", [file("b.ts", "/b/b.ts")]);

    await store.getState().setRoot("/a");
    await store.getState().setRoot("/b");

    // Old watcher stopped (unwatch fired) before the new watch each switch.
    expect(files.unwatchCalls).toBe(2); // once per setRoot (initial + switch)
    expect(files.watchCalls).toEqual(["/a", "/b"]);
    expect(files.currentRoot).toBe("/b");
    // Tree reset: only the new root's listing remains.
    expect(store.getState().children["/a"]).toBeUndefined();
    expect(store.getState().children["/b"]).toBeDefined();
  });

  it("setRoot(null) stops the watcher and clears the tree", async () => {
    const { store, files } = ctx;
    files.tree.set("/a", [file("a.ts", "/a/a.ts")]);
    await store.getState().setRoot("/a");

    await store.getState().setRoot(null);
    const s = store.getState();
    expect(s.rootPath).toBeNull();
    expect(s.children).toEqual({});
    expect(files.currentRoot).toBeNull();
  });

  it("toggleDir lazily loads children on first expand, then collapses", async () => {
    const { store, files } = ctx;
    files.tree.set("/repo", [dir("src", "/repo/src")]);
    files.tree.set("/repo/src", [file("index.ts", "/repo/src/index.ts")]);
    await store.getState().setRoot("/repo");

    // Not loaded until expanded.
    expect(store.getState().children["/repo/src"]).toBeUndefined();

    await store.getState().toggleDir("/repo/src");
    expect(store.getState().expanded["/repo/src"]).toBe(true);
    expect(store.getState().children["/repo/src"].map((e) => e.name)).toEqual(["index.ts"]);

    // Collapse leaves children cached but marks it closed.
    await store.getState().toggleDir("/repo/src");
    expect(store.getState().expanded["/repo/src"]).toBe(false);
  });

  it("selectFile reads text content into the store", async () => {
    const { store, files } = ctx;
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "const x = 1" });

    await store.getState().selectFile("/repo/a.ts");
    const s = store.getState();
    expect(s.selectedPath).toBe("/repo/a.ts");
    expect(s.fileContent).toEqual({ kind: "text", content: "const x = 1" });
    expect(s.loading).toBe(false);
  });

  it("selectFile surfaces tooLarge and binary results gracefully", async () => {
    const { store, files } = ctx;
    files.fileReads.set("/repo/big.bin", { kind: "tooLarge", bytes: 2_000_000 });
    files.fileReads.set("/repo/img.png", { kind: "binary" });

    await store.getState().selectFile("/repo/big.bin");
    expect(store.getState().fileContent).toEqual({ kind: "tooLarge", bytes: 2_000_000 });

    await store.getState().selectFile("/repo/img.png");
    expect(store.getState().fileContent).toEqual({ kind: "binary" });
    expect(store.getState().loading).toBe(false);
  });

  it("selectFile on a directory is a no-op (never reads it into the editor)", async () => {
    // Bug #27: a directory click routed into the file-read path and the editor
    // showed "Binary file — no preview". A dir must never reach readFile.
    const { store, files } = ctx;
    files.tree.set("/repo", [dir("src", "/repo/src"), file("a.ts", "/repo/a.ts")]);
    await store.getState().setRoot("/repo");

    // The dir is a listed isDir entry but was never expanded/loaded.
    await store.getState().selectFile("/repo/src");
    let s = store.getState();
    expect(s.selectedPath).toBeNull();
    expect(s.fileContent).toBeNull();
    // No read was even attempted against the directory.
    expect(files.reads).not.toContain("/repo/src");

    // The root itself is a known dir too — also a no-op.
    await store.getState().selectFile("/repo");
    expect(store.getState().selectedPath).toBeNull();

    // A real file still opens normally after the guarded dir clicks.
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "ok" });
    await store.getState().selectFile("/repo/a.ts");
    s = store.getState();
    expect(s.selectedPath).toBe("/repo/a.ts");
    expect(s.fileContent).toEqual({ kind: "text", content: "ok" });
  });

  it("selectFile on a nested, already-expanded directory is a no-op", async () => {
    const { store, files } = ctx;
    files.tree.set("/repo", [dir("src", "/repo/src")]);
    files.tree.set("/repo/src", [dir("ui", "/repo/src/ui")]);
    await store.getState().setRoot("/repo");
    await store.getState().toggleDir("/repo/src"); // now /repo/src/ui is visible

    await store.getState().selectFile("/repo/src/ui");
    expect(store.getState().selectedPath).toBeNull();
    expect(files.reads).not.toContain("/repo/src/ui");
  });

  it("a change event re-lists loaded directories touched by the batch", async () => {
    const { store, files } = ctx;
    files.tree.set("/repo", [file("a.ts", "/repo/a.ts")]);
    await store.getState().setRoot("/repo");
    await store.getState().startWatchingChanges();

    expect(store.getState().children["/repo"].map((e) => e.name)).toEqual(["a.ts"]);

    // Agent creates a new file; the watcher reports the new path + its parent.
    files.tree.set("/repo", [file("a.ts", "/repo/a.ts"), file("b.ts", "/repo/b.ts")]);
    files.emitChanged(["/repo/b.ts", "/repo"]);
    // Let the async relist settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().children["/repo"].map((e) => e.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("a change event only refreshes directories that are loaded", async () => {
    const { store, files } = ctx;
    files.tree.set("/repo", [dir("src", "/repo/src")]);
    files.tree.set("/repo/src", [file("x.ts", "/repo/src/x.ts")]);
    await store.getState().setRoot("/repo");
    await store.getState().startWatchingChanges();
    // /repo/src is NOT expanded, so it isn't loaded.

    files.tree.set("/repo/src", [
      file("x.ts", "/repo/src/x.ts"),
      file("y.ts", "/repo/src/y.ts"),
    ]);
    files.emitChanged(["/repo/src/y.ts", "/repo/src"]);
    await Promise.resolve();
    await Promise.resolve();

    // Unloaded dir stays unloaded — no wasted work.
    expect(store.getState().children["/repo/src"]).toBeUndefined();
  });

  it("a delete that empties a listing prunes the directory from the tree", async () => {
    const { store, files } = ctx;
    files.tree.set("/repo", [dir("src", "/repo/src")]);
    files.tree.set("/repo/src", [file("x.ts", "/repo/src/x.ts")]);
    await store.getState().setRoot("/repo");
    await store.getState().toggleDir("/repo/src");
    await store.getState().startWatchingChanges();

    // The whole src dir is deleted: listDir now throws.
    files.tree.delete("/repo/src");
    files.listDir = (p: string) => {
      if (p === "/repo/src") return Promise.reject(new Error("gone"));
      return MockFiles.prototype.listDir.call(files, p);
    };
    files.emitChanged(["/repo/src"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().children["/repo/src"]).toBeUndefined();
    expect(store.getState().expanded["/repo/src"]).toBeUndefined();
  });
});

describe("files store activity facts", () => {
  it("reports successful open/save metadata without a file path or contents", async () => {
    const files = new MockFiles();
    const facts: Array<{ type: string; root: string | null }> = [];
    const store = createFilesStore({
      files,
      onActivity: (fact) => facts.push(fact),
    });
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "before" });

    await store.getState().setRoot("/repo");
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("after");
    await store.getState().saveFile();

    expect(facts).toEqual([
      { type: "file-opened", root: "/repo" },
      { type: "file-saved", root: "/repo" },
    ]);
  });
});

// Overlapping project switches must converge on the NEWEST root — an older
// switch resuming late can neither install its watcher last nor pollute state.
describe("files store setRoot races", () => {
  it("A→B→A converges on A's watcher and tree", async () => {
    const files = new MockFiles();
    files.tree.set("/a", [{ name: "a.ts", path: "/a/a.ts", isDir: false }]);
    files.tree.set("/b", [{ name: "b.ts", path: "/b/b.ts", isDir: false }]);

    // Gate unwatch so the calls interleave: each setRoot parks on unwatch
    // until released, modeling slow IPC round trips.
    const gates: Array<() => void> = [];
    const baseUnwatch = files.unwatch.bind(files);
    files.unwatch = (generation) =>
      new Promise<void>((resolve) => {
        gates.push(() => void baseUnwatch(generation).then(resolve));
      });

    const store = createFilesStore({ files });
    const p1 = store.getState().setRoot("/a"); // parked on unwatch
    const p2 = store.getState().setRoot("/b"); // parked on unwatch
    const p3 = store.getState().setRoot("/a"); // parked on unwatch — newest

    // Release in submission order; older calls resume and must bail.
    for (const release of gates.splice(0)) release();
    await Promise.all([p1, p2, p3]);
    // Late stragglers (none expected, but drain any gate added after release).
    for (const release of gates.splice(0)) release();

    const s = store.getState();
    expect(s.rootPath).toBe("/a");
    expect(files.currentRoot).toBe("/a"); // the LIVE watcher is A's
    expect(s.children["/a"]?.map((e) => e.name)).toEqual(["a.ts"]);
    expect(s.children["/b"]).toBeUndefined(); // B never leaked into the tree
  });

  it("A→B→A ignores a stale watch that completes last", async () => {
    const files = new MockFiles();
    const gates: Array<() => void> = [];
    const baseWatch = files.watch.bind(files);
    files.watch = (root, generation) =>
      new Promise<void>((resolve) => {
        gates.push(() => void baseWatch(root, generation).then(resolve));
      });

    const store = createFilesStore({ files });
    const first = store.getState().setRoot("/a");
    await Promise.resolve();
    const second = store.getState().setRoot("/b");
    await Promise.resolve();
    const third = store.getState().setRoot("/a");
    await Promise.resolve();

    expect(gates).toHaveLength(3);
    gates[0](); // old A
    await Promise.resolve();
    gates[2](); // current A
    await Promise.resolve();
    gates[1](); // stale B arrives last
    await Promise.all([first, second, third]);

    expect(store.getState().rootPath).toBe("/a");
    expect(files.currentRoot).toBe("/a");
  });
});

// --- Editor state machine (M4b): dirty tracking, save, external-change,
// conflict resolution, self-save suppression, and save-failure handling. ---
describe("editor state machine", () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });

  // Open a text file at PATH with CONTENT and start the change watcher.
  async function openFile(path: string, content: string) {
    const { store, files } = ctx;
    files.fileReads.set(path, { kind: "text", content });
    await store.getState().startWatchingChanges();
    await store.getState().selectFile(path);
    return { store, files };
  }

  // Flush the microtasks the async reconcile (readFile) hangs on.
  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("opening a text file starts clean with the buffer seeded from disk", async () => {
    const { store } = await openFile("/repo/a.ts", "const x = 1");
    const s = store.getState();
    expect(s.editorStatus).toBe("clean");
    expect(s.buffer).toBe("const x = 1");
    expect(s.savedContent).toBe("const x = 1");
    expect(s.saveError).toBeNull();
  });

  it("editing marks dirty; reverting to the saved text marks clean again", async () => {
    const { store } = await openFile("/repo/a.ts", "hello");

    store.getState().setBuffer("hello world");
    expect(store.getState().editorStatus).toBe("dirty");

    // Back to the exact saved text — no longer dirty.
    store.getState().setBuffer("hello");
    expect(store.getState().editorStatus).toBe("clean");
  });

  it("save writes the buffer to disk and clears the dirty indicator", async () => {
    const { store, files } = await openFile("/repo/a.ts", "hello");
    store.getState().setBuffer("hello saved");

    await store.getState().saveFile();

    const s = store.getState();
    expect(s.editorStatus).toBe("clean");
    expect(s.savedContent).toBe("hello saved");
    expect(files.writes).toEqual([{ path: "/repo/a.ts", contents: "hello saved" }]);
    // fileContent reflects the saved text too (viewer stays consistent).
    expect(s.fileContent).toEqual({ kind: "text", content: "hello saved" });
  });

  it("a save's own watcher echo is suppressed — no false conflict", async () => {
    const { store, files } = await openFile("/repo/a.ts", "hello");
    store.getState().setBuffer("mine");
    await store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("clean");

    // The atomic write fires the watcher for the file we just wrote. The read
    // returns exactly our saved bytes — this must be ignored, not flagged.
    files.emitChanged(["/repo/a.ts"]);
    await flush();

    expect(store.getState().editorStatus).toBe("clean");
    expect(store.getState().buffer).toBe("mine");
  });

  it("an external change with a clean buffer auto-reloads seamlessly", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v1");

    // Agent rewrites the file on disk; our buffer is clean.
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "v2 from agent" });
    files.emitChanged(["/repo/a.ts"]);
    await flush();

    const s = store.getState();
    expect(s.editorStatus).toBe("clean");
    expect(s.buffer).toBe("v2 from agent");
    expect(s.savedContent).toBe("v2 from agent");
  });

  it("an external change under unsaved edits enters a conflict with disk stashed", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v1");
    store.getState().setBuffer("my unsaved edit");

    // Agent changes the same file underneath the unsaved edit.
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "agent version" });
    files.emitChanged(["/repo/a.ts"]);
    await flush();

    const s = store.getState();
    expect(s.editorStatus).toBe("conflict");
    expect(s.buffer).toBe("my unsaved edit"); // buffer untouched
    expect(s.diskContent).toBe("agent version"); // disk version available to reload
  });

  it("reloadFromDisk resolves a conflict by taking the disk version", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v1");
    store.getState().setBuffer("mine");
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "theirs" });
    files.emitChanged(["/repo/a.ts"]);
    await flush();
    expect(store.getState().editorStatus).toBe("conflict");

    store.getState().reloadFromDisk();
    const s = store.getState();
    expect(s.editorStatus).toBe("clean");
    expect(s.buffer).toBe("theirs");
    expect(s.savedContent).toBe("theirs");
  });

  it("keepMine resolves a conflict, keeping my buffer as dirty over the disk baseline", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v1");
    store.getState().setBuffer("mine");
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "theirs" });
    files.emitChanged(["/repo/a.ts"]);
    await flush();
    expect(store.getState().editorStatus).toBe("conflict");

    store.getState().keepMine();
    let s = store.getState();
    expect(s.editorStatus).toBe("dirty");
    expect(s.buffer).toBe("mine");
    expect(s.savedContent).toBe("theirs"); // disk is the new baseline

    // Saving now overwrites the agent's version with mine.
    await store.getState().saveFile();
    s = store.getState();
    expect(s.editorStatus).toBe("clean");
    expect(files.writes.at(-1)).toEqual({ path: "/repo/a.ts", contents: "mine" });
  });

  it("a failed save keeps the buffer and surfaces an error (no truncation)", async () => {
    const { store, files } = await openFile("/repo/a.ts", "original");
    store.getState().setBuffer("edited but unsavable");
    files.failWriteWith = "file is read-only: /repo/a.ts";

    await store.getState().saveFile();

    const s = store.getState();
    expect(s.editorStatus).toBe("dirty"); // still dirty — not clean
    expect(s.buffer).toBe("edited but unsavable"); // buffer intact
    expect(s.saveError).toContain("read-only");
    expect(files.writes).toEqual([]); // nothing hit disk
  });

  it("selecting a different file resets the editor and drops self-save tracking", async () => {
    const { store, files } = await openFile("/repo/a.ts", "aaa");
    store.getState().setBuffer("aaa edited");
    expect(store.getState().editorStatus).toBe("dirty");

    files.fileReads.set("/repo/b.ts", { kind: "text", content: "bbb" });
    await store.getState().selectFile("/repo/b.ts");

    const s = store.getState();
    expect(s.selectedPath).toBe("/repo/b.ts");
    expect(s.editorStatus).toBe("clean");
    expect(s.buffer).toBe("bbb");
    expect(s.saveError).toBeNull();
  });

  // --- Fix 1: switching away from a dirty file must not discard its edits ---
  it("switching away from a dirty file and back preserves the unsaved buffer", async () => {
    const { store, files } = await openFile("/repo/a.ts", "aaa");
    store.getState().setBuffer("aaa edited");
    files.fileReads.set("/repo/b.ts", { kind: "text", content: "bbb" });

    // Switch away — a.ts should be tracked as dirty for the tree.
    await store.getState().selectFile("/repo/b.ts");
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);
    expect(store.getState().buffer).toBe("bbb");

    // Switch back — the stashed edit is restored, still dirty.
    await store.getState().selectFile("/repo/a.ts");
    const s = store.getState();
    expect(s.selectedPath).toBe("/repo/a.ts");
    expect(s.editorStatus).toBe("dirty");
    expect(s.buffer).toBe("aaa edited");
    expect(s.savedContent).toBe("aaa"); // baseline still disk
  });

  it("re-selecting the already-open file is a no-op (buffer untouched)", async () => {
    const { store } = await openFile("/repo/a.ts", "aaa");
    store.getState().setBuffer("aaa edited");
    expect(store.getState().editorStatus).toBe("dirty");

    await store.getState().selectFile("/repo/a.ts"); // same file
    const s = store.getState();
    expect(s.buffer).toBe("aaa edited"); // NOT reset to disk
    expect(s.editorStatus).toBe("dirty");
  });

  it("saving a stashed-dirty file after re-selecting clears its dirty dot", async () => {
    const { store, files } = await openFile("/repo/a.ts", "aaa");
    store.getState().setBuffer("aaa edited");
    files.fileReads.set("/repo/b.ts", { kind: "text", content: "bbb" });
    await store.getState().selectFile("/repo/b.ts");
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);

    await store.getState().selectFile("/repo/a.ts");
    await store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("clean");
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBeUndefined();
  });

  // --- Fix 2: save completion must not blanket-mark clean ---
  it("typing during an in-flight save stays dirty; savedContent equals what was written", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v0");
    store.getState().setBuffer("first");
    files.deferWrite = true;

    const savePromise = store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("saving");

    // User keeps typing while the write is in flight.
    store.getState().setBuffer("first + more");

    files.resolveWrite();
    await savePromise;
    await flush();

    const s = store.getState();
    expect(s.savedContent).toBe("first"); // exactly what we wrote
    expect(s.editorStatus).toBe("dirty"); // buffer moved on — still dirty
    expect(s.buffer).toBe("first + more");
    expect(files.writes).toEqual([{ path: "/repo/a.ts", contents: "first" }]);
  });

  // --- Fix 3: Mod-S during a conflict is a guarded no-op ---
  it("saveFile during a conflict writes nothing (banner is the only exit)", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v1");
    store.getState().setBuffer("mine");
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "theirs" });
    files.emitChanged(["/repo/a.ts"]);
    await flush();
    expect(store.getState().editorStatus).toBe("conflict");

    await store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("conflict"); // unchanged
    expect(files.writes).toEqual([]); // nothing hit disk
  });

  // --- Fix 4+5: reconciliation during a save, and one-shot lastSaved ---
  it("an external write while status is 'saving' is treated as an external change", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v0");
    store.getState().setBuffer("mine");
    files.deferWrite = true;
    const savePromise = store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("saving");

    // An agent writes different bytes to disk WHILE our save is in flight.
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "agent wrote this" });
    files.emitChanged(["/repo/a.ts"]);
    await flush();
    // Must NOT be skipped just because status was "saving" — it's a conflict.
    expect(store.getState().editorStatus).toBe("conflict");
    expect(store.getState().diskContent).toBe("agent wrote this");

    files.resolveWrite();
    await savePromise;
  });

  it("lastSaved is one-shot: a later external write of the same old bytes is not suppressed", async () => {
    const { store, files } = await openFile("/repo/a.ts", "hello");
    store.getState().setBuffer("saved-bytes");
    await store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("clean");

    // First echo: our own write landing back — suppressed, consumes lastSaved.
    files.emitChanged(["/repo/a.ts"]);
    await flush();
    expect(store.getState().editorStatus).toBe("clean");

    // A clean external change moves the disk baseline forward to "moved-on".
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "moved-on" });
    files.emitChanged(["/repo/a.ts"]);
    await flush();
    expect(store.getState().savedContent).toBe("moved-on");

    // The user edits, making the buffer dirty against "moved-on".
    store.getState().setBuffer("dirty now");
    expect(store.getState().editorStatus).toBe("dirty");

    // An agent legitimately rewrites the file back to the ORIGINAL saved bytes.
    // If the one-shot lastSaved had lingered it would suppress this as our echo;
    // because it was already consumed, this must surface as a genuine conflict.
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "saved-bytes" });
    files.emitChanged(["/repo/a.ts"]);
    await flush();
    expect(store.getState().editorStatus).toBe("conflict");
    expect(store.getState().diskContent).toBe("saved-bytes");
  });

  // --- Fix 6: delete-under-edit ---
  it("a delete under unsaved edits enters a conflict flagged as deleted-on-disk", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v1");
    store.getState().setBuffer("my work");

    files.readFailPaths.add("/repo/a.ts"); // file deleted
    files.emitChanged(["/repo/a.ts"]);
    await flush();

    const s = store.getState();
    expect(s.editorStatus).toBe("conflict");
    expect(s.deletedOnDisk).toBe(true);
    expect(s.diskContent).toBeNull();
    expect(s.buffer).toBe("my work"); // buffer preserved
  });

  it("a delete under a clean buffer closes the file", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v1");
    expect(store.getState().editorStatus).toBe("clean");

    files.readFailPaths.add("/repo/a.ts"); // file deleted
    files.emitChanged(["/repo/a.ts"]);
    await flush();

    const s = store.getState();
    expect(s.selectedPath).toBeNull(); // closed
    expect(s.fileContent).toBeNull();
    expect(s.buffer).toBe("");
  });

  it("Reload from disk on a deleted file closes it (nothing to reload)", async () => {
    const { store, files } = await openFile("/repo/a.ts", "v1");
    store.getState().setBuffer("my work");
    files.readFailPaths.add("/repo/a.ts");
    files.emitChanged(["/repo/a.ts"]);
    await flush();
    expect(store.getState().deletedOnDisk).toBe(true);

    store.getState().reloadFromDisk();
    expect(store.getState().selectedPath).toBeNull();
  });
});

// --- File manager (v1.1): op flows, filter, inline edit ---

describe("file manager ops", () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });

  async function withRoot() {
    const { store, files } = ctx;
    files.tree.set("/repo", [dir("src", "/repo/src"), file("a.ts", "/repo/a.ts")]);
    files.tree.set("/repo/src", [file("index.ts", "/repo/src/index.ts")]);
    await store.getState().setRoot("/repo");
    return { store, files };
  }

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  // --- create ---

  it("beginCreate + commit creates a new file and relists the parent", async () => {
    const { store, files } = await withRoot();

    await store.getState().beginCreate("/repo", "file");
    expect(store.getState().edit?.kind).toBe("create");

    store.getState().setEditDraft("new.ts");
    await store.getState().commitEdit();

    expect(files.createFileCalls).toEqual([{ root: "/repo", path: "/repo/new.ts" }]);
    expect(store.getState().edit).toBeNull();
    // Optimistic relist picked up the new entry.
    expect(store.getState().children["/repo"].map((e) => e.name)).toContain("new.ts");
  });

  it("beginCreate for a folder creates a directory", async () => {
    const { store, files } = await withRoot();
    await store.getState().beginCreate("/repo", "dir");
    store.getState().setEditDraft("lib");
    await store.getState().commitEdit();
    expect(files.createDirCalls).toEqual([{ root: "/repo", path: "/repo/lib" }]);
    expect(files.createFileCalls).toEqual([]);
  });

  it("create validates: empty, slash, and sibling collision block the commit", async () => {
    const { store, files } = await withRoot();

    await store.getState().beginCreate("/repo", "file");
    // Empty name.
    store.getState().setEditDraft("   ");
    await store.getState().commitEdit();
    expect(store.getState().edit).not.toBeNull();
    expect(store.getState().edit?.error).toMatch(/empty/);

    // Slash in name.
    store.getState().setEditDraft("a/b");
    await store.getState().commitEdit();
    expect(store.getState().edit?.error).toMatch(/\//);

    // Collision with existing sibling "a.ts".
    store.getState().setEditDraft("a.ts");
    await store.getState().commitEdit();
    expect(store.getState().edit?.error).toMatch(/already exists/);

    // No op ever fired for the invalid attempts.
    expect(files.createFileCalls).toEqual([]);
  });

  it("joins Windows paths and rejects names Windows cannot represent", async () => {
    const files = new MockFiles();
    const store = createFilesStore({ files });
    const root = "C:\\Users\\Keith\\My Project";
    files.tree.set(root, []);
    await store.getState().setRoot(root);

    await store.getState().beginCreate(root, "file");
    store.getState().setEditDraft("CON.txt");
    await store.getState().commitEdit();
    expect(store.getState().edit?.error).toMatch(/reserved/);

    store.getState().setEditDraft("notes. ");
    await store.getState().commitEdit();
    expect(store.getState().edit?.error).toMatch(/dot or space/);

    store.getState().setEditDraft("设计 🚀.md");
    await store.getState().commitEdit();
    expect(files.createFileCalls).toEqual([
      { root, path: "C:\\Users\\Keith\\My Project\\设计 🚀.md" },
    ]);
  });

  it("rejects a Windows trailing-space name without calling file IPC", async () => {
    const files = new MockFiles();
    const store = createFilesStore({ files });
    const root = "C:\\work";
    files.tree.set(root, []);
    await store.getState().setRoot(root);

    await store.getState().beginCreate(root, "file");
    store.getState().setEditDraft("notes ");
    await store.getState().commitEdit();

    expect(store.getState().edit?.error).toMatch(/dot or space/);
    expect(files.createFileCalls).toEqual([]);
  });

  it("checks Windows sibling collisions case-insensitively but permits case-only rename", async () => {
    const files = new MockFiles();
    const store = createFilesStore({ files });
    const root = "C:\\work";
    files.tree.set(root, [
      { name: "CAFÉ.txt", path: `${root}\\CAFÉ.txt`, isDir: false },
    ]);
    await store.getState().setRoot(root);

    await store.getState().beginCreate(root, "file");
    store.getState().setEditDraft("café.TXT");
    await store.getState().commitEdit();
    expect(store.getState().edit?.error).toMatch(/already exists/);

    store.getState().cancelEdit();
    store.getState().beginRename({
      name: "CAFÉ.txt",
      path: `${root}\\CAFÉ.txt`,
      isDir: false,
    });
    store.getState().setEditDraft("café.txt");
    await store.getState().commitEdit();
    expect(files.renameCalls).toContainEqual({
      root,
      from: `${root}\\CAFÉ.txt`,
      to: `${root}\\café.txt`,
    });
  });

  it("a rejected create op keeps the row editing with the error", async () => {
    const { store, files } = await withRoot();
    files.failCreateFileWith = "already exists: /repo/new.ts";
    await store.getState().beginCreate("/repo", "file");
    store.getState().setEditDraft("new.ts");
    await store.getState().commitEdit();
    expect(store.getState().edit).not.toBeNull();
    expect(store.getState().edit?.error).toMatch(/already exists/);
  });

  // --- rename ---

  it("rename commits and relists the parent", async () => {
    const { store, files } = await withRoot();
    store.getState().beginRename(file("a.ts", "/repo/a.ts"));
    expect(store.getState().edit?.draft).toBe("a.ts");

    store.getState().setEditDraft("b.ts");
    await store.getState().commitEdit();

    expect(files.renameCalls).toEqual([{ root: "/repo", from: "/repo/a.ts", to: "/repo/b.ts" }]);
    const names = store.getState().children["/repo"].map((e) => e.name);
    expect(names).toContain("b.ts");
    expect(names).not.toContain("a.ts");
  });

  it("renaming to the same name is a no-op (no rename op)", async () => {
    const { store, files } = await withRoot();
    store.getState().beginRename(file("a.ts", "/repo/a.ts"));
    // draft already "a.ts"; commit unchanged.
    await store.getState().commitEdit();
    expect(files.renameCalls).toEqual([]);
    expect(store.getState().edit).toBeNull();
  });

  it("rename follows the open editor file (selectedPath swaps)", async () => {
    const { store, files } = await withRoot();
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "x" });
    await store.getState().selectFile("/repo/a.ts");
    expect(store.getState().selectedPath).toBe("/repo/a.ts");

    store.getState().beginRename(file("a.ts", "/repo/a.ts"));
    store.getState().setEditDraft("renamed.ts");
    await store.getState().commitEdit();

    // The editor now points at the new path; its buffer is untouched.
    expect(store.getState().selectedPath).toBe("/repo/renamed.ts");
    expect(store.getState().buffer).toBe("x");
  });

  it("renaming a directory follows an open file inside it", async () => {
    const { store, files } = await withRoot();
    await store.getState().toggleDir("/repo/src");
    files.fileReads.set("/repo/src/index.ts", { kind: "text", content: "y" });
    await store.getState().selectFile("/repo/src/index.ts");

    store.getState().beginRename(dir("src", "/repo/src"));
    store.getState().setEditDraft("lib");
    await store.getState().commitEdit();

    expect(store.getState().selectedPath).toBe("/repo/lib/index.ts");
  });

  // --- Fix 4: rename remaps ALL dirty bookkeeping, not just the open file ---

  it("a background dirty file keeps its stash+dot across its OWN rename and reopens restored", async () => {
    const { store, files } = await withRoot();
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "disk" });
    files.fileReads.set("/repo/src/index.ts", { kind: "text", content: "other" });

    // Make a.ts dirty in the background: open, edit, then switch away.
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("dirty work");
    await store.getState().toggleDir("/repo/src");
    await store.getState().selectFile("/repo/src/index.ts");
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);
    expect(store.getState().selectedPath).toBe("/repo/src/index.ts"); // a.ts is background

    // Rename the BACKGROUND file (not the open one).
    store.getState().beginRename(file("a.ts", "/repo/a.ts"));
    store.getState().setEditDraft("renamed.ts");
    await store.getState().commitEdit();

    // Its dirty dot must follow to the new path; old key gone.
    expect(store.getState().dirtyPaths["/repo/renamed.ts"]).toBe(true);
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBeUndefined();

    // Reopening at the NEW path restores the stashed buffer.
    await store.getState().selectFile("/repo/renamed.ts");
    expect(store.getState().selectedPath).toBe("/repo/renamed.ts");
    expect(store.getState().editorStatus).toBe("dirty");
    expect(store.getState().buffer).toBe("dirty work");
  });

  it("a background dirty file keeps its stash+dot across a PARENT-dir rename", async () => {
    const { store, files } = await withRoot();
    await store.getState().toggleDir("/repo/src");
    files.fileReads.set("/repo/src/index.ts", { kind: "text", content: "disk" });
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "aa" });

    // Make src/index.ts dirty in the background.
    await store.getState().selectFile("/repo/src/index.ts");
    store.getState().setBuffer("nested dirty");
    await store.getState().selectFile("/repo/a.ts"); // switch away — index.ts is background
    expect(store.getState().dirtyPaths["/repo/src/index.ts"]).toBe(true);

    // Rename the ANCESTOR dir. A component-aware swap must remap the descendant.
    store.getState().beginRename(dir("src", "/repo/src"));
    store.getState().setEditDraft("lib");
    await store.getState().commitEdit();

    expect(store.getState().dirtyPaths["/repo/lib/index.ts"]).toBe(true);
    expect(store.getState().dirtyPaths["/repo/src/index.ts"]).toBeUndefined();

    // The mock only remaps the exact renamed dir, not descendant file reads;
    // model the real fs where the dir rename moved the file's bytes too.
    files.fileReads.set("/repo/lib/index.ts", { kind: "text", content: "disk" });
    // Reopen at the new descendant path — buffer restored.
    await store.getState().selectFile("/repo/lib/index.ts");
    expect(store.getState().editorStatus).toBe("dirty");
    expect(store.getState().buffer).toBe("nested dirty");
  });

  it("a parent-dir rename does not remap a sibling with a shared name prefix (/a/b vs /a/bee)", async () => {
    const { store, files } = await withRoot();
    // Two sibling dirs: /repo/b and /repo/bee. A file under /repo/bee is dirty.
    files.tree.set("/repo", [dir("b", "/repo/b"), dir("bee", "/repo/bee")]);
    files.tree.set("/repo/bee", [file("x.ts", "/repo/bee/x.ts")]);
    await store.getState().toggleDir("/repo/bee");
    files.fileReads.set("/repo/bee/x.ts", { kind: "text", content: "x" });
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "aa" });
    await store.getState().selectFile("/repo/bee/x.ts");
    store.getState().setBuffer("edited");
    await store.getState().selectFile("/repo/a.ts");
    expect(store.getState().dirtyPaths["/repo/bee/x.ts"]).toBe(true);

    // Rename /repo/b (NOT /repo/bee). The prefix "/repo/b" must not swallow
    // "/repo/bee/x.ts".
    store.getState().beginRename(dir("b", "/repo/b"));
    store.getState().setEditDraft("c");
    await store.getState().commitEdit();

    // The dirty file under /repo/bee is untouched.
    expect(store.getState().dirtyPaths["/repo/bee/x.ts"]).toBe(true);
    expect(store.getState().dirtyPaths["/repo/c/x.ts"]).toBeUndefined();
  });

  // --- trash ---

  it("trashEntry moves to trash and relists the parent", async () => {
    const { store, files } = await withRoot();
    await store.getState().trashEntry(file("a.ts", "/repo/a.ts"));
    expect(files.trashCalls).toEqual([{ root: "/repo", path: "/repo/a.ts" }]);
    expect(store.getState().children["/repo"].map((e) => e.name)).not.toContain("a.ts");
  });

  it("trashing the open file closes the editor (clean → close)", async () => {
    const { store, files } = await withRoot();
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "x" });
    await store.getState().startWatchingChanges();
    await store.getState().selectFile("/repo/a.ts");
    expect(store.getState().selectedPath).toBe("/repo/a.ts");

    await store.getState().trashEntry(file("a.ts", "/repo/a.ts"));
    await flush();

    // Clean-and-gone: the editor closed.
    expect(store.getState().selectedPath).toBeNull();
    expect(store.getState().fileContent).toBeNull();
  });

  it("trashing the open file under unsaved edits conflicts (deleted on disk)", async () => {
    const { store, files } = await withRoot();
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "x" });
    await store.getState().startWatchingChanges();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("unsaved work");

    await store.getState().trashEntry(file("a.ts", "/repo/a.ts"));
    await flush();

    expect(store.getState().editorStatus).toBe("conflict");
    expect(store.getState().deletedOnDisk).toBe(true);
    expect(store.getState().buffer).toBe("unsaved work");
  });

  it("a rejected trash op surfaces opError and leaves the tree intact", async () => {
    const { store, files } = await withRoot();
    files.failTrashWith = "trash backend unavailable";
    await store.getState().trashEntry(file("a.ts", "/repo/a.ts"));
    expect(store.getState().opError).toMatch(/trash backend/);
    expect(store.getState().children["/repo"].map((e) => e.name)).toContain("a.ts");
  });

  // --- Fix 5: trash cleans up dirty bookkeeping for background files ---

  it("a background dirty file's stash+dot are gone after trashing it", async () => {
    const { store, files } = await withRoot();
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "disk" });
    files.fileReads.set("/repo/src/index.ts", { kind: "text", content: "other" });

    // a.ts dirty in the background.
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("dirty work");
    await store.getState().toggleDir("/repo/src");
    await store.getState().selectFile("/repo/src/index.ts");
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);

    // Trash the BACKGROUND file: its stash is recoverable in Trash, so the
    // orphaned stash+dot must be cleaned up.
    await store.getState().trashEntry(file("a.ts", "/repo/a.ts"));
    await flush();
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBeUndefined();
    // The open file is unaffected.
    expect(store.getState().selectedPath).toBe("/repo/src/index.ts");
  });

  it("trashing an ancestor dir clears stash+dot for a background dirty descendant", async () => {
    const { store, files } = await withRoot();
    await store.getState().toggleDir("/repo/src");
    files.fileReads.set("/repo/src/index.ts", { kind: "text", content: "disk" });
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "aa" });

    await store.getState().selectFile("/repo/src/index.ts");
    store.getState().setBuffer("nested dirty");
    await store.getState().selectFile("/repo/a.ts"); // index.ts now background dirty
    expect(store.getState().dirtyPaths["/repo/src/index.ts"]).toBe(true);

    await store.getState().trashEntry(dir("src", "/repo/src"));
    await flush();
    expect(store.getState().dirtyPaths["/repo/src/index.ts"]).toBeUndefined();
  });

  it("trashing the OPEN dirty file still shows the conflict banner (keeps #9 semantics)", async () => {
    const { store, files } = await withRoot();
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "x" });
    await store.getState().startWatchingChanges();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("unsaved work");

    await store.getState().trashEntry(file("a.ts", "/repo/a.ts"));
    await flush();

    // #9 deleted-on-disk conflict — NOT cleaned away like a background file.
    expect(store.getState().editorStatus).toBe("conflict");
    expect(store.getState().deletedOnDisk).toBe(true);
    expect(store.getState().buffer).toBe("unsaved work");
  });

  // --- Fix 6: pending-op guard vs the watcher ---

  it("a watcher reconcile racing a rename does not close/false-flag the editor", async () => {
    const { store, files } = await withRoot();
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "x" });
    await store.getState().startWatchingChanges();
    await store.getState().selectFile("/repo/a.ts");
    expect(store.getState().selectedPath).toBe("/repo/a.ts");

    // Gate the rename IPC so the op is in flight while the watcher fires.
    files.deferRename = true;
    store.getState().beginRename(file("a.ts", "/repo/a.ts"));
    store.getState().setEditDraft("b.ts");
    const commit = store.getState().commitEdit();
    await flush();

    // The mock's rename already removed /repo/a.ts (readFile now rejects). A
    // watcher event for the old path arrives mid-op — reconcile must be gated by
    // the pending set and NOT close/conflict the still-clean editor.
    files.emitChanged(["/repo/a.ts"]);
    await flush();
    expect(store.getState().selectedPath).toBe("/repo/a.ts"); // not closed
    expect(store.getState().editorStatus).toBe("clean"); // not false-flagged

    // Complete the rename: the op's own followRename swaps the path cleanly.
    files.resolveRename();
    await commit;
    await flush();
    expect(store.getState().selectedPath).toBe("/repo/b.ts");
    expect(store.getState().editorStatus).toBe("clean");
  });

  // --- Fix 7: save completion survives a rename ---

  it("a rename during an in-flight save resolves status without stranding in 'saving'", async () => {
    const { store, files } = await withRoot();
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "v0" });
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("saved bytes");

    // Gate the write so the save is in flight (status === "saving").
    files.deferWrite = true;
    const savePromise = store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("saving");

    // Rename the file WHILE the save is in flight.
    store.getState().beginRename(file("a.ts", "/repo/a.ts"));
    store.getState().setEditDraft("b.ts");
    await store.getState().commitEdit();
    expect(store.getState().selectedPath).toBe("/repo/b.ts");

    // Let the save complete: it must resolve, not stay stuck in "saving".
    files.resolveWrite();
    await savePromise;
    await flush();

    expect(store.getState().editorStatus).not.toBe("saving");
    // Buffer still equals what was written → clean; savedContent is our bytes.
    expect(store.getState().editorStatus).toBe("clean");
    expect(store.getState().savedContent).toBe("saved bytes");
  });

  // --- Fix 8: inline-edit session token ---

  it("beginning a new edit invalidates a pending blur-commit from the previous row", async () => {
    const { store, files } = await withRoot();

    // Edit A: a rename of a.ts, drafted but NOT yet committed.
    store.getState().beginRename(file("a.ts", "/repo/a.ts"));
    store.getState().setEditDraft("A-renamed.ts");
    // Capture A's commit (as a blur would trigger) but don't await it yet.
    const aCommit = store.getState().commitEdit();

    // Before A's commit settles, edit B begins (a new create) — bumps the token.
    await store.getState().beginCreate("/repo", "file");
    store.getState().setEditDraft("B.ts");

    // A's stale commit now settles — it must NOT clobber B's live edit.
    await aCommit;
    expect(store.getState().edit?.kind).toBe("create");
    expect(store.getState().edit?.draft).toBe("B.ts");

    // B commits normally.
    await store.getState().commitEdit();
    expect(store.getState().edit).toBeNull();
    expect(files.createFileCalls).toEqual([{ root: "/repo", path: "/repo/B.ts" }]);
  });

  // --- reveal ---

  it("revealEntry calls the IPC with the project root", async () => {
    const { store, files } = await withRoot();
    await store.getState().revealEntry("/repo/a.ts");
    expect(files.revealCalls).toEqual([{ root: "/repo", path: "/repo/a.ts" }]);
  });

  // --- refresh / collapse-all ---

  it("refreshAll re-lists every loaded directory", async () => {
    const { store, files } = await withRoot();
    await store.getState().toggleDir("/repo/src");
    // Change the mock fs out from under the tree (as if edited externally).
    files.tree.set("/repo/src", [file("index.ts", "/repo/src/index.ts"), file("new.ts", "/repo/src/new.ts")]);

    await store.getState().refreshAll();
    expect(store.getState().children["/repo/src"].map((e) => e.name)).toContain("new.ts");
  });

  it("collapseAll resets expansion to just the root", async () => {
    const { store } = await withRoot();
    await store.getState().toggleDir("/repo/src");
    expect(store.getState().expanded["/repo/src"]).toBe(true);

    store.getState().collapseAll();
    expect(store.getState().expanded["/repo/src"]).toBeFalsy();
    expect(store.getState().expanded["/repo"]).toBe(true);
    // Cached children survive so re-expanding is instant.
    expect(store.getState().children["/repo/src"]).toBeDefined();
  });

  // --- filter ---

  it("setFilter stores the substring; clearing restores it", () => {
    const { store } = ctx;
    store.getState().setFilter("Index");
    expect(store.getState().filter).toBe("Index");
    store.getState().setFilter("");
    expect(store.getState().filter).toBe("");
  });

  it("switching projects clears filter and any in-flight edit", async () => {
    const { store, files } = await withRoot();
    store.getState().setFilter("a");
    await store.getState().beginCreate("/repo", "file");
    expect(store.getState().edit).not.toBeNull();

    files.tree.set("/other", [file("x.ts", "/other/x.ts")]);
    await store.getState().setRoot("/other");
    expect(store.getState().filter).toBe("");
    expect(store.getState().edit).toBeNull();
  });
});

describe("remapPath", () => {
  it("remaps an exact match and a component-wise descendant", () => {
    expect(remapPath("/a/b", "/a/b", "/a/c")).toBe("/a/c");
    expect(remapPath("/a/b/x.ts", "/a/b", "/a/c")).toBe("/a/c/x.ts");
  });

  it("is component-aware: /a/b does not match /a/bee", () => {
    expect(remapPath("/a/bee/x.ts", "/a/b", "/a/c")).toBeNull();
    expect(remapPath("/a/bee", "/a/b", "/a/c")).toBeNull();
  });

  it("returns null for an unrelated path", () => {
    expect(remapPath("/other/x.ts", "/a/b", "/a/c")).toBeNull();
  });
});

describe("filterMatches", () => {
  const children: Record<string, DirEntry[]> = {
    "/repo": [dir("src", "/repo/src"), file("README.md", "/repo/README.md")],
    "/repo/src": [file("index.ts", "/repo/src/index.ts"), file("util.ts", "/repo/src/util.ts")],
  };

  it("empty needle matches everything", () => {
    expect(filterMatches(file("README.md", "/repo/README.md"), "", children)).toBe(true);
    expect(filterMatches(dir("src", "/repo/src"), "", children)).toBe(true);
  });

  it("matches a file on its own name, case-insensitively", () => {
    expect(filterMatches(file("README.md", "/repo/README.md"), "readme", children)).toBe(true);
    expect(filterMatches(file("README.md", "/repo/README.md"), "xyz", children)).toBe(false);
  });

  it("keeps a directory visible when a loaded descendant matches", () => {
    // "index" only appears under /repo/src — the dir must survive so the path shows.
    expect(filterMatches(dir("src", "/repo/src"), "index", children)).toBe(true);
    // No descendant matches — the dir drops out.
    expect(filterMatches(dir("src", "/repo/src"), "nomatch", children)).toBe(false);
  });

  it("a dir with unloaded children can't claim a hidden hit", () => {
    // /repo/src not present in `children` map = not loaded.
    expect(filterMatches(dir("src", "/repo/src"), "index", { "/repo": children["/repo"] })).toBe(
      false,
    );
    // ...unless the dir's own name matches.
    expect(filterMatches(dir("src", "/repo/src"), "src", { "/repo": children["/repo"] })).toBe(
      true,
    );
  });
});

// --- Editor tabs (v1.1) ---
describe("editor tabs", () => {
  // A store rooted at /repo with a couple of text files ready to open, plus a
  // record of every onTabsChanged callback so persistence wiring is assertable.
  async function makeTabStore() {
    const files = new MockFiles();
    const tabEvents: { root: string; tabs: string[] }[] = [];
    let browserCloses = 0;
    const store = createFilesStore({
      files,
      onTabsChanged: (root, tabs) => tabEvents.push({ root, tabs }),
      onBrowserTabClosed: () => { browserCloses += 1; },
    });
    files.fileReads.set("/repo/a.ts", { kind: "text", content: "A" });
    files.fileReads.set("/repo/b.ts", { kind: "text", content: "B" });
    files.fileReads.set("/repo/c.ts", { kind: "text", content: "C" });
    files.fileReads.set("/repo/README.md", { kind: "text", content: "# Read me" });
    files.fileReads.set("/repo/notes.markdown", { kind: "text", content: "# Notes" });
    files.fileReads.set("/repo/diagram.png", { kind: "binary", bytes: 4_096 });
    files.fileReads.set("/repo/drawing.pdf", { kind: "binary", bytes: 8_192 });
    await store.getState().setRoot("/repo");
    return { store, files, tabEvents, browserCloses: () => browserCloses };
  }

  it("opening a file adds a tab and makes it active", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    const s = store.getState();
    expect(tabStrings(s.openTabs)).toEqual(["/repo/a.ts"]);
    expect(s.selectedPath).toBe("/repo/a.ts");
  });

  it("defaults markdown tabs to view and other files to edit", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/README.md");
    expect(defaultEditorMode("/repo/README.md")).toBe("view");
    expect(store.getState().tabModes["/repo/README.md"]).toBe("view");

    await store.getState().selectFile("/repo/a.ts");
    expect(store.getState().tabModes["/repo/a.ts"]).toBe("edit");
  });

  it("keeps supported document viewer tabs clean", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/diagram.png");

    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/diagram.png"]);
    expect(store.getState().editorStatus).toBe("clean");
    store.getState().setBuffer("viewer tabs cannot become dirty");
    expect(store.getState().editorStatus).toBe("clean");
    expect(store.getState().dirtyPaths).toEqual({});
  });

  it("keeps modes per tab and toggles only the active markdown tab", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/README.md");
    store.getState().toggleActiveTabMode();
    expect(store.getState().tabModes["/repo/README.md"]).toBe("edit");
    store.getState().setBuffer("# Unsaved rendered copy");
    store.getState().toggleActiveTabMode();
    expect(store.getState().tabModes["/repo/README.md"]).toBe("view");
    expect(store.getState().buffer).toBe("# Unsaved rendered copy");
    expect(store.getState().editorStatus).toBe("dirty");

    await store.getState().selectFile("/repo/notes.markdown");
    expect(store.getState().tabModes["/repo/notes.markdown"]).toBe("view");
    store.getState().toggleActiveTabMode();
    expect(store.getState().tabModes["/repo/notes.markdown"]).toBe("edit");
    expect(store.getState().tabModes["/repo/README.md"]).toBe("view");

    await store.getState().selectFile("/repo/a.ts");
    store.getState().toggleActiveTabMode();
    expect(store.getState().tabModes["/repo/a.ts"]).toBe("edit");
  });

  it("opening files appends tabs in order; re-selecting one dedups", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts");
    await store.getState().selectFile("/repo/a.ts"); // already open — no dup
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/a.ts");
  });

  it("opens only one github tab per project and persists its encoding", async () => {
    const { store, tabEvents } = await makeTabStore();
    store.getState().openGithubTab();
    store.getState().openGithubTab();
    expect(store.getState().openTabs).toEqual([{ kind: "github" }]);
    expect(store.getState().activeTab).toEqual({ kind: "github" });
    expect(tabEvents.at(-1)).toEqual({ root: "/repo", tabs: ["github:"] });
  });

  it("opens one browser tab, persists its url, and follows navigation", async () => {
    const { store, tabEvents } = await makeTabStore();
    store.getState().openBrowserTab();
    store.getState().openBrowserTab();
    expect(store.getState().openTabs).toEqual([{ kind: "browser", url: "" }]);
    expect(tabEvents.at(-1)).toEqual({ root: "/repo", tabs: ["browser:"] });

    store.getState().setBrowserUrl("https://example.com/");
    expect(store.getState().activeTab).toEqual({
      kind: "browser",
      url: "https://example.com/",
    });
    expect(tabEvents.at(-1)).toEqual({
      root: "/repo",
      tabs: ["browser:https://example.com/"],
    });
  });

  it("destroys the native browser when its inactive tab closes", async () => {
    const { store, browserCloses } = await makeTabStore();
    store.getState().openBrowserTab();
    await store.getState().selectFile("/repo/a.ts");

    store.getState().closeTab({ kind: "browser", url: "" });

    expect(browserCloses()).toBe(1);
    expect(store.getState().activeTab).toEqual({ kind: "file", path: "/repo/a.ts" });
    expect(store.getState().openTabs).toEqual([{ kind: "file", path: "/repo/a.ts" }]);
  });

  it("does not save the hidden file while the github tab is active", async () => {
    const { store, files } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("unsaved");
    store.getState().openGithubTab();

    await store.getState().saveFile();

    expect(files.writes).toEqual([]);
    expect(store.getState()).toMatchObject({
      activeTab: { kind: "github" },
      selectedPath: "/repo/a.ts",
      buffer: "unsaved",
      editorStatus: "dirty",
    });

    store.getState().activateTab({ kind: "file", path: "/repo/a.ts" });
    await store.getState().saveFile();
    expect(files.writes).toEqual([{ path: "/repo/a.ts", contents: "unsaved" }]);
  });

  it("restores legacy file paths alongside a github tab and cycles by kind", async () => {
    const { store } = await makeTabStore();
    await store.getState().restoreTabs("/repo", ["/repo/a.ts", "github:", "github:"]);
    expect(store.getState().openTabs).toEqual([
      { kind: "file", path: "/repo/a.ts" },
      { kind: "github" },
    ]);
    expect(store.getState().activeTab).toEqual({ kind: "github" });
    store.getState().cycleTab(1);
    await Promise.resolve();
    expect(store.getState().activeTab).toEqual({ kind: "file", path: "/repo/a.ts" });
  });

  it("restores browser tabs without reading their urls as file paths", async () => {
    const { store, files } = await makeTabStore();
    await store.getState().restoreTabs("/repo", [
      "/repo/a.ts",
      "browser:https://example.com/",
    ]);
    expect(store.getState().openTabs).toEqual([
      { kind: "file", path: "/repo/a.ts" },
      { kind: "browser", url: "https://example.com/" },
    ]);
    expect(files.reads).toEqual(["/repo/a.ts"]);
  });

  it("closing the loaded file behind github preserves its dirty buffer", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("unsaved");
    store.getState().openGithubTab();
    store.getState().closeTab({ kind: "file", path: "/repo/a.ts" });
    expect(store.getState().activeTab).toEqual({ kind: "github" });
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);

    await store.getState().selectFile("/repo/a.ts");
    expect(store.getState().buffer).toBe("unsaved");
  });

  it("closing the active tab activates the left neighbor", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts");
    await store.getState().selectFile("/repo/c.ts"); // active = c
    store.getState().closeTab({ kind: "file", path: "/repo/c.ts" });
    await Promise.resolve();
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/b.ts"); // left of c
  });

  it("closing the first (active) tab activates the new first tab", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts");
    await store.getState().selectFile("/repo/a.ts"); // active = a (index 0)
    store.getState().closeTab({ kind: "file", path: "/repo/a.ts" });
    await Promise.resolve();
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/b.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/b.ts");
  });

  it("closing an inactive tab leaves the active one alone", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts"); // active = b
    store.getState().closeTab({ kind: "file", path: "/repo/a.ts" });
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/b.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/b.ts"); // unchanged
  });

  it("closing the last tab clears the editor", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().closeTab({ kind: "file", path: "/repo/a.ts" });
    const s = store.getState();
    expect(tabStrings(s.openTabs)).toEqual([]);
    expect(s.selectedPath).toBeNull();
    expect(s.activeTab).toBeNull();
    expect(s.buffer).toBe("");
  });

  it("cycleTab moves next/prev and wraps around", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts");
    await store.getState().selectFile("/repo/c.ts"); // active = c (index 2)

    store.getState().cycleTab(1); // wraps to a
    await Promise.resolve();
    expect(store.getState().selectedPath).toBe("/repo/a.ts");

    store.getState().cycleTab(-1); // wraps back to c
    await Promise.resolve();
    expect(store.getState().selectedPath).toBe("/repo/c.ts");
  });

  it("the dirty dot follows a file across a tab switch (stash preserved)", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("A edited"); // a is now dirty
    await store.getState().selectFile("/repo/b.ts"); // switch away stashes a
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  it("closing a background dirty tab keeps its stash (#30 spec: nothing lost silently)", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("A edited");
    await store.getState().selectFile("/repo/b.ts"); // a stashed dirty
    store.getState().closeTab({ kind: "file", path: "/repo/a.ts" });
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true); // stash survives
  });

  it("closing the ACTIVE dirty tab stashes its edits — reopening restores them (#30 spec)", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts"); // active = b
    store.getState().setBuffer("B edited"); // b is dirty and active
    store.getState().closeTab({ kind: "file", path: "/repo/b.ts" }); // close the active dirty tab
    await Promise.resolve();
    const s = store.getState();
    expect(tabStrings(s.openTabs)).toEqual(["/repo/a.ts"]);
    expect(s.selectedPath).toBe("/repo/a.ts"); // left neighbor
    expect(s.dirtyPaths["/repo/b.ts"]).toBe(true); // edits stashed, dot survives

    // Reopening restores the unsaved buffer — nothing was lost silently.
    await store.getState().selectFile("/repo/b.ts");
    expect(store.getState().buffer).toBe("B edited");
    expect(store.getState().editorStatus).toBe("dirty");
  });

  it("closing the LAST dirty tab stashes before the editor resets", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("A edited");
    store.getState().closeTab({ kind: "file", path: "/repo/a.ts" }); // last tab, dirty
    await Promise.resolve();
    expect(store.getState().selectedPath).toBeNull(); // editor empty
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true); // preserved

    await store.getState().selectFile("/repo/a.ts"); // reopen
    expect(store.getState().buffer).toBe("A edited");
    expect(store.getState().editorStatus).toBe("dirty");
  });

  it("emits onTabsChanged when the tab set changes", async () => {
    const { store, tabEvents } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts");
    store.getState().closeTab({ kind: "file", path: "/repo/a.ts" });
    await Promise.resolve();
    // The last recorded event reflects the current set.
    expect(tabEvents.at(-1)).toEqual({ root: "/repo", tabs: ["/repo/b.ts"] });
  });

  // --- Fix: closing/switching away mid-save must not lose edits ---
  it("closing the last tab during an in-flight save that then FAILS restores the buffer on reopen", async () => {
    const { store, files } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("A in flight");

    // Gate the write so the save is in flight (status === "saving").
    files.deferWrite = true;
    const savePromise = store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("saving");

    // Close the (only) tab mid-save — "saving" must be stashed like dirty.
    store.getState().closeTab({ kind: "file", path: "/repo/a.ts" });
    await Promise.resolve();
    expect(store.getState().selectedPath).toBeNull();
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true); // buffer preserved

    // The write fails after the tab closed — the stash must survive.
    files.rejectWrite("read-only");
    await savePromise;
    await Promise.resolve();
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);
    expect(files.writes).toEqual([]); // nothing hit disk

    // Reopening restores the unsaved buffer — nothing was lost.
    await store.getState().selectFile("/repo/a.ts");
    expect(store.getState().buffer).toBe("A in flight");
    expect(store.getState().editorStatus).toBe("dirty");
  });

  it("closing the last tab during an in-flight save that SUCCEEDS reopens clean (no dirty dot)", async () => {
    const { store, files } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("A saved bytes");

    files.deferWrite = true;
    const savePromise = store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("saving");

    // Close the only tab mid-save — stashed as dirty for now.
    store.getState().closeTab({ kind: "file", path: "/repo/a.ts" });
    await Promise.resolve();
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);

    // The write succeeds after the tab closed: the stash equals what was written,
    // so it's clean now — the dot must clear even though nothing is selected.
    files.resolveWrite();
    await savePromise;
    await Promise.resolve();
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBeUndefined();
    expect(files.writes).toEqual([{ path: "/repo/a.ts", contents: "A saved bytes" }]);

    // Reopening reads the just-written bytes as the clean baseline.
    await store.getState().selectFile("/repo/a.ts");
    expect(store.getState().buffer).toBe("A saved bytes");
    expect(store.getState().editorStatus).toBe("clean");
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBeUndefined();
  });

  it("switching away during an in-flight save that FAILS keeps the left file's edits recoverable", async () => {
    const { store, files } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    store.getState().setBuffer("A in flight");

    files.deferWrite = true;
    const savePromise = store.getState().saveFile();
    expect(store.getState().editorStatus).toBe("saving");

    // Switch to b.ts mid-save — a.ts (saving) must be stashed like dirty.
    await store.getState().selectFile("/repo/b.ts");
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);

    files.rejectWrite("read-only");
    await savePromise;
    await Promise.resolve();
    expect(store.getState().dirtyPaths["/repo/a.ts"]).toBe(true);

    // Reopen a.ts — the unsaved buffer is restored.
    await store.getState().selectFile("/repo/a.ts");
    expect(store.getState().buffer).toBe("A in flight");
    expect(store.getState().editorStatus).toBe("dirty");
  });

  it("tabs are per-project — switching roots swaps the visible set", async () => {
    const { store, files } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts");

    // Switch to a second project — its tab set starts empty.
    files.fileReads.set("/other/x.ts", { kind: "text", content: "X" });
    await store.getState().setRoot("/other");
    expect(tabStrings(store.getState().openTabs)).toEqual([]);
    await store.getState().selectFile("/other/x.ts");
    expect(tabStrings(store.getState().openTabs)).toEqual(["/other/x.ts"]);

    // Switch back — the original project's tabs are restored.
    await store.getState().setRoot("/repo");
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  it("restoreTabs opens persisted tabs and prunes ones that fail to read", async () => {
    const { store, files } = await makeTabStore();
    files.readFailPaths.add("/repo/gone.ts"); // deleted since last session
    await store
      .getState()
      .restoreTabs("/repo", ["/repo/a.ts", "/repo/gone.ts", "/repo/b.ts"]);
    const s = store.getState();
    expect(tabStrings(s.openTabs)).toEqual(["/repo/a.ts", "/repo/b.ts"]); // gone.ts dropped
    expect(s.selectedPath).toBe("/repo/b.ts"); // last valid becomes active
  });

  it("restores persisted drive and UNC file tabs under case-varied roots", async () => {
    const files = new MockFiles();
    const store = createFilesStore({ files });
    const driveRoot = "C:\\Users\\Keith\\Repo";
    const driveFile = "c:\\users\\keith\\repo\\src\\app.ts";
    files.fileReads.set(driveFile, { kind: "text", content: "drive" });
    await store.getState().setRoot(driveRoot);
    await store.getState().restoreTabs(driveRoot, [driveFile]);
    expect(tabStrings(store.getState().openTabs)).toEqual([driveFile]);

    const uncRoot = "\\\\server\\share\\Repo";
    const uncFile = "\\\\SERVER\\SHARE\\repo\\README.md";
    files.fileReads.set(uncFile, { kind: "text", content: "unc" });
    await store.getState().setRoot(uncRoot);
    await store.getState().restoreTabs(uncRoot, [uncFile]);
    expect(tabStrings(store.getState().openTabs)).toEqual([uncFile]);
  });

  it("restoreTabs keeps supported image and PDF viewer tabs", async () => {
    const { store } = await makeTabStore();
    await store.getState().restoreTabs("/repo", ["/repo/diagram.png", "/repo/drawing.pdf"]);

    expect(tabStrings(store.getState().openTabs)).toEqual([
      "/repo/diagram.png",
      "/repo/drawing.pdf",
    ]);
    expect(store.getState().selectedPath).toBe("/repo/drawing.pdf");
  });

  it("restoreTabs prunes a viewer path outside its root before reading it", async () => {
    const { store, files } = await makeTabStore();
    files.fileReads.set("/other/diagram.png", { kind: "binary", bytes: 4_096 });

    await store.getState().restoreTabs("/repo", [
      "/other/diagram.png",
      "/repo/../other/diagram.png",
      "/repo/diagram.png",
    ]);

    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/diagram.png"]);
    expect(files.reads).not.toContain("/other/diagram.png");
    expect(files.reads).not.toContain("/repo/../other/diagram.png");
  });

  it("restoreTabs bails when the root has been superseded", async () => {
    const { store, files } = await makeTabStore();
    files.fileReads.set("/other/x.ts", { kind: "text", content: "X" });
    await store.getState().setRoot("/other");
    // Restore for the old root now that /other is active — must no-op.
    await store.getState().restoreTabs("/repo", ["/repo/a.ts"]);
    expect(tabStrings(store.getState().openTabs)).toEqual([]);
  });

  // --- Fix: restoreTabs generation guard ---
  it("restoreTabs paused mid-read yields to an A→B→A switch (no clobber of the new /repo)", async () => {
    const { store, files } = await makeTabStore();
    files.fileReads.set("/other/x.ts", { kind: "text", content: "X" });

    // Start a restore for /repo, gated in the first readFile so it pauses in
    // its loop with the ORIGINAL /repo generation captured.
    files.deferRead = true;
    const restore = store.getState().restoreTabs("/repo", ["/repo/a.ts", "/repo/b.ts"]);
    await Promise.resolve();

    // A→B→A: leave /repo, then come back — this is a NEWER /repo generation
    // with its own watcher/tree, even though rootPath is /repo again.
    files.deferRead = false;
    await store.getState().setRoot("/other");
    await store.getState().setRoot("/repo");
    // The user opens a live tab under the new /repo generation.
    await store.getState().selectFile("/repo/b.ts");
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/b.ts"]);

    // Release the stale restore's paused read: it must bail on the generation
    // change and NOT overwrite the live tab set with its own [a, b].
    files.resolveRead();
    await restore;
    await Promise.resolve();
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/b.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/b.ts");
  });

  it("restoreTabs yields when the user opens a tab mid-restore (their state wins)", async () => {
    const { store, files } = await makeTabStore();

    // Gate the restore's reads so it pauses inside the loop (same generation).
    files.deferRead = true;
    const restore = store.getState().restoreTabs("/repo", ["/repo/a.ts", "/repo/b.ts"]);
    await Promise.resolve();

    // The user opens c.ts while the restore is paused — live tab activity that
    // diverges from the snapshot the restore captured at start.
    files.deferRead = false;
    await store.getState().selectFile("/repo/c.ts");
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/c.ts"]);

    // Release the paused read: the restore must detect the snapshot changed and
    // yield rather than publishing its stale [a, b] over the user's [c].
    files.resolveRead();
    await restore;
    await Promise.resolve();
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/c.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/c.ts");
  });

  // --- Integration: rename remaps open tabs, trash closes them ---

  it("renaming a BACKGROUND file's tab remaps it and fires onTabsChanged", async () => {
    const { store, files, tabEvents } = await makeTabStore();
    // Load the root listing so rename validation sees the parent's children.
    files.tree.set("/repo", [file("a.ts", "/repo/a.ts"), file("b.ts", "/repo/b.ts")]);
    await store.getState().setRoot("/repo");
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts"); // a is background, b active

    tabEvents.length = 0; // isolate the rename's persistence event
    store.getState().beginRename(file("a.ts", "/repo/a.ts"));
    store.getState().setEditDraft("renamed.ts");
    await store.getState().commitEdit();

    // The background tab's path follows the rename; the active tab is untouched.
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/renamed.ts", "/repo/b.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/b.ts");
    // Persistence sees the remapped set.
    expect(tabEvents.at(-1)).toEqual({
      root: "/repo",
      tabs: ["/repo/renamed.ts", "/repo/b.ts"],
    });
  });

  it("renaming the ACTIVE file remaps its tab and the selection together", async () => {
    const { store, files } = await makeTabStore();
    files.tree.set("/repo", [file("a.ts", "/repo/a.ts"), file("b.ts", "/repo/b.ts")]);
    await store.getState().setRoot("/repo");
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts"); // b is active

    store.getState().beginRename(file("b.ts", "/repo/b.ts"));
    store.getState().setEditDraft("renamed.ts");
    await store.getState().commitEdit();

    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/a.ts", "/repo/renamed.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/renamed.ts"); // active follows
  });

  it("renaming an ancestor DIR remaps nested tabs", async () => {
    const { store, files } = await makeTabStore();
    // /repo/src/index.ts and /repo/src/util.ts both open; rename /repo/src.
    files.tree.set("/repo", [dir("src", "/repo/src"), file("a.ts", "/repo/a.ts")]);
    files.tree.set("/repo/src", [
      file("index.ts", "/repo/src/index.ts"),
      file("util.ts", "/repo/src/util.ts"),
    ]);
    files.fileReads.set("/repo/src/index.ts", { kind: "text", content: "I" });
    files.fileReads.set("/repo/src/util.ts", { kind: "text", content: "U" });
    await store.getState().setRoot("/repo");
    await store.getState().toggleDir("/repo/src");
    await store.getState().selectFile("/repo/src/index.ts");
    await store.getState().selectFile("/repo/src/util.ts"); // util active, index background

    store.getState().beginRename(dir("src", "/repo/src"));
    store.getState().setEditDraft("lib");
    await store.getState().commitEdit();

    // Both nested tabs remap component-aware; active selection follows too.
    expect(tabStrings(store.getState().openTabs)).toEqual([
      "/repo/lib/index.ts",
      "/repo/lib/util.ts",
    ]);
    expect(store.getState().selectedPath).toBe("/repo/lib/util.ts");
  });

  it("trashing a BACKGROUND file closes its tab and fires onTabsChanged", async () => {
    const { store, files, tabEvents } = await makeTabStore();
    files.tree.set("/repo", [file("a.ts", "/repo/a.ts"), file("b.ts", "/repo/b.ts")]);
    await store.getState().setRoot("/repo");
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts"); // a background, b active

    tabEvents.length = 0;
    await store.getState().trashEntry(file("a.ts", "/repo/a.ts"));

    // The background tab closes; the active file's tab stays.
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/b.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/b.ts");
    expect(tabEvents.at(-1)).toEqual({ root: "/repo", tabs: ["/repo/b.ts"] });
  });

  it("trashing an ancestor DIR closes every nested background tab", async () => {
    const { store, files } = await makeTabStore();
    files.tree.set("/repo", [dir("src", "/repo/src"), file("a.ts", "/repo/a.ts")]);
    files.tree.set("/repo/src", [file("index.ts", "/repo/src/index.ts")]);
    files.fileReads.set("/repo/src/index.ts", { kind: "text", content: "I" });
    await store.getState().setRoot("/repo");
    await store.getState().toggleDir("/repo/src");
    await store.getState().selectFile("/repo/src/index.ts"); // nested tab open
    await store.getState().selectFile("/repo/a.ts"); // a active, nested is background

    await store.getState().trashEntry(dir("src", "/repo/src"));

    // The nested tab under the trashed dir closes; the active file's tab stays.
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/a.ts"]);
    expect(store.getState().selectedPath).toBe("/repo/a.ts");
  });

  // --- Fix: prune tabsByRoot on project removal ---
  it("dropTabsForRoot forgets a background root's tabs (re-adding starts empty)", async () => {
    const { store, files } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts");
    // Leave /repo for another project so /repo is a BACKGROUND root.
    files.fileReads.set("/other/x.ts", { kind: "text", content: "X" });
    await store.getState().setRoot("/other");
    expect(tabStrings(store.getState().getTabsForRoot("/repo"))).toEqual(["/repo/a.ts", "/repo/b.ts"]);

    // Project removed: drop its tab closure entry.
    store.getState().dropTabsForRoot("/repo");
    expect(tabStrings(store.getState().getTabsForRoot("/repo"))).toEqual([]);

    // Re-adding the same folder starts with no tabs.
    await store.getState().setRoot("/repo");
    expect(tabStrings(store.getState().openTabs)).toEqual([]);
  });

  it("dropTabsForRoot clears the visible openTabs when it's the active root", async () => {
    const { store } = await makeTabStore();
    await store.getState().selectFile("/repo/a.ts");
    await store.getState().selectFile("/repo/b.ts");
    expect(tabStrings(store.getState().openTabs)).toEqual(["/repo/a.ts", "/repo/b.ts"]);

    // Removing the active project drops its closure and clears the strip.
    store.getState().dropTabsForRoot("/repo");
    expect(tabStrings(store.getState().openTabs)).toEqual([]);
    expect(tabStrings(store.getState().getTabsForRoot("/repo"))).toEqual([]);
  });

  // --- KödSSH remote tabs (M11d) ---

  it("keeps remote project tabs usable when there is no local file root", () => {
    const store = createFilesStore({ files: new MockFiles() });
    const tree = { kind: "remote-files", host: "box", path: "/srv/app" } as const;
    const preview = {
      kind: "remote-preview",
      host: "box",
      path: "/srv/app/src/main.ts",
    } as const;

    store.getState().openRemoteFilesTab(tree.host, tree.path);
    store.getState().openRemotePreviewTab(preview.host, preview.path);
    expect(store.getState().openTabs).toEqual([tree, preview]);
    expect(store.getState().activeTab).toEqual(preview);

    store.getState().cycleTab(1);
    expect(store.getState().activeTab).toEqual(tree);
    store.getState().closeTab(tree);
    expect(store.getState().openTabs).toEqual([preview]);
    expect(store.getState().activeTab).toEqual(preview);
  });

  it("keeps remote tabs scoped when switching between remote projects", async () => {
    const store = createFilesStore({ files: new MockFiles() });
    await store.getState().setRemoteScope("remote:box:%2Fsrv%2Fapp");
    store.getState().openRemoteFilesTab("box", "/srv/app");

    await store.getState().setRemoteScope("remote:vps:%2Fsrv%2Fother");
    expect(store.getState().openTabs).toEqual([]);
    store.getState().openRemoteFilesTab("vps", "/srv/other");

    await store.getState().setRemoteScope("remote:box:%2Fsrv%2Fapp");
    expect(store.getState().openTabs).toEqual([
      { kind: "remote-files", host: "box", path: "/srv/app" },
    ]);
    expect(store.getState().activeTab).toEqual({
      kind: "remote-files",
      host: "box",
      path: "/srv/app",
    });
  });

  it("openRemoteFilesTab opens (or activates) one tab per host:path", async () => {
    const { store } = await makeTabStore();
    store.getState().openRemoteFilesTab("box", "/repo");
    expect(tabStrings(store.getState().openTabs)).toEqual(["remote-files:box\0/repo"]);
    expect(store.getState().activeTab).toEqual({ kind: "remote-files", host: "box", path: "/repo" });

    // Opening a file tab, then re-opening the same remote target activates
    // it rather than duplicating it (order unchanged — no new tab appended).
    await store.getState().selectFile("/repo/a.ts");
    store.getState().openRemoteFilesTab("box", "/repo");
    expect(tabStrings(store.getState().openTabs)).toEqual(["remote-files:box\0/repo", "/repo/a.ts"]);
    expect(store.getState().activeTab).toEqual({ kind: "remote-files", host: "box", path: "/repo" });

    // A different path on the same host is a distinct tab.
    store.getState().openRemoteFilesTab("box", "/other");
    expect(tabStrings(store.getState().openTabs)).toEqual([
      "remote-files:box\0/repo",
      "/repo/a.ts",
      "remote-files:box\0/other",
    ]);
  });

  it("openRemotePreviewTab opens (or activates) one read-only tab per file", async () => {
    const { store } = await makeTabStore();
    store.getState().openRemotePreviewTab("box", "/repo/a.ts");
    expect(store.getState().activeTab).toEqual({ kind: "remote-preview", host: "box", path: "/repo/a.ts" });

    store.getState().openRemoteFilesTab("box", "/repo");
    store.getState().openRemotePreviewTab("box", "/repo/a.ts");
    expect(tabStrings(store.getState().openTabs)).toEqual([
      "remote-preview:box\0/repo/a.ts",
      "remote-files:box\0/repo",
    ]);
    expect(store.getState().activeTab).toEqual({ kind: "remote-preview", host: "box", path: "/repo/a.ts" });
  });

  it("closing a remote-preview tab notifies onRemotePreviewClosed with host+path", async () => {
    const files = new MockFiles();
    const closed: { host: string; path: string }[] = [];
    const store = createFilesStore({
      files,
      onRemotePreviewClosed: (host, path) => closed.push({ host, path }),
    });
    await store.getState().setRoot("/repo");
    store.getState().openRemotePreviewTab("box", "/repo/a.ts");

    store.getState().closeTab({ kind: "remote-preview", host: "box", path: "/repo/a.ts" });

    expect(closed).toEqual([{ host: "box", path: "/repo/a.ts" }]);
    expect(store.getState().openTabs).toEqual([]);
  });

  it("closing a remote-files tab notifies onRemoteFilesClosed with host+path", async () => {
    const files = new MockFiles();
    const closed: { host: string; path: string }[] = [];
    const store = createFilesStore({
      files,
      onRemoteFilesClosed: (host, path) => closed.push({ host, path }),
    });
    await store.getState().setRoot("/repo");
    store.getState().openRemoteFilesTab("box", "/srv/app");

    store.getState().closeTab({ kind: "remote-files", host: "box", path: "/srv/app" });

    expect(closed).toEqual([{ host: "box", path: "/srv/app" }]);
    expect(store.getState().openTabs).toEqual([]);
  });
});
