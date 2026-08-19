// Build and stage KödLocal's native helpers before Tauri bundles resources.
// Tauri copies `src-tauri/binaries/` to `kodade-local/bin/`; commands.rs resolves
// that stable resource path in a packaged app while retaining dev fallbacks.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCargoTargetDir } from "./cargo-target-dir.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = join(root, "src-tauri");
const cargoTargetDir = resolveCargoTargetDir(
  srcTauri,
  process.env.CARGO_TARGET_DIR,
);
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
const entitlements = join(srcTauri, "Entitlements.plist");
const windowsCertificate = process.env.SIGNTOOL_CERT_SHA1;
const windowsTimestamp = process.env.SIGNTOOL_TIMESTAMP_URL;
const windowsModeldVariant = process.env.KODADE_MODELD_VARIANT ?? "vulkan";
if (
  process.platform === "win32" &&
  windowsModeldVariant !== "vulkan" &&
  windowsModeldVariant !== "cpu"
) {
  throw new Error("KODADE_MODELD_VARIANT must be either vulkan or cpu");
}
if (
  process.platform === "win32" &&
  Boolean(windowsCertificate) !== Boolean(windowsTimestamp)
) {
  throw new Error(
    "set both SIGNTOOL_CERT_SHA1 and SIGNTOOL_TIMESTAMP_URL to sign KödLocal helpers",
  );
}
const suffix = process.platform === "win32" ? ".exe" : "";
const binaryNames = [
  `kodade-modeld${suffix}`,
  `kodade-tool-host${suffix}`,
  `kodade-mcp${suffix}`,
];
const config = JSON.parse(
  readFileSync(join(srcTauri, "tauri.conf.json"), "utf8"),
);
const resources = config.bundle?.resources;
const modeldFeatures =
  process.platform === "win32" && windowsModeldVariant === "vulkan"
    ? "modeld-vulkan"
    : "modeld";

if (
  resources?.["../dist-cli/kodade-local.mjs"] !==
    "kodade-local/kodade-local.mjs" ||
  resources?.binaries !== "kodade-local/bin"
) {
  throw new Error(
    "tauri.conf.json must map KödLocal helpers to their stable packaged resource paths",
  );
}

execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--no-default-features",
    "--features",
    `${modeldFeatures},development-features`,
    "--bin",
    "kodade-modeld",
  ],
  { cwd: srcTauri, stdio: "inherit" },
);
if (process.platform === "win32") {
  console.log(`built Windows KödLocal ${windowsModeldVariant} variant`);
}
// The tool host and MCP adapter need neither native engine, so keep both off
// their build graph as well.
execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--no-default-features",
    "--features",
    "development-features",
    "--bin",
    "kodade-tool-host",
  ],
  { cwd: srcTauri, stdio: "inherit" },
);
// The development/QA package keeps the archived KödBrowser MCP subcommand
// (#62); the public staging script builds this binary without the feature, so
// a public kodade-mcp serves KödMem alone.
execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--no-default-features",
    "--features",
    "development-features",
    "--bin",
    "kodade-mcp",
  ],
  { cwd: srcTauri, stdio: "inherit" },
);

for (const binaryName of binaryNames) {
  const builtBinary = join(cargoTargetDir, "release", binaryName);
  const stagedBinary = join(srcTauri, "binaries", binaryName);
  if (!existsSync(builtBinary)) {
    throw new Error(`cargo completed without producing ${builtBinary}`);
  }
  mkdirSync(dirname(stagedBinary), { recursive: true });
  copyFileSync(builtBinary, stagedBinary);
  if (process.platform !== "win32") chmodSync(stagedBinary, 0o755);
  if (!existsSync(stagedBinary)) {
    throw new Error(`failed to stage ${stagedBinary}`);
  }
  // Tauri signs the app bundle later, but these helpers are copied as resources.
  // Sign them before bundling so a release build retains their hardened-runtime
  // signatures instead of leaving nested executable code for notarization to reject.
  if (process.platform === "darwin" && signingIdentity) {
    execFileSync(
      "codesign",
      [
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
        entitlements,
        "--sign",
        signingIdentity,
        stagedBinary,
      ],
      { stdio: "inherit" },
    );
  }
  if (process.platform === "win32" && windowsCertificate && windowsTimestamp) {
    execFileSync(
      process.env.SIGNTOOL_PATH ?? "signtool",
      [
        "sign",
        "/sha1",
        windowsCertificate,
        "/fd",
        "SHA256",
        "/tr",
        windowsTimestamp,
        "/td",
        "SHA256",
        stagedBinary,
      ],
      { stdio: "inherit" },
    );
  }
  console.log(`staged ${binaryName} at src-tauri/binaries/${binaryName}`);
}
