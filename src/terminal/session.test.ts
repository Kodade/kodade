// Frontend wiring tests: TerminalSession against a MOCK of the typed IPC
// contract. We test data plumbing only — never xterm rendering internals.

import { describe, expect, it, vi } from "vitest";
import { MockPtyIpc } from "../ipc/mock";
import { toBase64 } from "./base64";
import { TerminalSession, type TermSink } from "./session";

// A tiny sink that records the bytes the session writes to the terminal.
function recordingSink() {
  const chunks: Uint8Array[] = [];
  const sink: TermSink = { write: (d) => chunks.push(d) };
  const text = () => {
    // Concatenate raw bytes and decode ONCE — same as xterm's streaming
    // decoder, so multibyte sequences split across chunks stay intact.
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.length;
    }
    return new TextDecoder().decode(all);
  };
  return { sink, chunks, text };
}

// base64 for raw bytes (test-side twin of the Rust encoder).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function makeSession(
  ipc: MockPtyIpc,
  sink: TermSink,
  onExit?: (code: number | null) => void,
  onOutput?: () => void,
) {
  return new TerminalSession(ipc, sink, {
    id: "s1",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    onExit,
    onOutput,
  });
}

// Flush microtasks until cond() holds (bounded so a bug can't hang the suite).
async function flushUntil(cond: () => boolean) {
  for (let i = 0; i < 20 && !cond(); i++) await Promise.resolve();
  expect(cond()).toBe(true);
}

describe("TerminalSession", () => {
  it("spawns with the given id, cwd, and size", async () => {
    const ipc = new MockPtyIpc();
    const { sink } = recordingSink();
    const s = makeSession(ipc, sink);
    await s.start();

    expect(ipc.spawns).toEqual([{ id: "s1", cwd: "/repo", cols: 80, rows: 24 }]);
    expect(s.state).toBe("live");
  });

  it("routes matching output events to the terminal sink (base64-decoded)", async () => {
    const ipc = new MockPtyIpc();
    const { sink, text } = recordingSink();
    const s = makeSession(ipc, sink);
    await s.start();

    ipc.emitOutput({ id: "s1", data: toBase64("hello\r\n") });
    expect(text()).toBe("hello\r\n");
  });

  it("reports output activity without exposing terminal bytes to the callback", async () => {
    const ipc = new MockPtyIpc();
    const { sink } = recordingSink();
    const onOutput = vi.fn();
    const s = makeSession(ipc, sink, undefined, onOutput);
    await s.start();

    ipc.emitOutput({ id: "s1", data: toBase64("private terminal text") });
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith();
  });

  it("ignores output events for other session ids", async () => {
    const ipc = new MockPtyIpc();
    const { sink, text } = recordingSink();
    const s = makeSession(ipc, sink);
    await s.start();

    ipc.emitOutput({ id: "other", data: toBase64("nope") });
    expect(text()).toBe("");
  });

  it("reassembles multibyte UTF-8 split across two output events", async () => {
    const ipc = new MockPtyIpc();
    const { sink, chunks, text } = recordingSink();
    const s = makeSession(ipc, sink);
    await s.start();

    // "héllo" — é is two bytes (0xC3 0xA9); split the stream mid-é.
    const bytes = new TextEncoder().encode("héllo");
    ipc.emitOutput({ id: "s1", data: bytesToBase64(bytes.slice(0, 2)) });
    ipc.emitOutput({ id: "s1", data: bytesToBase64(bytes.slice(2)) });

    // Two raw-byte chunks delivered; combined they decode losslessly. If the
    // session decoded each chunk to a string, the split é would be mangled.
    expect(chunks.length).toBe(2);
    expect(text()).toBe("héllo");
  });

  it("sends input as base64-encoded write calls", async () => {
    const ipc = new MockPtyIpc();
    const { sink } = recordingSink();
    const s = makeSession(ipc, sink);
    await s.start();

    await s.input("echo hi\n");
    expect(ipc.writes).toEqual([{ id: "s1", data: toBase64("echo hi\n") }]);
  });

  it("surfaces command write failures to one-click launch callers", async () => {
    const ipc = new MockPtyIpc();
    const failing = Object.create(ipc) as MockPtyIpc;
    failing.write = () => Promise.reject(new Error("write failed"));
    const { sink } = recordingSink();
    const s = makeSession(failing, sink);
    await s.start();

    await expect(s.command("claude\r")).rejects.toThrow("write failed");
  });

  it("forwards resize with cols/rows to the IPC when live", async () => {
    const ipc = new MockPtyIpc();
    const { sink } = recordingSink();
    const s = makeSession(ipc, sink);
    await s.start();

    await s.resize(120, 40);
    expect(ipc.resizes).toEqual([{ id: "s1", cols: 120, rows: 40 }]);
  });

  it("queues resizes during start and replays only the newest once live", async () => {
    const ipc = new MockPtyIpc();
    ipc.deferSpawn = true;
    const { sink } = recordingSink();
    const s = makeSession(ipc, sink);

    const startP = s.start();
    await flushUntil(() => ipc.spawns.length === 1);
    void s.resize(100, 30);
    void s.resize(120, 40); // newest wins
    expect(ipc.resizes).toEqual([]); // nothing sent while starting

    ipc.resolveSpawn();
    await startP;
    expect(ipc.resizes).toEqual([{ id: "s1", cols: 120, rows: 40 }]);
  });

  it("queues input during start and flushes it in order once live", async () => {
    const ipc = new MockPtyIpc();
    ipc.deferSpawn = true;
    const { sink } = recordingSink();
    const s = makeSession(ipc, sink);

    // A provider launch types its command the instant the session is created —
    // before the shell is live. It must arrive, in order, not be dropped.
    const startP = s.start();
    await flushUntil(() => ipc.spawns.length === 1);
    void s.input("claude");
    void s.input("\r");
    expect(ipc.writes).toEqual([]); // nothing sent while starting

    ipc.resolveSpawn();
    await startP;
    expect(ipc.writes).toEqual([{ id: "s1", data: toBase64("claude\r") }]);
  });

  it("a failing startup resize neither aborts start nor loses queued input", async () => {
    const ipc = new MockPtyIpc();
    ipc.deferSpawn = true;
    // Same IPC, but resize always rejects (e.g. the shell exited under it).
    const flaky = Object.create(ipc) as MockPtyIpc;
    flaky.resize = () => Promise.reject(new Error("resize failed"));
    const { sink } = recordingSink();
    const s = makeSession(flaky, sink);

    const startP = s.start();
    await flushUntil(() => ipc.spawns.length === 1);
    void s.resize(100, 30); // queued; will be replayed and fail
    void s.input("claude\r"); // must still arrive

    ipc.resolveSpawn();
    await startP; // must not reject
    expect(s.state).toBe("live");
    expect(ipc.writes).toEqual([{ id: "s1", data: toBase64("claude\r") }]);
  });

  it("fires onExit for matching exit events", async () => {
    const ipc = new MockPtyIpc();
    const { sink } = recordingSink();
    const onExit = vi.fn();
    const s = makeSession(ipc, sink, onExit);
    await s.start();

    ipc.emitExit({ id: "s1", code: 0 });
    expect(onExit).toHaveBeenCalledWith(0);
    expect(s.state).toBe("exited");
  });

  it("an exit observed mid-start sticks — the session never goes live", async () => {
    const ipc = new MockPtyIpc();
    ipc.deferSpawn = true;
    const { sink } = recordingSink();
    const onExit = vi.fn();
    const s = makeSession(ipc, sink, onExit);

    const startP = s.start();
    await flushUntil(() => ipc.spawns.length === 1);
    // Shell dies while spawn is still resolving (fast-exit race).
    ipc.emitExit({ id: "s1", code: 127 });
    ipc.resolveSpawn();
    await startP;

    expect(s.state).toBe("exited");
    expect(onExit).toHaveBeenCalledWith(127);
    // An exited session must not talk to a dead PTY.
    await s.resize(100, 30);
    await s.input("x");
    expect(ipc.resizes).toEqual([]);
    expect(ipc.writes).toEqual([]);
  });

  it("dispose during a pending start kills the late-spawned PTY and writes nothing", async () => {
    const ipc = new MockPtyIpc();
    ipc.deferSpawn = true;
    const { sink, text } = recordingSink();
    const s = makeSession(ipc, sink);

    const startP = s.start();
    await flushUntil(() => ipc.spawns.length === 1);
    await s.dispose(); // unmount races the in-flight spawn
    expect(ipc.kills).toEqual([]); // nothing to kill yet — spawn still pending

    ipc.resolveSpawn();
    await startP;

    // start() noticed it was disposed and killed the PTY it just created.
    expect(ipc.kills).toEqual([{ id: "s1" }]);
    expect(s.state).toBe("disposed");
    // No output may reach a disposed terminal.
    ipc.emitOutput({ id: "s1", data: toBase64("late") });
    expect(text()).toBe("");
  });

  it("kills the PTY and stops routing events after dispose", async () => {
    const ipc = new MockPtyIpc();
    const { sink, text } = recordingSink();
    const s = makeSession(ipc, sink);
    await s.start();
    await s.dispose();

    expect(ipc.kills).toEqual([{ id: "s1" }]);
    // Listeners are removed on dispose, so late output must not reach the sink.
    ipc.emitOutput({ id: "s1", data: toBase64("late") });
    expect(text()).toBe("");
  });

  it("dispose before spawn happens never spawns or kills", async () => {
    const ipc = new MockPtyIpc();
    const { sink } = recordingSink();
    const s = makeSession(ipc, sink);

    const startP = s.start();
    await s.dispose(); // dispose lands before start reaches spawn
    await startP;

    expect(ipc.spawns).toEqual([]); // start bailed at a disposed checkpoint
    expect(ipc.kills).toEqual([]); // no PTY ever existed — nothing to kill
  });

  it("a failed spawn marks the session exited and fires onExit(null)", async () => {
    const ipc = new MockPtyIpc();
    ipc.failSpawnWith = "no such directory";
    const { sink } = recordingSink();
    const onExit = vi.fn();
    const s = makeSession(ipc, sink, onExit);

    await expect(s.start()).rejects.toBe("no such directory");
    expect(s.state).toBe("exited");
    expect(onExit).toHaveBeenCalledWith(null); // UIs treat it like a dead shell
    // A dead-on-arrival session never talks to the PTY...
    await s.input("x");
    await s.resize(100, 30);
    expect(ipc.writes).toEqual([]);
    expect(ipc.resizes).toEqual([]);
    // ...and dispose stays safe: no PTY was created, so nothing to kill.
    await s.dispose();
    expect(ipc.kills).toEqual([]);
  });
});
