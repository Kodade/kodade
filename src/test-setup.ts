// Global test setup. The transport selector (src/ipc/transport.ts) picks the
// Tauri IPC path when `window.__TAURI_INTERNALS__` exists and the WebSocket
// remote otherwise. The suite exercises the desktop (Tauri) wiring — with
// @tauri-apps invoke mocked per file — so mark the runtime as Tauri here.
// Transport/remote tests that need the web path delete this global and
// re-import the module themselves.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ??= {};

// React 19 requires this flag for act() to flush component updates without
// emitting a warning for every state change. Keep it global so slower CI hosts
// do not time out while writing avoidable diagnostics.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
