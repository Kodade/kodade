// Vendor the pinned KödSkills engineering pack. Runtime installation is offline;
// this script is the only networked step and is run by maintainers before release.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://github.com/ContractorKeith/skills.git";
const TAG = "v1.0.0";
const SHA = "000087d6fc70e92fc91eb40b89b0c62a67ebc78a";
const VERSION = "1.0.0";
const EXPECTED_SKILLS = 16;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(repoRoot, "resources", "kodskills");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function descriptionFromSkill(contents, file) {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${file} has no YAML frontmatter`);
  const lines = match[1].split(/\r?\n/);
  const at = lines.findIndex((line) => /^description\s*:/.test(line));
  if (at < 0) throw new Error(`${file} has no description in frontmatter`);
  const first = lines[at].replace(/^description\s*:\s*/, "");
  if (first !== ">" && first !== "|") return unquote(first);
  const continuation = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s+/.test(line)) break;
    continuation.push(line.trim());
  }
  return continuation.join(first === ">" ? " " : "\n").trim();
}

async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`vendored skill contains a symlink: ${path}`);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function main() {
  const temporary = await mkdtemp(join(tmpdir(), "kodskills-vendor-"));
  const clone = join(temporary, "source");
  const staged = join(temporary, "kodskills");
  try {
    execFileSync("git", [
      "clone",
      "--quiet",
      "--config",
      "advice.detachedHead=false",
      "--depth",
      "1",
      "--branch",
      TAG,
      SOURCE,
      clone,
    ], {
      stdio: "inherit",
    });
    const actualSha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (actualSha !== SHA) {
      throw new Error(`tag ${TAG} resolved to ${actualSha}; expected ${SHA}`);
    }

    const sourceSkills = join(clone, "skills", "engineering");
    const entries = (await readdir(sourceSkills, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length !== EXPECTED_SKILLS) {
      throw new Error(`expected ${EXPECTED_SKILLS} engineering skills, found ${entries.length}`);
    }

    await mkdir(join(staged, "skills"), { recursive: true });
    const skills = [];
    for (const entry of entries) {
      const sourceDir = join(sourceSkills, entry.name);
      const targetDir = join(staged, "skills", entry.name);
      await cp(sourceDir, targetDir, { recursive: true, errorOnExist: true });
      const skillMd = join(sourceDir, "SKILL.md");
      const description = descriptionFromSkill(await readFile(skillMd, "utf8"), skillMd);
      const files = [];
      for (const path of await filesUnder(sourceDir)) {
        files.push({ path: portablePath(sourceDir, path), sha256: sha256(await readFile(path)) });
      }
      skills.push({ id: entry.name, dir: entry.name, description, files });
    }

    await cp(join(clone, "LICENSE"), join(staged, "LICENSE"));
    const manifest = {
      name: "KödSkills engineering pack",
      id: "kodskills-engineering",
      version: VERSION,
      description: "A curated idea-to-ship engineering workflow for agentic coding.",
      source: SOURCE.replace(/\.git$/, ""),
      tag: TAG,
      sha: SHA,
      skills,
    };
    await writeFile(join(staged, "pack.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    console.log(`Vendored ${skills.length} KödSkills at ${basename(destination)} (${TAG} ${SHA.slice(0, 8)})`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
