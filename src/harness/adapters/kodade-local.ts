// KödLocal reads the AGENTS.md + skills harness but never mutates it.

import type { ConfigIpc } from "../../ipc/contract";
import type { HarnessAdapter } from "../contract";
import { createReadOnlyHarnessAdapter } from "./read";

export function createKodadeLocalAdapter(config: ConfigIpc): HarnessAdapter {
  return createReadOnlyHarnessAdapter("kodade-local", config);
}
