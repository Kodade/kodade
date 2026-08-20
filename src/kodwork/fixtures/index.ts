// Recorded migration fixtures for the Phase 4 standing guard (#64). Each entry
// pairs a realistic on-disk KödWork task document (`*.input.json`) with the
// exact `parsePersistedTask` output recorded once and frozen (`*.expected.json`).
// Loaded as JSON modules so the guard needs no Node filesystem access.
//
// These pairs are frozen: never edit an expected file to make a later change
// pass. See migration-fixtures.test.ts for the full rule.

import draftInput from "./draft.input.json";
import draftExpected from "./draft.expected.json";
import runningInput from "./running-at-shutdown.input.json";
import runningExpected from "./running-at-shutdown.expected.json";
import needsUserInput from "./needs-user.input.json";
import needsUserExpected from "./needs-user.expected.json";
import doneReviewInput from "./done-with-review.input.json";
import doneReviewExpected from "./done-with-review.expected.json";
import failedInput from "./failed.input.json";
import failedExpected from "./failed.expected.json";
import cancelledInput from "./cancelled.input.json";
import cancelledExpected from "./cancelled.expected.json";
import recurringInput from "./recurring.input.json";
import recurringExpected from "./recurring.expected.json";
import permissionsInput from "./permissions.input.json";
import permissionsExpected from "./permissions.expected.json";
import unknownFieldsInput from "./unknown-fields.input.json";
import unknownFieldsExpected from "./unknown-fields.expected.json";
import outOfBoundsInput from "./out-of-bounds.input.json";
import outOfBoundsExpected from "./out-of-bounds.expected.json";
import reviewBoundsInput from "./review-bounds.input.json";
import reviewBoundsExpected from "./review-bounds.expected.json";
import versionMismatchInput from "./version-mismatch.input.json";
import versionMismatchExpected from "./version-mismatch.expected.json";
import missingIdInput from "./missing-id.input.json";
import missingIdExpected from "./missing-id.expected.json";
import nonObjectInput from "./non-object.input.json";
import nonObjectExpected from "./non-object.expected.json";

export type MigrationFixture = {
  name: string;
  input: unknown;
  expected: unknown;
};

export const MIGRATION_FIXTURES: MigrationFixture[] = [
  { name: "draft", input: draftInput, expected: draftExpected },
  { name: "running-at-shutdown", input: runningInput, expected: runningExpected },
  { name: "needs-user", input: needsUserInput, expected: needsUserExpected },
  { name: "done-with-review", input: doneReviewInput, expected: doneReviewExpected },
  { name: "failed", input: failedInput, expected: failedExpected },
  { name: "cancelled", input: cancelledInput, expected: cancelledExpected },
  { name: "recurring", input: recurringInput, expected: recurringExpected },
  { name: "permissions", input: permissionsInput, expected: permissionsExpected },
  { name: "unknown-fields", input: unknownFieldsInput, expected: unknownFieldsExpected },
  { name: "out-of-bounds", input: outOfBoundsInput, expected: outOfBoundsExpected },
  { name: "review-bounds", input: reviewBoundsInput, expected: reviewBoundsExpected },
  // parsePersistedTask null paths: an unreadable doc loads as "no saved task".
  { name: "version-mismatch", input: versionMismatchInput, expected: versionMismatchExpected },
  { name: "missing-id", input: missingIdInput, expected: missingIdExpected },
  { name: "non-object", input: nonObjectInput, expected: nonObjectExpected },
];
