import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

test("macOS uses the Ködade display name without changing stable bundle paths", () => {
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const macOS = JSON.parse(read("src-tauri/tauri.macos.conf.json"));
  const infoPlist = read("src-tauri/Info.plist");
  const index = read("index.html");

  assert.equal(
    tauri.productName,
    "kodade",
    "the lowercase product name keeps kodade.app and packaged helper paths stable",
  );
  assert.equal(tauri.app.windows[0].title, "Ködade");
  assert.equal(macOS.bundle.macOS.bundleName, "Ködade");
  assert.match(
    infoPlist,
    /<key>CFBundleDisplayName<\/key>\s*<string>Ködade<\/string>/,
  );
  assert.match(index, /<title>Ködade<\/title>/);
});
