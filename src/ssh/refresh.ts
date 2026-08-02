import type { StoreApi } from "zustand/vanilla";
import type { SshState } from "../store/ssh";

export const SSH_FOCUS_REFRESH_DEBOUNCE_MS = 250;

type FocusEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

// Register once at the app shell so Settings (which overlays the still-mounted
// sidebar) cannot install a second listener and double-scan the same config.
export function listenForSshFocusRefresh(
  store: StoreApi<SshState>,
  target: FocusEventTarget = window,
  debounceMs = SSH_FOCUS_REFRESH_DEBOUNCE_MS,
): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined;

  const onFocus = () => {
    if (store.getState().status === "loading") return;
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      if (store.getState().status === "loading") return;
      void store.getState().init();
    }, debounceMs);
  };

  target.addEventListener("focus", onFocus);
  return () => {
    target.removeEventListener("focus", onFocus);
    if (pending !== undefined) clearTimeout(pending);
  };
}
