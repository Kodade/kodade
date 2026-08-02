// KödHarness is configuration, so its full inspector lives directly in
// Settings rather than opening another workspace tab.

import { useState } from "react";
import type { HarnessScope } from "../../harness/model";
import { HarnessPane } from "../HarnessPane";

export function HarnessSection() {
  const [scope, setScope] = useState<HarnessScope>("project");

  return (
    <HarnessPane scope={scope} onScopeChange={setScope} />
  );
}
