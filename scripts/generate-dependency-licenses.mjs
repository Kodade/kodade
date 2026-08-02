import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const licenseRoot = join(root, "licenses", "dependencies");
const generatedDir = join(licenseRoot, "generated");
const overrideConfigPath = join(licenseRoot, "javascript-overrides.json");
const cargoAboutVersion = "0.9.1";
const defaultTarget = "aarch64-apple-darwin";
const requiredOutputs = ["JAVASCRIPT_LICENSES.html", "RUST_LICENSES.html"];
const licenseFilePattern = /^(licen[cs]e|copying|copyright|notice|unlicense)(\..*)?$/i;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function fileHash(path) {
  return sha256(readFileSync(path));
}

function directoryHash(directory) {
  const hash = createHash("sha256");
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        hash.update(relative(directory, path));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(directory);
  return hash.digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result.stdout.trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeText(value) {
  return String(value).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
}

function formatPerson(person) {
  if (!person) return "";
  if (typeof person === "string") return person;
  const details = [person.name, person.email, person.url].filter(Boolean);
  return details.join(" — ");
}

function repositoryUrl(repository, homepage) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  return (raw || homepage || "")
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
}

function readLicenseFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      text: normalizeText(readFileSync(join(directory, entry.name), "utf8")).trim(),
    }));
}

function javascriptPackages() {
  const report = JSON.parse(run("pnpm", ["licenses", "list", "--prod", "--json"]));
  const overrides = JSON.parse(readFileSync(overrideConfigPath, "utf8"));
  const usedOverrides = new Set();
  const packages = new Map();

  for (const group of Object.values(report)) {
    for (const entry of group) {
      for (const packagePath of entry.paths) {
        const packageJson = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
        const key = `${packageJson.name}@${packageJson.version}`;
        if (packages.has(key)) continue;

        const overrideFiles = overrides[key]?.files ?? [];
        if (overrideFiles.length > 0) usedOverrides.add(key);
        const files = [
          ...readLicenseFiles(packagePath),
          ...overrideFiles.map((path) => ({
            name: path.split("/").at(-1),
            text: normalizeText(readFileSync(join(licenseRoot, path), "utf8")).trim(),
          })),
        ];
        if (!packageJson.license && !entry.license) {
          throw new Error(`${key} does not declare a license`);
        }
        if (files.length === 0) {
          throw new Error(
            `${key} has no packaged license text; add a version-pinned javascript override`,
          );
        }

        const people = [packageJson.author, ...(packageJson.contributors ?? [])]
          .map(formatPerson)
          .filter(Boolean);
        packages.set(key, {
          key,
          name: packageJson.name,
          version: packageJson.version,
          license: packageJson.license || entry.license,
          people: [...new Set(people)],
          repository: repositoryUrl(packageJson.repository, packageJson.homepage),
          files,
        });
      }
    }
  }

  const unusedOverrides = unusedOverrideKeys(overrides, usedOverrides);
  if (unusedOverrides.length > 0) {
    throw new Error(`unused JavaScript license overrides: ${unusedOverrides.join(", ")}`);
  }

  return [...packages.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function unusedOverrideKeys(overrides, usedOverrides) {
  return Object.keys(overrides).filter((key) => !usedOverrides.has(key));
}

function cargoAboutReport(target) {
  const version = run("cargo", ["about", "--version"]);
  if (version !== `cargo-about ${cargoAboutVersion}`) {
    throw new Error(
      `cargo-about ${cargoAboutVersion} is required; found ${version || "no executable"}`,
    );
  }
  return JSON.parse(
    run("cargo", [
      "about",
      "generate",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--config",
      "licenses/dependencies/about.toml",
      "--target",
      target,
      "--locked",
      "--fail",
      "--format",
      "json",
    ]),
  );
}

function page(title, intro, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 1000px; padding: 2rem; line-height: 1.5; }
    a { color: inherit; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #8886; padding: .45rem; text-align: left; vertical-align: top; }
    pre { border: 1px solid #8886; border-radius: .4rem; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    section { margin-block: 2.5rem; }
    .muted { opacity: .75; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(intro)}</p>
  ${body}
</body>
</html>
`;
}

function renderJavascript(packages) {
  const rows = packages
    .map((item) => {
      const name = item.repository
        ? `<a href="${escapeHtml(item.repository)}">${escapeHtml(item.key)}</a>`
        : escapeHtml(item.key);
      return `<tr><td>${name}</td><td>${escapeHtml(item.license)}</td></tr>`;
    })
    .join("\n");
  const details = packages
    .map((item) => {
      const people = item.people.length
        ? `<p><strong>Authors/contributors:</strong> ${escapeHtml(item.people.join("; "))}</p>`
        : "";
      const files = item.files
        .map(
          (file) =>
            `<h3>${escapeHtml(file.name)}</h3>\n<pre>${escapeHtml(file.text)}</pre>`,
        )
        .join("\n");
      return `<section id="${escapeHtml(item.key)}">
  <h2>${escapeHtml(item.key)}</h2>
  <p><strong>Declared license:</strong> ${escapeHtml(item.license)}</p>
${people}
  ${files}
</section>`;
    })
    .join("\n");
  return page(
    "Ködade JavaScript dependency licenses",
    `Complete license and attribution texts for ${packages.length} production packages resolved from pnpm-lock.yaml.`,
    `<table><thead><tr><th>Package</th><th>Declared license</th></tr></thead><tbody>${rows}</tbody></table>${details}`,
  );
}

function renderRust(report, target) {
  const crates = report.crates
    .map(({ package: crate, license }) => ({
      key: `${crate.name}@${crate.version}`,
      license,
      repository: crate.repository || crate.homepage || `https://crates.io/crates/${crate.name}`,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const rows = crates
    .map(
      (crate) =>
        `<tr><td><a href="${escapeHtml(crate.repository)}">${escapeHtml(crate.key)}</a></td><td>${escapeHtml(crate.license)}</td></tr>`,
    )
    .join("\n");
  const licenses = [...report.licenses]
    .sort((left, right) =>
      `${left.id}:${left.name}:${left.text}`.localeCompare(`${right.id}:${right.name}:${right.text}`),
    )
    .map((license) => {
      if (!license.text?.trim()) throw new Error(`${license.id} has no resolved license text`);
      const usedBy = [...new Set(license.used_by.map(({ crate }) => `${crate.name}@${crate.version}`))]
        .sort()
        .map((key) => `<li>${escapeHtml(key)}</li>`)
        .join("");
      return `<section>
  <h2>${escapeHtml(license.name)} (${escapeHtml(license.id)})</h2>
  <p><strong>Used by:</strong></p><ul>${usedBy}</ul>
  <pre>${escapeHtml(normalizeText(license.text).trim())}</pre>
</section>`;
    })
    .join("\n");
  return {
    html: page(
      "Ködade Rust dependency licenses",
      `Complete license and attribution texts for ${crates.length} Rust crates resolved for ${target} from src-tauri/Cargo.lock with Ködade's public app default features.`,
      `<table><thead><tr><th>Crate</th><th>Declared license</th></tr></thead><tbody>${rows}</tbody></table>${licenses}`,
    ),
    crateCount: crates.length,
    licenseDocumentCount: report.licenses.length,
  };
}

function inputHashes() {
  const files = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "licenses/dependencies/about.toml",
    "licenses/dependencies/javascript-overrides.json",
    "scripts/generate-dependency-licenses.mjs",
  ];
  return Object.fromEntries(files.map((path) => [path, fileHash(join(root, path))]));
}

export function validateBundleState({
  manifest,
  actualInputs,
  actualOverrideFilesSha256,
  actualOutputHashes,
}) {
  if (!manifest?.inputs || !manifest?.outputs || !manifest?.tools) {
    throw new Error("dependency license manifest is incomplete");
  }
  if (
    JSON.stringify(Object.keys(actualInputs).sort()) !==
    JSON.stringify(Object.keys(manifest.inputs).sort())
  ) {
    throw new Error("dependency license manifest input set is stale");
  }
  for (const [path, expected] of Object.entries(manifest.inputs)) {
    if (actualInputs[path] !== expected) {
      throw new Error(`dependency license bundle is stale for ${path}; run pnpm licenses:generate`);
    }
  }
  if (manifest.overrideFilesSha256 !== actualOverrideFilesSha256) {
    throw new Error("dependency license bundle is stale for JavaScript overrides");
  }
  if (
    JSON.stringify(Object.keys(manifest.outputs).sort()) !==
    JSON.stringify([...requiredOutputs].sort())
  ) {
    throw new Error("dependency license manifest output set is incomplete");
  }
  for (const [name, expected] of Object.entries(manifest.outputs)) {
    if (actualOutputHashes[name] !== expected) {
      throw new Error(`dependency license output is missing or changed: ${name}`);
    }
  }
  if (manifest.target !== defaultTarget || manifest.tools.cargoAbout !== cargoAboutVersion) {
    throw new Error("dependency license manifest uses an unsupported target or generator");
  }
}

function verifyBundle() {
  const manifestPath = join(generatedDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("dependency license manifest is missing; run pnpm licenses:generate");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const actualInputs = inputHashes();
  const actualOutputHashes = Object.fromEntries(
    requiredOutputs.map((name) => {
      const path = join(generatedDir, name);
      return [name, existsSync(path) ? fileHash(path) : null];
    }),
  );
  validateBundleState({
    manifest,
    actualInputs,
    actualOverrideFilesSha256: directoryHash(join(licenseRoot, "javascript-overrides")),
    actualOutputHashes,
  });
  console.log(
    `verified dependency license bundle (${manifest.counts.javascriptPackages} JavaScript packages, ${manifest.counts.rustCrates} Rust crates)`,
  );
}

function reusableJavascriptBundle() {
  const manifestPath = join(generatedDir, "manifest.json");
  const outputPath = join(generatedDir, "JAVASCRIPT_LICENSES.html");
  if (!existsSync(manifestPath) || !existsSync(outputPath)) {
    throw new Error("the existing JavaScript license bundle is unavailable");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.inputs?.["pnpm-lock.yaml"] !== fileHash(join(root, "pnpm-lock.yaml"))) {
    throw new Error("cannot reuse JavaScript licenses after pnpm-lock.yaml changed");
  }
  if (manifest.overrideFilesSha256 !== directoryHash(join(licenseRoot, "javascript-overrides"))) {
    throw new Error("cannot reuse JavaScript licenses after an override changed");
  }
  if (manifest.outputs?.["JAVASCRIPT_LICENSES.html"] !== fileHash(outputPath)) {
    throw new Error("cannot reuse a changed JavaScript license report");
  }
  return {
    count: manifest.counts.javascriptPackages,
    html: readFileSync(outputPath, "utf8"),
  };
}

function generate(target, { reuseJavascript = false } = {}) {
  const javascript = reuseJavascript
    ? reusableJavascriptBundle()
    : (() => {
        const packages = javascriptPackages();
        return { count: packages.length, html: renderJavascript(packages) };
      })();
  const report = cargoAboutReport(target);
  const rust = renderRust(report, target);
  mkdirSync(generatedDir, { recursive: true });
  const javascriptName = "JAVASCRIPT_LICENSES.html";
  const rustName = "RUST_LICENSES.html";
  writeFileSync(join(generatedDir, javascriptName), javascript.html);
  writeFileSync(join(generatedDir, rustName), rust.html);

  const manifest = {
    schemaVersion: 1,
    productVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    profile: "public macOS app (default Rust features and production JavaScript dependencies)",
    target,
    tools: {
      cargoAbout: cargoAboutVersion,
      pnpm: run("pnpm", ["--version"]),
    },
    inputs: inputHashes(),
    overrideFilesSha256: directoryHash(join(licenseRoot, "javascript-overrides")),
    counts: {
      javascriptPackages: javascript.count,
      rustCrates: rust.crateCount,
      rustLicenseDocuments: rust.licenseDocumentCount,
    },
    outputs: {
      [javascriptName]: fileHash(join(generatedDir, javascriptName)),
      [rustName]: fileHash(join(generatedDir, rustName)),
    },
  };
  writeFileSync(join(generatedDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `generated dependency license bundle (${javascript.count} JavaScript packages, ${rust.crateCount} Rust crates)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--verify")) {
    verifyBundle();
  } else {
    const targetAt = args.indexOf("--target");
    const target = targetAt >= 0 ? args[targetAt + 1] : defaultTarget;
    if (!target) throw new Error("--target requires a Rust target triple");
    if (target !== defaultTarget) {
      throw new Error(`the first public release license target must remain ${defaultTarget}`);
    }
    generate(target, { reuseJavascript: args.includes("--reuse-javascript") });
  }
}
