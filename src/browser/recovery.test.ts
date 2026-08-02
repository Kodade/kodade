import { describe, expect, it } from "vitest";
import {
  browserCreateReducer,
  initialBrowserCreateState,
} from "./recovery";

describe("browser create recovery", () => {
  it("keeps a create failure visible until a later attempt succeeds", () => {
    let state = browserCreateReducer(initialBrowserCreateState, { type: "start", attempt: 1 });
    state = browserCreateReducer(state, {
      type: "failure",
      attempt: 1,
      error: "repair WebView2",
    });
    expect(state).toEqual({ attempt: 1, pending: false, error: "repair WebView2" });

    state = browserCreateReducer(state, { type: "start", attempt: 2 });
    expect(state.error).toBe("repair WebView2");
    state = browserCreateReducer(state, { type: "success", attempt: 2 });
    expect(state).toEqual({ attempt: 2, pending: false, error: null });
  });

  it("ignores a stale completion from an older same-url attempt", () => {
    let state = browserCreateReducer(initialBrowserCreateState, { type: "start", attempt: 1 });
    state = browserCreateReducer(state, { type: "start", attempt: 2 });
    state = browserCreateReducer(state, {
      type: "failure",
      attempt: 1,
      error: "stale failure",
    });
    expect(state).toEqual({ attempt: 2, pending: true, error: null });

    state = browserCreateReducer(state, { type: "success", attempt: 2 });
    expect(state.error).toBeNull();
  });
});
