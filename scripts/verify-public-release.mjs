import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicConfigPath = join(root, "src-tauri", "tauri.public.conf.json");
const forbidden = [
  "kodade-modeld",
  "kodade-tool-host",
  "kodade-local.mjs",
];

export function verifyPublicConfig(path = publicConfigPath) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const resources = config.bundle?.resources;
  if (!Array.isArray(resources)) {
    throw new Error("public resources must be an array so they replace the development map");
  }
  if (config.build?.beforeBuildCommand !== "pnpm build:public && pnpm stage:public-resources") {
    throw new Error("public Tauri flavor must run the public frontend and resource stages");
  }
  if (!Array.isArray(config.build?.features) || config.build.features.length !== 0) {
    throw new Error("public Tauri flavor must omit the development-features Cargo feature");
  }
  const serialized = JSON.stringify(resources);
  for (const name of forbidden) {
    if (serialized.includes(name)) throw new Error(`public resources include ${name}`);
  }
  if (
    !serialized.includes("helpers") ||
    !serialized.includes("kodskills") ||
    !serialized.includes("legal")
  ) {
    throw new Error(
      "public resources must retain the KödMem helper, KödSkills, and legal notices",
    );
  }
}

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyPublicBundle(directory) {
  const absolute = resolve(directory);
  if (!existsSync(absolute)) throw new Error(`public bundle does not exist: ${absolute}`);
  const paths = filesUnder(absolute).map((path) => relative(absolute, path));
  for (const name of forbidden) {
    const match = paths.find((path) => path.includes(name));
    if (match) throw new Error(`public bundle contains development resource: ${match}`);
  }
  if (!paths.some((path) => path.includes("kodade-mcp"))) {
    throw new Error("public bundle is missing kodade-mcp");
  }
  if (!paths.some((path) => path.endsWith(join("kodskills", "pack.json")))) {
    throw new Error("public bundle is missing the KödSkills pack");
  }
  for (const notice of [
    join("legal", "LICENSE"),
    join("legal", "NOTICE"),
    join("legal", "THIRD_PARTY_NOTICES.md"),
    join("legal", "licenses", "JetBrains-Mono-OFL-1.1.txt"),
    join("legal", "dependencies", "manifest.json"),
    join("legal", "dependencies", "JAVASCRIPT_LICENSES.html"),
    join("legal", "dependencies", "RUST_LICENSES.html"),
  ]) {
    if (!paths.some((path) => path.endsWith(notice))) {
      throw new Error(`public bundle is missing legal notice: ${notice}`);
    }
  }

  const manifestRelative = paths.find((path) =>
    path.endsWith(join("legal", "dependencies", "manifest.json")),
  );
  const bundledManifestPath = join(absolute, manifestRelative);
  const sourceManifestPath = join(
    root,
    "licenses",
    "dependencies",
    "generated",
    "manifest.json",
  );
  if (readFileSync(bundledManifestPath, "utf8") !== readFileSync(sourceManifestPath, "utf8")) {
    throw new Error("public bundle dependency license manifest does not match the source report");
  }
  const manifest = JSON.parse(readFileSync(bundledManifestPath, "utf8"));
  const bundledDependencyDir = dirname(bundledManifestPath);
  for (const [name, expected] of Object.entries(manifest.outputs)) {
    const output = join(bundledDependencyDir, name);
    if (!existsSync(output) || sha256(output) !== expected) {
      throw new Error(`public bundle dependency license report is missing or changed: ${name}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--config")) verifyPublicConfig();
  const bundleAt = args.indexOf("--bundle");
  if (bundleAt >= 0) {
    const bundle = args[bundleAt + 1];
    if (!bundle) throw new Error("--bundle requires an app bundle directory");
    verifyPublicBundle(bundle);
  }

  if (args.length === 0) {
    throw new Error("pass --config or --bundle <app directory>");
  }
}
