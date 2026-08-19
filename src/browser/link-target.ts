// Where a link clicked inside KödChat opens.
//
// The embedded browser pane is archived (#62): builds without the feature —
// and platforms that cannot host the native child view — send the link to the
// OS browser through the same allowlisted opener the markdown views use,
// instead of opening a tab that can never render.

import type { PlatformCapabilities } from "../ipc/contract";
import { browserPaneAvailable } from "../platform/capabilities";

export type ChatLinkTarget = "browser-pane" | "external";

export function chatLinkTarget(
  caps: PlatformCapabilities | null,
): ChatLinkTarget {
  return browserPaneAvailable(caps) ? "browser-pane" : "external";
}
