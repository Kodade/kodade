import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

test("macOS presents the Ködade identity from an ASCII product name", () => {
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const macOS = JSON.parse(read("src-tauri/tauri.macos.conf.json"));
  const infoPlist = read("src-tauri/Info.plist");
  const index = read("index.html");

  assert.equal(
    tauri.productName,
    "Kodade",
    "the ASCII product name drives the Kodade.app bundle name",
  );
  assert.equal(
    tauri.mainBinaryName,
    "Kodade",
    "the main executable name is what Activity Monitor shows for the app process",
  );
  assert.equal(tauri.app.windows[0].title, "Ködade");
  assert.equal(macOS.bundle.macOS.bundleName, "Ködade");
  assert.match(infoPlist, /<key>CFBundleName<\/key>\s*<string>Ködade<\/string>/);
  assert.match(
    infoPlist,
    /<key>CFBundleDisplayName<\/key>\s*<string>Ködade<\/string>/,
  );
  assert.match(index, /<title>Ködade<\/title>/);
});
