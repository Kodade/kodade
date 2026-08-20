// Phase 4 standing guard (#64). These fixtures pin down how KödWork task
// documents that were persisted by earlier releases parse TODAY. Each fixture
// pairs a realistic on-disk task doc with the exact `parsePersistedTask` output
// recorded once and frozen (see src/kodwork/fixtures/).
//
// DO NOT edit an expected fixture to make a later change pass. A diff here means
// existing user tasks would load differently after an upgrade — that is a
// migration regression, not a test that needs updating. If a change genuinely
// must alter persisted-doc parsing, it needs an explicit, versioned migration
// and NEW fixtures, never a rewrite of these.

import { describe, expect, it } from "vitest";
import { parsePersistedTask } from "./model";
import { MIGRATION_FIXTURES } from "./fixtures";

describe("KödWork persisted-task migration guard", () => {
  it("has recorded fixtures to guard", () => {
    expect(MIGRATION_FIXTURES.length).toBeGreaterThan(0);
  });

  for (const { name, input, expected } of MIGRATION_FIXTURES) {
    it(`parses ${name} exactly as recorded`, () => {
      // Re-serialize the imported JSON so parsePersistedTask sees the same
      // string bytes a real on-disk read would hand it.
      const parsed = parsePersistedTask(JSON.stringify(input));
      expect(parsed).toStrictEqual(expected);
    });
  }
});
