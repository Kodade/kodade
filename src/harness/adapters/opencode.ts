// OpenCode adapter. Location knowledge lives in catalog.ts; the read half is
// the shared engine. M10c: detect + scan only.

import type { ConfigIpc } from "../../ipc/contract";
import type { HarnessAdapter } from "../contract";
import { createHarnessAdapter } from "./shared";

export function createOpencodeAdapter(config: ConfigIpc): HarnessAdapter {
  return createHarnessAdapter("opencode", config);
}
