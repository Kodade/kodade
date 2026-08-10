import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const publicDocs = new Set([
  "docs/README.md",
  "docs/PROJECTS-VAULT-ACCEPTANCE.md",
  "docs/RELEASING.md",
  "docs/WINDOWS-CI.md",
  "docs/WINDOWS.md",
  "docs/agents/domain.md",
  "docs/agents/issue-tracker.md",
  "docs/agents/triage-labels.md",
]);

const forbiddenPrefixes = [
  "docs/private/",
  "docs/research/",
  "docs/archive/",
  "web" + "-shell/",
  "src-tauri/src/server/",
];

const forbiddenFiles = new Set([
  "PLAN.md",
  "docs/LICENSING.md",
  "docs/OPEN_SOURCE_PLAN.md",
  "docs/PUBLIC_RELEASE_ACCEPTANCE.md",
  "docs/PUBLIC_RELEASE_DECISION_MAP.md",
  "docs/WINDOWS-PLAN.md",
  "docs/WINDOWS-QA.md",
  "wrangler.jsonc",
]);

const forbiddenText = [
  "/Users/" + "keithbloemendaal",
  "Köd" + "Web",
  "kodade" + "-serve",
  "KODADE_" + "SERVE",
  "web" + "-shell",
];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function isText(buffer) {
  return !buffer.subarray(0, 8_192).includes(0);
}

export function verifyPublicSource(files = trackedFiles()) {
  const failures = [];
  for (const file of files) {
    if (
      (file.startsWith("docs/") && !publicDocs.has(file)) ||
      forbiddenFiles.has(file) ||
      /(?:^|\/)[^/]+_PLAN\.md$/.test(file) ||
      forbiddenPrefixes.some((prefix) => file.startsWith(prefix))
    ) {
      failures.push(`private or retired path is tracked: ${file}`);
      continue;
    }

    const absolute = resolve(root, file);
    if (!existsSync(absolute)) continue;
    const contents = readFileSync(absolute);
    if (!isText(contents)) continue;
    const text = contents.toString("utf8");
    for (const marker of forbiddenText) {
      if (text.includes(marker)) {
        failures.push(`retired or machine-specific marker in ${file}: ${marker}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`public source verification failed:\n${failures.join("\n")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPublicSource();
  console.log("public source verification passed");
}
