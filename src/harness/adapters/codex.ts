// Codex adapter. Location knowledge lives in catalog.ts; the read half is the
// shared engine. M10a: detect + scan only.

import type { ConfigIpc } from "../../ipc/contract";
import type { HarnessAdapter } from "../contract";
import { createHarnessAdapter } from "./shared";

export function createCodexAdapter(config: ConfigIpc): HarnessAdapter {
  return createHarnessAdapter("codex", config);
}
