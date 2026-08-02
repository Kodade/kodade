import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsViewStore } from "../store/settingsView";
import { BrowserPane } from "./BrowserPane";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  setBounds: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
  hide: vi.fn(() => Promise.resolve()),
  destroy: vi.fn(() => Promise.resolve()),
  onNavigated: vi.fn(() => Promise.resolve(() => undefined)),
  agentReady: vi.fn(() => Promise.resolve()),
  setBrowserUrl: vi.fn(),
}));

vi.mock("../ipc/transport", () => ({
  browser: {
    create: mocks.create,
    setBounds: mocks.setBounds,
    show: mocks.show,
    hide: mocks.hide,
    destroy: mocks.destroy,
    onNavigated: mocks.onNavigated,
    agentReady: mocks.agentReady,
    back: vi.fn(() => Promise.resolve()),
    forward: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("../store/appStore", () => ({
  filesStore: {
    getState: () => ({
      rootPath: "/work/app",
      setBrowserUrl: mocks.setBrowserUrl,
    }),
  },
}));

class TestResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    this.callback();
  }
  disconnect() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("BrowserPane recovery", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    settingsViewStore.setState({ section: null });
    mocks.setBounds.mockResolvedValue(undefined);
    mocks.create.mockRejectedValueOnce(new Error("repair WebView2"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 40,
      top: 40,
      left: 0,
      right: 800,
      bottom: 640,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retries the same URL and clears the failure only after create succeeds", async () => {
    await act(async () => {
      root.render(createElement(BrowserPane, { url: "https://example.com/" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repair WebView2");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "retry",
    );
    expect(retry).toBeTruthy();

    mocks.create.mockResolvedValueOnce(undefined);
    await act(async () => {
      retry!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.create).toHaveBeenLastCalledWith(
      "editor-browser",
      "https://example.com/",
      expect.objectContaining({ width: 800, height: 600 }),
    );
    expect(container.textContent).not.toContain("repair WebView2");
    expect(container.textContent).not.toContain("retry");
    expect(mocks.agentReady).toHaveBeenCalledWith("/work/app");
  });

  it("clears agent readiness before hiding an unmounted browser", async () => {
    mocks.create.mockReset();
    mocks.create.mockResolvedValue(undefined);
    await act(async () => {
      root.render(createElement(BrowserPane, { url: "https://example.com/" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => root.unmount());

    expect(mocks.agentReady).toHaveBeenLastCalledWith(null);
    expect(mocks.hide).toHaveBeenCalledWith("editor-browser");
    root = createRoot(container);
  });

  it("hides the native browser while Settings covers the workspace and restores it on close", async () => {
    mocks.create.mockReset();
    mocks.create.mockResolvedValue(undefined);
    await act(async () => {
      root.render(createElement(BrowserPane, { url: "https://example.com/" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.clearAllMocks();

    await act(async () => {
      settingsViewStore.getState().open("general");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.hide).toHaveBeenCalledWith("editor-browser");
    expect(mocks.show).not.toHaveBeenCalled();

    await act(async () => {
      settingsViewStore.getState().close();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.setBounds).toHaveBeenCalledWith(
      "editor-browser",
      expect.objectContaining({ width: 800, height: 600 }),
    );
    expect(mocks.show).toHaveBeenCalledWith("editor-browser");
  });

  it("does not let a pending placement re-show the browser over Settings", async () => {
    const placement = deferred<void>();
    mocks.create.mockReset();
    mocks.create.mockResolvedValue(undefined);
    mocks.setBounds.mockReturnValueOnce(placement.promise);
    await act(async () => {
      root.render(createElement(BrowserPane, { url: "https://example.com/" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    mocks.hide.mockClear();
    mocks.show.mockClear();

    await act(async () => {
      settingsViewStore.getState().open("general");
      await Promise.resolve();
      placement.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.hide).toHaveBeenCalledWith("editor-browser");
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it("re-hides a browser created after Settings opens before agent readiness completes", async () => {
    const creation = deferred<void>();
    const readiness = deferred<void>();
    mocks.create.mockReset();
    mocks.create.mockReturnValueOnce(creation.promise);
    mocks.agentReady.mockReturnValueOnce(readiness.promise);
    await act(async () => {
      root.render(createElement(BrowserPane, { url: "https://example.com/" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      settingsViewStore.getState().open("general");
      await Promise.resolve();
      await Promise.resolve();
    });
    mocks.hide.mockClear();

    await act(async () => {
      creation.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.hide).toHaveBeenCalledWith("editor-browser");

    await act(async () => {
      readiness.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
