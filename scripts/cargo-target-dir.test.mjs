import assert from "node:assert/strict";
import test from "node:test";

import { resolveCargoTargetDir } from "./cargo-target-dir.mjs";

test("uses an absolute Cargo target directory for staged package binaries", () => {
  assert.equal(
    resolveCargoTargetDir("/workspace/src-tauri", "/Users/Shared/kodade-target"),
    "/Users/Shared/kodade-target",
  );
});

test("resolves a relative Cargo target directory from the Rust workspace", () => {
  assert.equal(
    resolveCargoTargetDir("/workspace/src-tauri", "../cargo-target"),
    "/workspace/cargo-target",
  );
});

test("defaults staged package binaries to the Rust workspace target", () => {
  assert.equal(
    resolveCargoTargetDir("/workspace/src-tauri"),
    "/workspace/src-tauri/target",
  );
});
