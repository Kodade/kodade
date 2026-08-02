import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_FILE = "kodade-local.json";

type StoredConfig = {
  version: 1;
  projects: Record<string, { autoApprove: string[] }>;
};

export type ProjectToolConfig = { autoApproveWrite: boolean };

function emptyConfig(): StoredConfig {
  return { version: 1, projects: {} };
}

async function readConfig(dataDir: string): Promise<StoredConfig> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, CONFIG_FILE), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyConfig();
    const raw = parsed as { version?: unknown; projects?: unknown };
    if (
      raw.version !== 1 ||
      !raw.projects ||
      typeof raw.projects !== "object" ||
      Array.isArray(raw.projects)
    ) {
      return emptyConfig();
    }
    return { version: 1, projects: raw.projects as StoredConfig["projects"] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return emptyConfig();
    }
    throw error;
  }
}

export async function loadProjectToolConfig(
  dataDir: string,
  projectRoot: string,
): Promise<ProjectToolConfig> {
  const config = await readConfig(dataDir);
  const allowlist = config.projects[projectRoot]?.autoApprove;
  return {
    autoApproveWrite: Array.isArray(allowlist) && allowlist.includes("write_file"),
  };
}

export async function saveProjectToolConfig(
  dataDir: string,
  projectRoot: string,
  value: ProjectToolConfig,
): Promise<void> {
  const config = await readConfig(dataDir);
  if (value.autoApproveWrite) {
    config.projects[projectRoot] = { autoApprove: ["write_file"] };
  } else {
    delete config.projects[projectRoot];
  }
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, CONFIG_FILE);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
