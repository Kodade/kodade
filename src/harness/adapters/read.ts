// Dependency-light KödHarness read engine. It is shared by the desktop's full
// adapters and KödLocal's bundled Node CLI without pulling mutation parsers into
// the headless bundle.

import { PROVIDERS } from "../../providers/catalog";
import type { ConfigIpc, FileRead } from "../../ipc/contract";
import type { ArtifactLocation, HarnessAdapter, LocationScan } from "../contract";
import { resolveLocations } from "../locations";
import type { HarnessScope, ScanContext } from "../model";
import { scanInstruction, scanMcp, scanSkills, scanSubagents } from "../scan";
import {
  KODADE_PROJECT_SKILL_MARKER,
  KODSKILLS_MARKER_NAME,
  skillCanonicalGroupId,
} from "../skill-identity";

const EMPTY: LocationScan = { artifacts: [], error: null };

export type HarnessReadFs = Pick<ConfigIpc, "read" | "scan">;

async function tryRead(
  config: HarnessReadFs,
  path: string,
  projectRoot: string,
): Promise<FileRead | null> {
  try {
    return await config.read(path, projectRoot);
  } catch {
    return null;
  }
}

export function harnessReadHalf(cli: string, config: HarnessReadFs) {
  const harness = PROVIDERS.find((provider) => provider.id === cli)?.harness;
  return {
    cli,

    async detect(scope: HarnessScope, ctx: ScanContext): Promise<ArtifactLocation[]> {
      if (!harness) return [];
      return resolveLocations(cli, harness, scope, ctx);
    },

    async scan(loc: ArtifactLocation, ctx: ScanContext): Promise<LocationScan> {
      switch (loc.kind) {
        case "instruction": {
          const read = await tryRead(config, loc.path, ctx.projectRoot);
          return read ? scanInstruction(loc, read) : EMPTY;
        }
        case "skill": {
          const raw = await config.scan(loc.path, ctx.projectRoot);
          const result = scanSkills(loc, raw);
          if (raw.status !== "listing" || result.artifacts.length === 0) return result;
          const entries = new Map(raw.entries.map((entry) => [entry.path, entry]));
          const artifacts = await Promise.all(result.artifacts.map(async (artifact) => {
            const entry = entries.get(artifact.path);
            const marker = entry?.children?.find(
              (child) =>
                child.name === KODADE_PROJECT_SKILL_MARKER ||
                child.name === KODSKILLS_MARKER_NAME,
            );
            if (!marker) return artifact;
            const read = await tryRead(config, marker.path, ctx.projectRoot);
            if (!read || read.kind !== "text") return artifact;
            const canonicalGroupId = skillCanonicalGroupId(marker.name, read.content);
            return canonicalGroupId ? { ...artifact, canonicalGroupId } : artifact;
          }));
          return { ...result, artifacts };
        }
        case "subagent":
          return scanSubagents(loc, await config.scan(loc.path, ctx.projectRoot));
        case "mcp-server": {
          const read = await tryRead(config, loc.path, ctx.projectRoot);
          return read ? scanMcp(loc, read) : EMPTY;
        }
      }
    },
  };
}

export function createReadOnlyHarnessAdapter(
  cli: string,
  config: HarnessReadFs,
): HarnessAdapter {
  const readonlyError = async () => {
    throw new Error(`${cli} harness adapter is read-only`);
  };
  return {
    ...harnessReadHalf(cli, config),
    plan: readonlyError,
    apply: readonlyError,
    verify: readonlyError,
    restore: readonlyError,
  };
}
