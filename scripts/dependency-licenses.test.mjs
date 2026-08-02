import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  unusedOverrideKeys,
  validateBundleState,
} from "./generate-dependency-licenses.mjs";
import { verifyPublicBundle } from "./verify-public-release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = join(root, "licenses", "dependencies", "generated");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureState() {
  const inputs = { "package.json": hashText("package") };
  const outputs = {
    "JAVASCRIPT_LICENSES.html": hashText("javascript"),
    "RUST_LICENSES.html": hashText("rust"),
  };
  return {
    manifest: {
      inputs,
      outputs,
      overrideFilesSha256: hashText("overrides"),
      target: "aarch64-apple-darwin",
      tools: { cargoAbout: "0.9.1" },
    },
    actualInputs: { ...inputs },
    actualOverrideFilesSha256: hashText("overrides"),
    actualOutputHashes: { ...outputs },
  };
}

function makeBundle() {
  const directory = mkdtempSync(join(tmpdir(), "kodade-license-bundle-"));
  temporaryDirectories.push(directory);
  const files = [
    "helpers/kodade-mcp",
    "kodskills/pack.json",
    "legal/LICENSE",
    "legal/NOTICE",
    "legal/THIRD_PARTY_NOTICES.md",
    "legal/licenses/JetBrains-Mono-OFL-1.1.txt",
  ];
  for (const name of files) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture\n");
  }
  const dependencyDirectory = join(directory, "legal", "dependencies");
  mkdirSync(dependencyDirectory, { recursive: true });
  for (const name of [
    "manifest.json",
    "JAVASCRIPT_LICENSES.html",
    "RUST_LICENSES.html",
  ]) {
    copyFileSync(join(generated, name), join(dependencyDirectory, name));
  }
  return directory;
}

test("license manifest validation rejects stale inputs and altered reports", () => {
  const valid = fixtureState();
  assert.doesNotThrow(() => validateBundleState(valid));

  const stale = fixtureState();
  stale.actualInputs["package.json"] = hashText("changed package");
  assert.throws(() => validateBundleState(stale), /stale for package\.json/);

  const altered = fixtureState();
  altered.actualOutputHashes["RUST_LICENSES.html"] = hashText("changed report");
  assert.throws(() => validateBundleState(altered), /missing or changed/);
});

test("unused JavaScript overrides remain a hard generation failure", () => {
  const overrides = { "used@1.0.0": {}, "stale@1.0.0": {} };
  assert.deepEqual(unusedOverrideKeys(overrides, new Set(["used@1.0.0"])), [
    "stale@1.0.0",
  ]);
});

test("public bundle verification rejects missing notices and changed reports", () => {
  const missingNotice = makeBundle();
  assert.doesNotThrow(() => verifyPublicBundle(missingNotice));
  unlinkSync(join(missingNotice, "legal", "NOTICE"));
  assert.throws(() => verifyPublicBundle(missingNotice), /missing legal notice/);

  const changedReport = makeBundle();
  writeFileSync(
    join(changedReport, "legal", "dependencies", "JAVASCRIPT_LICENSES.html"),
    "changed\n",
  );
  assert.throws(() => verifyPublicBundle(changedReport), /missing or changed/);
});
