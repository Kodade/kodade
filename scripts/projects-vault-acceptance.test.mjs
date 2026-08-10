import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_GATES,
  assertEvidenceTreeClean,
  buildEvidence,
} from "./projects-vault-acceptance.mjs";

test("projects-vault acceptance names every durable and public proof gate", () => {
  assert.deepEqual(
    ACCEPTANCE_GATES.map((gate) => gate.id),
    [
      "native-scenarios",
      "checkpoint-recovery",
      "mapped-mcp",
      "ui-workflows",
      "public-profile",
      "public-source",
      "public-frontend",
    ],
  );
});

test("projects-vault evidence separates automated proof from release proof and stores no output", () => {
  const secret = `ghp_${"acceptance-secret".repeat(3)}`;
  const evidence = buildEvidence({
    commit: "a".repeat(40),
    generatedAt: "2026-08-10T12:00:00.000Z",
    platform: { os: "darwin", arch: "arm64", node: "v24.0.0" },
    results: ACCEPTANCE_GATES.map((gate) => ({
      id: gate.id,
      command: [gate.command, ...gate.args],
      status: "passed",
      exitCode: 0,
      durationMs: 10,
      outputSha256: "b".repeat(64),
      rawOutput: secret,
      diagnostic: secret,
    })),
  });

  assert.equal(evidence.schema, 1);
  assert.equal(evidence.result, "passed");
  assert.deepEqual(evidence.releaseProof, {
    acceptanceHarness: "passed",
    publicProfile: "passed",
    publicSource: "passed",
    publicFrontendBuild: "passed",
    nativeAcceptance: "passed",
    uiWorkflowTests: "passed",
    packaged: "not-run",
    signed: "not-run",
    notarized: "not-run",
    installedOwnerAcceptance: "not-run",
    published: "not-run",
    publicDownloadVerification: "not-run",
  });
  assert.ok(!JSON.stringify(evidence).includes(secret));
  assert.ok(!JSON.stringify(evidence).includes("/Users/"));
  assert.ok(evidence.gates.every((gate) => !("rawOutput" in gate)));
  assert.ok(evidence.gates.every((gate) => !("diagnostic" in gate)));
  assert.deepEqual(
    evidence.gates.map((gate) => gate.command),
    ACCEPTANCE_GATES.map((gate) => [gate.command, ...gate.args]),
  );
});

test("projects-vault evidence refuses attribution to HEAD when source is dirty", () => {
  assert.doesNotThrow(() => assertEvidenceTreeClean(""));
  assert.throws(
    () => assertEvidenceTreeClean(" M ROADMAP.md\n?? local-source.txt\n"),
    /commit or stash source changes/i,
  );
});
