import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockPlatform, MockStorage } from "../ipc/mock";
import {
  clearTerminalDropTarget,
  setTerminalDropTarget,
} from "../terminal/drop-target";
import { clearChatDropTarget, setChatDropTarget } from "../chat/drop-target";
import { routeFileDrop } from "./drop-routing";
import { createProjectsStore } from "./projects";

function fakeRegistry() {
  const writes: { id: string; data: string }[] = [];
  return {
    writes,
    registry: {
      open: () => {},
      close: async () => {},
      write: (id: string, data: string) => void writes.push({ id, data }),
      paste: async (id: string, data: string) => void writes.push({ id, data }),
    },
  };
}

function makeStore() {
  let nextId = 0;
  const { registry, writes } = fakeRegistry();
  const store = createProjectsStore({
    storage: new MockStorage(),
    registry,
    newId: () => `id-${++nextId}`,
  });
  void store.getState().hydrate();
  return { store, registry, writes };
}

function installTarget(
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
) {
  const target = document.createElement("div");
  Object.defineProperty(target, "getBoundingClientRect", {
    value: () => ({ ...rect }) as DOMRect,
  });
  setTerminalDropTarget(target);
}

beforeEach(() => {
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 2,
  });
});

afterEach(() => {
  clearTerminalDropTarget();
  clearChatDropTarget();
});

function installChatTarget(
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  onPaths: (paths: string[]) => void,
) {
  const target = document.createElement("div");
  Object.defineProperty(target, "getBoundingClientRect", {
    value: () => ({ ...rect }) as DOMRect,
  });
  setChatDropTarget(target, onPaths);
}

describe("file drop routing", () => {
  it("the mock seam exposes the native drop position with its paths", async () => {
    const platform = new MockPlatform();
    let received: {
      paths: string[];
      position: { x: number; y: number };
    } | null = null;
    await platform.onFileDrop((drop) => {
      received = drop;
    });

    platform.emitDrop(["/tmp/dropped"], { x: 600, y: 800 });

    expect(received).toEqual({
      paths: ["/tmp/dropped"],
      position: { x: 600, y: 800 },
    });
  });

  it("pastes escaped paths into the active terminal for a physical position inside its CSS rect", async () => {
    const platform = new MockPlatform();
    platform.dirs.add("/tmp/a file"); // directories still paste when dropped on a terminal
    const { store, registry, writes } = makeStore();
    await store.getState().addProject("/repos/project");
    const sessionId = store.getState().sessions[0].id;
    installTarget({ left: 100, top: 200, right: 500, bottom: 600 });

    await routeFileDrop(
      {
        paths: ["/tmp/a file", "/tmp/Keith's.txt"],
        position: { x: 600, y: 800 },
      },
      { platform, projects: store, registry },
    );

    expect(writes).toEqual([
      { id: sessionId, data: "'/tmp/a file' '/tmp/Keith'\\''s.txt' " },
    ]);
    expect(store.getState().projects).toHaveLength(1);
  });

  it("uses PowerShell verbatim quoting for terminal drops", async () => {
    const platform = new MockPlatform();
    const { store, registry, writes } = makeStore();
    store.getState().setShellBase("pwsh.exe");
    await store.getState().addProject("C:\\repos\\project");
    const sessionId = store.getState().sessions[0].id;
    installTarget({ left: 100, top: 200, right: 500, bottom: 600 });

    await routeFileDrop(
      {
        paths: ["C:\\Users\\Keith's Project\\设计 🚀"],
        position: { x: 600, y: 800 },
      },
      { platform, projects: store, registry },
    );

    expect(writes).toEqual([
      { id: sessionId, data: "'C:\\Users\\Keith''s Project\\设计 🚀' " },
    ]);
  });

  it("waits for an asynchronous terminal paste", async () => {
    const platform = new MockPlatform();
    const { store, registry, writes } = makeStore();
    await store.getState().addProject("/repos/project");
    const sessionId = store.getState().sessions[0].id;
    installTarget({ left: 100, top: 200, right: 500, bottom: 600 });
    let release!: () => void;
    registry.paste = async (id: string, data: string) => {
      await new Promise<void>((resolve) => (release = resolve));
      writes.push({ id, data });
    };

    const routed = routeFileDrop(
      { paths: ["/tmp/a file"], position: { x: 600, y: 800 } },
      { platform, projects: store, registry },
    );
    expect(writes).toEqual([]);
    release();
    await routed;
    expect(writes).toEqual([
      { id: sessionId, data: "'/tmp/a file' " },
    ]);
  });

  it("uses cmd quoting and refuses environment-expanding paths", async () => {
    const platform = new MockPlatform();
    const { store, registry, writes } = makeStore();
    store.getState().setShellBase("cmd.exe");
    await store.getState().addProject("C:\\repos\\project");
    const sessionId = store.getState().sessions[0].id;
    installTarget({ left: 100, top: 200, right: 500, bottom: 600 });

    await routeFileDrop(
      {
        paths: ["C:\\Users\\Keith & Team\\设计 🚀", "C:\\%TEMP%\\unsafe"],
        position: { x: 600, y: 800 },
      },
      { platform, projects: store, registry },
    );

    expect(writes).toEqual([
      { id: sessionId, data: '"C:\\Users\\Keith & Team\\设计 🚀" ' },
    ]);
  });

  it("keeps directory drops outside the terminal on the existing add-project path", async () => {
    const platform = new MockPlatform();
    platform.dirs.add("/repos/dropped");
    const { store, registry, writes } = makeStore();
    installTarget({ left: 100, top: 200, right: 500, bottom: 600 });

    await routeFileDrop(
      {
        paths: ["/repos/dropped", "/tmp/not-a-directory"],
        position: { x: 1200, y: 800 },
      },
      { platform, projects: store, registry },
    );

    expect(writes).toEqual([]);
    expect(store.getState().projects.map((project) => project.path)).toEqual([
      "/repos/dropped",
    ]);
  });

  it("a drop on the chat pane becomes composer attachments, not a project", async () => {
    const platform = new MockPlatform();
    platform.dirs.add("/repos/dropped");
    const { store, registry, writes } = makeStore();
    const attached: string[][] = [];
    installChatTarget({ left: 100, top: 200, right: 500, bottom: 600 }, (paths) =>
      attached.push(paths),
    );

    await routeFileDrop(
      {
        paths: ["/tmp/screenshot.png", "/repos/dropped"],
        position: { x: 600, y: 800 },
      },
      { platform, projects: store, registry },
    );

    expect(attached).toEqual([["/tmp/screenshot.png", "/repos/dropped"]]);
    expect(writes).toEqual([]);
    expect(store.getState().projects).toHaveLength(0);
  });

  it("the terminal split outranks the surrounding chat region", async () => {
    const platform = new MockPlatform();
    const { store, registry, writes } = makeStore();
    await store.getState().addProject("/repos/project");
    const sessionId = store.getState().sessions[0].id;
    const attached: string[][] = [];
    // The terminal split renders INSIDE the chat pane, so both rects contain
    // the drop point; the more specific terminal target must win.
    installTarget({ left: 100, top: 200, right: 500, bottom: 600 });
    installChatTarget({ left: 0, top: 0, right: 800, bottom: 900 }, (paths) =>
      attached.push(paths),
    );

    await routeFileDrop(
      { paths: ["/tmp/a file"], position: { x: 600, y: 800 } },
      { platform, projects: store, registry },
    );

    expect(attached).toEqual([]);
    expect(writes).toEqual([{ id: sessionId, data: "'/tmp/a file' " }]);
  });

  it("a terminal drop with no live session falls through — a folder still becomes a project", async () => {
    const platform = new MockPlatform();
    platform.dirs.add("/repos/dropped");
    const { store, registry, writes } = makeStore();
    installTarget({ left: 100, top: 200, right: 500, bottom: 600 });

    await routeFileDrop(
      { paths: ["/repos/dropped"], position: { x: 600, y: 800 } },
      { platform, projects: store, registry },
    );

    expect(writes).toEqual([]); // nothing to paste into
    expect(store.getState().projects.map((p) => p.path)).toEqual([
      "/repos/dropped",
    ]);
  });
});
