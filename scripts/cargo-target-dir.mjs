import { isAbsolute, join, resolve } from "node:path";

export function resolveCargoTargetDir(srcTauri, configuredTargetDir) {
  if (!configuredTargetDir) return join(srcTauri, "target");
  return isAbsolute(configuredTargetDir)
    ? configuredTargetDir
    : resolve(srcTauri, configuredTargetDir);
}
