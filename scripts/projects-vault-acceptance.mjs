import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cargoBase = [
  "test",
  "--locked",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--no-default-features",
];

export const ACCEPTANCE_GATES = Object.freeze([
  {
    id: "native-scenarios",
    command: "cargo",
    args: [
      ...cargoBase,
      "--test",
      "projects_vault_acceptance",
      "--",
      "--test-threads=1",
    ],
  },
  {
    id: "checkpoint-recovery",
    command: "cargo",
    args: [
      ...cargoBase,
      "--test",
      "memory_store",
      "mapped_checkpoint_recovers_every_persisted_phase_in_a_child_process",
      "--",
      "--exact",
      "--test-threads=1",
    ],
  },
  {
    id: "mapped-mcp",
    command: "cargo",
    args: [
      ...cargoBase,
      "--test",
      "mcp_stdio",
      "mapped_stdio_requires_state_cas_supports_fallback_and_rebuilds_exact_markdown",
      "--",
      "--exact",
      "--test-threads=1",
    ],
  },
  {
    id: "ui-workflows",
    command: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      "src/components/settings/ProjectKnowledgeSetup.test.tsx",
      "src/components/MemoryPane.test.tsx",
    ],
  },
  { id: "public-profile", command: "pnpm", args: ["test:public"] },
  { id: "public-source", command: "pnpm", args: ["verify:public-source"] },
  { id: "public-frontend", command: "pnpm", args: ["build:public"] },
]);

function combinedStatus(results, ids) {
  const selected = ids.map((id) => results.find((result) => result.id === id));
  if (selected.some((result) => result?.status === "failed")) return "failed";
  if (selected.every((result) => result?.status === "passed")) return "passed";
  return "not-run";
}

export function buildEvidence({ commit, generatedAt, platform: runtime, results }) {
  const seen = new Set();
  const gates = results.map((result) => {
    const specification = ACCEPTANCE_GATES.find((gate) => gate.id === result.id);
    if (!specification || seen.has(result.id)) {
      throw new Error(`unexpected or duplicate projects-vault gate: ${result.id}`);
    }
    seen.add(result.id);
    return {
      id: result.id,
      command: [specification.command, ...specification.args],
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputSha256: result.outputSha256,
    };
  });
  const acceptanceIds = ["native-scenarios", "checkpoint-recovery", "mapped-mcp"];
  const allPassed = gates.length === ACCEPTANCE_GATES.length &&
    gates.every((gate) => gate.status === "passed");
  const anyFailed = gates.some((gate) => gate.status === "failed");
  return {
    schema: 1,
    subject: "projects-vault KödMem acceptance",
    commit,
    generatedAt,
    platform: runtime,
    result: allPassed ? "passed" : anyFailed ? "failed" : "incomplete",
    gates,
    releaseProof: {
      acceptanceHarness: combinedStatus(gates, acceptanceIds),
      publicProfile: combinedStatus(gates, ["public-profile"]),
      publicSource: combinedStatus(gates, ["public-source"]),
      publicFrontendBuild: combinedStatus(gates, ["public-frontend"]),
      nativeAcceptance: combinedStatus(gates, acceptanceIds),
      uiWorkflowTests: combinedStatus(gates, ["ui-workflows"]),
      packaged: "not-run",
      signed: "not-run",
      notarized: "not-run",
      installedOwnerAcceptance: "not-run",
      published: "not-run",
      publicDownloadVerification: "not-run",
    },
  };
}

export function assertEvidenceTreeClean(status) {
  if (status.trim().length > 0) {
    throw new Error(
      "projects-vault evidence requires a clean tree; commit or stash source changes before attributing results to HEAD",
    );
  }
}

function runGate(gate) {
  const started = Date.now();
  process.stdout.write(`\n[projects-vault] ${gate.id}: ${gate.command} ${gate.args.join(" ")}\n`);
  const executable = process.platform === "win32" && gate.command === "pnpm"
    ? "pnpm.cmd"
    : gate.command;
  const child = spawnSync(executable, gate.args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(gate.command === "cargo"
        ? {
            TAURI_CONFIG:
              '{"build":{"frontendDist":".."},"bundle":{"resources":[]}}',
          }
        : {}),
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const rawOutput = `${stdout}${stderr}`;
  const exitCode = child.status ?? 1;
  return {
    id: gate.id,
    command: [gate.command, ...gate.args],
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    durationMs: Date.now() - started,
    outputSha256: createHash("sha256").update(rawOutput).digest("hex"),
    rawOutput,
  };
}

export function runProjectsVaultAcceptance() {
  assertEvidenceTreeClean(
    execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const results = [];
  for (const gate of ACCEPTANCE_GATES) {
    const result = runGate(gate);
    results.push(result);
    if (result.status === "failed") break;
  }
  const evidence = buildEvidence({
    commit,
    generatedAt: new Date().toISOString(),
    platform: { os: platform(), arch: arch(), node: process.version },
    results,
  });
  const evidencePath = resolve(root, "artifacts/projects-vault-acceptance.json");
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const displayedEvidencePath = relative(root, evidencePath);
  process.stdout.write(`\n[projects-vault] evidence: ${displayedEvidencePath}\n`);
  return evidence.result === "passed" ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runProjectsVaultAcceptance();
}
