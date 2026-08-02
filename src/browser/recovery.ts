export type BrowserCreateState = {
  attempt: number;
  pending: boolean;
  error: string | null;
};

export type BrowserCreateEvent =
  | { type: "start"; attempt: number }
  | { type: "success"; attempt: number }
  | { type: "failure"; attempt: number; error: string };

export const initialBrowserCreateState: BrowserCreateState = {
  attempt: 0,
  pending: false,
  error: null,
};

// A retry may overlap an older create request. Only the latest attempt may
// settle visible state, and an existing error survives until create succeeds.
export function browserCreateReducer(
  state: BrowserCreateState,
  event: BrowserCreateEvent,
): BrowserCreateState {
  if (event.type === "start") {
    return { attempt: event.attempt, pending: true, error: state.error };
  }
  if (event.attempt !== state.attempt) return state;
  if (event.type === "success") {
    return { attempt: event.attempt, pending: false, error: null };
  }
  return { attempt: event.attempt, pending: false, error: event.error };
}
