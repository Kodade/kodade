import { afterEach, describe, expect, it, vi } from "vitest";
import { MockSsh } from "../ipc/mock";
import { createSshStore } from "../store/ssh";
import { listenForSshFocusRefresh } from "./refresh";

describe("listenForSshFocusRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid focus events into one host scan", () => {
    vi.useFakeTimers();
    const store = createSshStore({ ssh: new MockSsh() });
    const init = vi.fn(async () => undefined);
    store.setState({ status: "ready", init });
    const target = new EventTarget();
    const cleanup = listenForSshFocusRefresh(store, target, 100);

    target.dispatchEvent(new Event("focus"));
    target.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(50);
    target.dispatchEvent(new Event("focus"));

    vi.advanceTimersByTime(99);
    expect(init).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(init).toHaveBeenCalledOnce();

    cleanup();
  });

  it("skips focus scans that are already loading or become loading before the debounce fires", () => {
    vi.useFakeTimers();
    const store = createSshStore({ ssh: new MockSsh() });
    const init = vi.fn(async () => undefined);
    store.setState({ status: "loading", init });
    const target = new EventTarget();
    const cleanup = listenForSshFocusRefresh(store, target, 100);

    target.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(100);
    expect(init).not.toHaveBeenCalled();

    store.setState({ status: "ready" });
    target.dispatchEvent(new Event("focus"));
    store.setState({ status: "loading" });
    vi.advanceTimersByTime(100);
    expect(init).not.toHaveBeenCalled();

    cleanup();
  });

  it("cancels a pending scan when the listener is removed", () => {
    vi.useFakeTimers();
    const store = createSshStore({ ssh: new MockSsh() });
    const init = vi.fn(async () => undefined);
    store.setState({ status: "ready", init });
    const target = new EventTarget();
    const cleanup = listenForSshFocusRefresh(store, target, 100);

    target.dispatchEvent(new Event("focus"));
    cleanup();
    vi.advanceTimersByTime(100);

    expect(init).not.toHaveBeenCalled();
  });
});
