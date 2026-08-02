import { nativeRelativePath } from "../platform/native-path";

export function isGitCheckpointEventPath(path: string, projectRoot: string): boolean {
  const relative = nativeRelativePath(path, projectRoot)?.replaceAll("\\", "/");
  if (!relative) return false;
  return relative === ".git/HEAD" ||
    relative === ".git/packed-refs" ||
    relative.startsWith(".git/refs/");
}

export function rootsWithGitCheckpointEvents(
  paths: readonly string[],
  projectRoots: readonly string[],
): string[] {
  return projectRoots.filter((root) =>
    paths.some((path) => isGitCheckpointEventPath(path, root))
  );
}
