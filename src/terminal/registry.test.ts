// Registry bookkeeping tests with a fake terminal factory — open-once,
// close-once, and show-only-active DOM behavior. No xterm involved.

import { describe, expect, it, vi } from "vitest";
import type { ITheme } from "@xterm/xterm";
import { SessionRegistry, type TerminalHandle } from "./registry";

function fakeFactory() {
  const created: string[] = [];
  const disposed: string[] = [];
  const wrote: { id: string; data: string }[] = [];
  const themed: { id: string; theme: ITheme }[] = [];
  const factory = ({ id }: { id: string; cwd: string }): TerminalHandle => {
    created.push(id);
    return {
      host: document.createElement("div"),
      ready: Promise.resolve(),
      focus: vi.fn(),
      paste: async (data: string) => void wrote.push({ id, data }),
      write: async (data: string) => void wrote.push({ id, data }),
      bracketedPasteMode: () => false,
      setTheme: (theme: ITheme) => void themed.push({ id, theme }),
      dispose: async () => void disposed.push(id),
    };
  };
  return { factory, created, disposed, wrote, themed };
}

describe("SessionRegistry", () => {
  it("open is idempotent per id", () => {
    const { factory, created } = fakeFactory();
    const reg = new SessionRegistry(factory);
    reg.open("a", "/x");
    reg.open("a", "/x");
    expect(created).toEqual(["a"]);
  });

  it("close disposes exactly once and removes the host from the DOM", async () => {
    const { factory, disposed } = fakeFactory();
    const reg = new SessionRegistry(factory);
    reg.open("a", "/x");

    const container = document.createElement("div");
    reg.sync(container, "a");
    expect(container.children).toHaveLength(1);

    await reg.close("a");
    await reg.close("a"); // double-close is a no-op
    expect(disposed).toEqual(["a"]);
    expect(container.children).toHaveLength(0);
    expect(reg.has("a")).toBe(false);
  });

  it("sync shows only the active host; background hosts stay attached but hidden", () => {
    const { factory } = fakeFactory();
    const reg = new SessionRegistry(factory);
    reg.open("a", "/x");
    reg.open("b", "/y");

    const container = document.createElement("div");
    reg.sync(container, "a");
    expect(container.children).toHaveLength(2); // both in the DOM
    const [hostA, hostB] = [...container.children] as HTMLElement[];
    expect(hostA.style.display).toBe("");
    expect(hostB.style.display).toBe("none");

    // Switch: b becomes visible, a hides — neither is removed or rebuilt.
    reg.sync(container, "b");
    expect(hostA.style.display).toBe("none");
    expect(hostB.style.display).toBe("");
    expect(container.children).toHaveLength(2);
  });

  it("sync can keep several split terminals visible while focusing one", () => {
    const { factory } = fakeFactory();
    const reg = new SessionRegistry(factory);
    reg.open("a", "/x");
    reg.open("b", "/y");
    reg.open("c", "/z");

    const container = document.createElement("div");
    reg.sync(container, ["a", "c"], "c");

    const [hostA, hostB, hostC] = [...container.children] as HTMLElement[];
    expect(hostA.style.display).toBe("");
    expect(hostB.style.display).toBe("none");
    expect(hostC.style.display).toBe("");
    expect(hostA.dataset.terminalSessionId).toBe("a");
    expect(hostC.dataset.terminalActive).toBe("true");
  });

  it("write forwards commands and rejects unknown sessions", async () => {
    const { factory, wrote } = fakeFactory();
    const reg = new SessionRegistry(factory);
    reg.open("a", "/x");

    await reg.write("a", "claude\r");
    await expect(reg.write("ghost", "should-be-dropped")).rejects.toThrow(
      "terminal session is unavailable",
    );
    expect(wrote).toEqual([{ id: "a", data: "claude\r" }]);
  });

  it("paste forwards queueable input and no-ops for unknown sessions", async () => {
    const { factory, wrote } = fakeFactory();
    const reg = new SessionRegistry(factory);
    reg.open("a", "/x");

    await reg.paste("a", "'/tmp/a file' ");
    await reg.paste("ghost", "should-be-dropped");
    expect(wrote).toEqual([{ id: "a", data: "'/tmp/a file' " }]);
  });

  it("setTheme re-skins every live terminal and applies to future opens", () => {
    const { factory, themed } = fakeFactory();
    const reg = new SessionRegistry(factory);
    reg.open("a", "/x");
    reg.open("b", "/y");

    const t1: ITheme = { background: "#111111" };
    reg.setTheme(t1);
    // Both live terminals get the theme.
    expect(themed).toEqual([
      { id: "a", theme: t1 },
      { id: "b", theme: t1 },
    ]);

    // A terminal opened after a theme change adopts it immediately.
    reg.open("c", "/z");
    expect(themed.at(-1)).toEqual({ id: "c", theme: t1 });
  });

  it("closeAll drains every session", async () => {
    const { factory, disposed } = fakeFactory();
    const reg = new SessionRegistry(factory);
    reg.open("a", "/x");
    reg.open("b", "/y");
    await reg.closeAll();
    expect(disposed.sort()).toEqual(["a", "b"]);
  });
});
