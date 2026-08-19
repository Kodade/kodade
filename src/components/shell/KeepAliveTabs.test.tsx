// Keep-alive tab primitive (issue #62). The v2 shell must be able to switch
// tabs without remounting a terminal pane: xterm hosts live outside React in
// the SessionRegistry, and a remount would reparent live canvases mid-session
// (a WKWebView/WebGL hazard). These tests pin mount identity, lazy mounting,
// hidden-but-attached wrappers, and — the point of the primitive — that a
// registry-owned terminal host survives repeated tab switches untouched.

import { act, StrictMode, useEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ITheme } from "@xterm/xterm";
import { SessionRegistry, type TerminalHandle } from "../../terminal/registry";
import { KeepAliveTabs, type KeepAliveTab } from "./KeepAliveTabs";

let mountedRoots: Root[] = [];
afterEach(() => {
  const roots = mountedRoots;
  mountedRoots = [];
  for (const root of roots) act(() => root.unmount());
  document.body.innerHTML = "";
});

// Mount a KeepAliveTabs root whose tabs AND activeId can both change, so tests
// can add, remove, and reorder the tab set.
function renderTabs(
  tabs: KeepAliveTab[],
  activeId: string,
  { strict = false }: { strict?: boolean } = {},
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const current = { tabs, activeId };
  const render = (next: Partial<typeof current>) => {
    Object.assign(current, next);
    const tree = (
      <KeepAliveTabs tabs={current.tabs} activeId={current.activeId} />
    );
    act(() => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
  };
  render({});
  return {
    host,
    setActive: (id: string) => render({ activeId: id }),
    setTabs: (next: KeepAliveTab[]) => render({ tabs: next }),
  };
}

// Wrapper elements in DOM order, by tab id.
function wrapperOrder(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-tab-id]")].map(
    (el) => el.dataset.tabId ?? "",
  );
}

// Wrapper lookup by the id we stamp on each tab shell.
function wrapper(host: HTMLElement, id: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-tab-id="${id}"]`);
}

function isHidden(el: HTMLElement | null): boolean {
  return !!el && (el.style.display === "none" || el.hasAttribute("hidden"));
}

// Fake terminal factory, same shape as registry.test.ts — no xterm involved.
function fakeFactory() {
  const created: string[] = [];
  const disposed: string[] = [];
  const factory = ({ id }: { id: string; cwd: string }): TerminalHandle => {
    created.push(id);
    return {
      host: document.createElement("div"),
      ready: Promise.resolve(),
      focus: vi.fn(),
      paste: async () => undefined,
      write: async () => undefined,
      bracketedPasteMode: () => false,
      setTheme: (_theme: ITheme) => undefined,
      dispose: async () => void disposed.push(id),
    };
  };
  return { factory, created, disposed };
}

describe("KeepAliveTabs", () => {
  it("mounts a tab once and keeps the same DOM node across switches", () => {
    const mounts: string[] = [];
    const nodes: HTMLElement[] = [];

    function Counted({ label }: { label: string }) {
      const ref = useRef<HTMLDivElement | null>(null);
      useEffect(() => {
        mounts.push(label);
        if (ref.current) nodes.push(ref.current);
      }, [label]);
      return <div ref={ref} data-testid={`content-${label}`} />;
    }

    const tabs: KeepAliveTab[] = [
      { id: "a", render: () => <Counted label="a" /> },
      { id: "b", render: () => <Counted label="b" /> },
    ];
    const { host, setActive } = renderTabs(tabs, "a");
    const first = host.querySelector<HTMLElement>('[data-testid="content-a"]');
    expect(first).not.toBeNull();

    setActive("b");
    setActive("a");
    setActive("b");
    setActive("a");

    // Mounted exactly once per tab, and tab "a" is literally the same element.
    expect(mounts).toEqual(["a", "b"]);
    expect(host.querySelector('[data-testid="content-a"]')).toBe(first);
    expect(nodes[0]).toBe(first);
  });

  it("unmounts a tab exactly once when it leaves the tab set", () => {
    const cleanups: string[] = [];
    function Counted({ label }: { label: string }) {
      useEffect(() => () => void cleanups.push(label), [label]);
      return <div data-testid={`content-${label}`} />;
    }
    const tab = (id: string): KeepAliveTab => ({
      id,
      render: () => <Counted label={id} />,
    });
    const tabs = [tab("a"), tab("b")];
    const { host, setActive, setTabs } = renderTabs(tabs, "a");
    setActive("b");

    // Close "a": its content unmounts once and its wrapper leaves the DOM.
    setTabs([tabs[1]]);
    expect(cleanups).toEqual(["a"]);
    expect(wrapper(host, "a")).toBeNull();
    expect(host.querySelector('[data-testid="content-a"]')).toBeNull();

    // Re-render a few times: no second cleanup, "b" stays mounted.
    setActive("b");
    setTabs([tabs[1]]);
    expect(cleanups).toEqual(["a"]);
    expect(wrapper(host, "b")).not.toBeNull();
  });

  it("keeps wrappers in mount order when the caller reorders tabs", () => {
    const tab = (id: string): KeepAliveTab => ({
      id,
      render: () => <div data-testid={`content-${id}`} />,
    });
    const [a, b, c] = [tab("a"), tab("b"), tab("c")];
    const { host, setActive, setTabs } = renderTabs([a, b, c], "a");
    setActive("b");
    expect(wrapperOrder(host)).toEqual(["a", "b"]);

    const wrapperA = wrapper(host, "a");
    const wrapperB = wrapper(host, "b");
    const previousOfB = wrapperB?.previousSibling;

    // Caller reorders (drag-to-reorder, sort): mounted wrappers must not move,
    // or React would insertBefore a live xterm subtree.
    setTabs([c, b, a]);
    expect(wrapperOrder(host)).toEqual(["a", "b"]);
    expect(wrapper(host, "a")).toBe(wrapperA);
    expect(wrapper(host, "b")).toBe(wrapperB);
    expect(wrapperB?.previousSibling).toBe(previousOfB);
    expect(previousOfB).toBe(wrapperA);

    // A newly activated tab appends at the end regardless of caller order.
    setActive("c");
    expect(wrapperOrder(host)).toEqual(["a", "b", "c"]);
  });

  it("passes the active flag to render", () => {
    const seen: Record<string, boolean[]> = { a: [], b: [] };
    const tabs: KeepAliveTab[] = ["a", "b"].map((id) => ({
      id,
      render: (active: boolean) => {
        seen[id].push(active);
        return <div data-testid={`content-${id}`} />;
      },
    }));
    const { setActive } = renderTabs(tabs, "a");
    expect(seen.a.at(-1)).toBe(true);
    expect(seen.b).toEqual([]); // never activated, never rendered

    setActive("b");
    expect(seen.a.at(-1)).toBe(false);
    expect(seen.b.at(-1)).toBe(true);
    setActive("a");
    expect(seen.a.at(-1)).toBe(true);
    expect(seen.b.at(-1)).toBe(false);
  });

  it("behaves under StrictMode double-invocation", () => {
    const mounts: string[] = [];
    function Counted({ label }: { label: string }) {
      useEffect(() => void mounts.push(label), [label]);
      return <div data-testid={`content-${label}`} />;
    }
    const tabs: KeepAliveTab[] = ["a", "b", "c"].map((id) => ({
      id,
      render: () => <Counted label={id} />,
    }));
    const { host, setActive } = renderTabs(tabs, "a", { strict: true });
    setActive("b");
    setActive("a");

    // StrictMode remounts effects on purpose; what must hold is the wrapper
    // set (no duplicates, no eager mount of "c") and no render loop.
    expect(wrapperOrder(host)).toEqual(["a", "b"]);
    expect(host.querySelectorAll('[data-testid="content-a"]')).toHaveLength(1);
    expect(wrapper(host, "c")).toBeNull();
    expect(new Set(mounts)).toEqual(new Set(["a", "b"]));
  });

  it("does not mount a tab that has never been activated", () => {
    const mounts: string[] = [];
    function Counted({ label }: { label: string }) {
      useEffect(() => void mounts.push(label), [label]);
      return <div data-testid={`content-${label}`} />;
    }
    const tabs: KeepAliveTab[] = ["a", "b", "c"].map((id) => ({
      id,
      render: () => <Counted label={id} />,
    }));
    const { host, setActive } = renderTabs(tabs, "a");
    setActive("b");

    expect(mounts).toEqual(["a", "b"]);
    expect(host.querySelector('[data-testid="content-c"]')).toBeNull();
    expect(wrapper(host, "c")).toBeNull();
  });

  it("shows only the active wrapper; inactive wrappers stay in the document", () => {
    const tabs: KeepAliveTab[] = ["a", "b"].map((id) => ({
      id,
      render: () => <div data-testid={`content-${id}`} />,
    }));
    const { host, setActive } = renderTabs(tabs, "a");
    setActive("b");

    const a = wrapper(host, "a");
    const b = wrapper(host, "b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(isHidden(a)).toBe(true);
    expect(isHidden(b)).toBe(false);
    expect(document.body.contains(a)).toBe(true);

    setActive("a");
    expect(isHidden(a)).toBe(false);
    expect(isHidden(b)).toBe(true);
    expect(document.body.contains(b)).toBe(true);
  });

  // Minimal stand-in for TerminalPane's sync effect: React owns the container,
  // the registry owns the host inside it.
  function TerminalTab({
    registry,
    sessionId,
  }: {
    registry: SessionRegistry;
    sessionId: string;
  }) {
    const hostsRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      const container = hostsRef.current;
      if (!container) return;
      registry.sync(container, sessionId, sessionId);
    }, [registry, sessionId]);
    return (
      <div
        ref={hostsRef}
        data-testid={`hosts-${sessionId}`}
        className="h-full min-h-0"
      />
    );
  }

  function terminalTabs(registry: SessionRegistry): KeepAliveTab[] {
    return [
      {
        id: "term",
        render: () => <TerminalTab registry={registry} sessionId="s1" />,
      },
      { id: "other", render: () => <div data-testid="content-other" /> },
    ];
  }

  it("keeps a registry terminal host alive across repeated tab switches", () => {
    const { factory, disposed } = fakeFactory();
    const registry = new SessionRegistry(factory);
    registry.open("s1", "/tmp");

    const { host, setActive } = renderTabs(terminalTabs(registry), "term");
    const container = host.querySelector<HTMLElement>('[data-testid="hosts-s1"]');
    expect(container).not.toBeNull();
    const terminalHost = container?.firstElementChild as HTMLElement;
    expect(terminalHost).toBeTruthy();
    expect(terminalHost.dataset.terminalSessionId).toBe("s1");

    for (let i = 0; i < 3; i += 1) {
      setActive("other");
      setActive("term");
    }

    // Same host, same container, still attached, never disposed — and no
    // re-adoption was needed to get there.
    expect(host.querySelector('[data-testid="hosts-s1"]')).toBe(container);
    expect(container?.firstElementChild).toBe(terminalHost);
    expect(terminalHost.parentElement).toBe(container);
    expect(document.body.contains(terminalHost)).toBe(true);
    expect(disposed).toEqual([]);
  });

  it("keeps the terminal host attached while its tab is hidden", () => {
    const { factory, disposed } = fakeFactory();
    const registry = new SessionRegistry(factory);
    registry.open("s1", "/tmp");

    const { host, setActive } = renderTabs(terminalTabs(registry), "term");
    const container = host.querySelector<HTMLElement>('[data-testid="hosts-s1"]');
    const terminalHost = container?.firstElementChild as HTMLElement;

    setActive("other");

    expect(isHidden(wrapper(host, "term"))).toBe(true);
    expect(terminalHost.parentElement).toBe(container);
    expect(document.body.contains(terminalHost)).toBe(true);
    expect(terminalHost.style.display).toBe(""); // registry never hid it
    expect(disposed).toEqual([]);
  });
});
