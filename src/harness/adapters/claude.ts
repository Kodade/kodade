// Claude Code adapter. All location knowledge lives in catalog.ts; the read
// half is the shared engine. M10a: detect + scan only.

import type { ConfigIpc } from "../../ipc/contract";
import type { HarnessAdapter } from "../contract";
import { createHarnessAdapter } from "./shared";

export function createClaudeAdapter(config: ConfigIpc): HarnessAdapter {
  return createHarnessAdapter("claude", config);
}
