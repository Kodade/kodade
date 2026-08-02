// Stage only the helpers, data, and legal notices approved for the first public
// release. Tauri's public flavor points at these paths, replacing the
// development resource map entirely.

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = join(root, "src-tauri");
const suffix = process.platform === "win32" ? ".exe" : "";
const binaryName = `kodade-mcp${suffix}`;
const publicBinaryDir = join(srcTauri, "helpers");
const publicSkillsDir = join(srcTauri, "kodskills");
const publicLegalDir = join(srcTauri, "legal");
const dependencyLicensesDir = join(root, "licenses", "dependencies", "generated");
const configuredTargetDir = process.env.CARGO_TARGET_DIR;
const cargoTargetDir = configuredTargetDir
  ? isAbsolute(configuredTargetDir)
    ? configuredTargetDir
    : resolve(srcTauri, configuredTargetDir)
  : join(srcTauri, "target");

execFileSync(
  process.execPath,
  [join(root, "scripts", "generate-dependency-licenses.mjs"), "--verify"],
  { cwd: root, stdio: "inherit" },
);

rmSync(publicBinaryDir, { recursive: true, force: true });
rmSync(publicSkillsDir, { recursive: true, force: true });
rmSync(publicLegalDir, { recursive: true, force: true });
mkdirSync(publicBinaryDir, { recursive: true });
mkdirSync(join(publicLegalDir, "licenses"), { recursive: true });
cpSync(join(root, "resources", "kodskills"), publicSkillsDir, {
  recursive: true,
});
for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
  copyFileSync(join(root, file), join(publicLegalDir, file));
}
copyFileSync(
  join(root, "licenses", "JetBrains-Mono-OFL-1.1.txt"),
  join(publicLegalDir, "licenses", "JetBrains-Mono-OFL-1.1.txt"),
);
cpSync(dependencyLicensesDir, join(publicLegalDir, "dependencies"), {
  recursive: true,
});

execFileSync(
  "cargo",
  ["build", "--release", "--no-default-features", "--bin", "kodade-mcp"],
  { cwd: srcTauri, stdio: "inherit" },
);

const builtBinary = join(cargoTargetDir, "release", binaryName);
const stagedBinary = join(publicBinaryDir, binaryName);
copyFileSync(builtBinary, stagedBinary);
if (process.platform !== "win32") chmodSync(stagedBinary, 0o755);

if (
  !existsSync(stagedBinary) ||
  !existsSync(join(publicSkillsDir, "pack.json")) ||
  !existsSync(join(publicLegalDir, "LICENSE")) ||
  !existsSync(join(publicLegalDir, "NOTICE")) ||
  !existsSync(join(publicLegalDir, "THIRD_PARTY_NOTICES.md")) ||
  !existsSync(join(publicLegalDir, "licenses", "JetBrains-Mono-OFL-1.1.txt")) ||
  !existsSync(join(publicLegalDir, "dependencies", "manifest.json")) ||
  !existsSync(join(publicLegalDir, "dependencies", "JAVASCRIPT_LICENSES.html")) ||
  !existsSync(join(publicLegalDir, "dependencies", "RUST_LICENSES.html"))
) {
  throw new Error(
    "public resource staging did not produce KödMem, KödSkills, and complete legal notices",
  );
}

const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
if (process.platform === "darwin" && signingIdentity) {
  execFileSync(
    "codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      join(srcTauri, "Entitlements.plist"),
      "--sign",
      signingIdentity,
      stagedBinary,
    ],
    { stdio: "inherit" },
  );
}

console.log(`staged public helper ${binaryName}, KödSkills, and legal notices`);
