import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigDirEntry, ConfigScan, FileRead } from "../../src/ipc/contract";
import type { HarnessReadFs } from "../../src/harness/adapters/read";

const MAX_FILE_BYTES = 1_048_576;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function entryFor(path: string, name: string, recurse: boolean): Promise<ConfigDirEntry> {
  const linkMetadata = await lstat(path).catch(() => null);
  const isSymlink = linkMetadata?.isSymbolicLink() ?? false;
  const target = isSymlink ? await readlink(path).catch(() => null) : null;
  const metadata = await stat(path).catch(() => null);
  const isDir = metadata?.isDirectory() ?? false;
  return {
    name,
    path,
    isDir,
    isSymlink,
    target,
    orphaned: isSymlink && metadata === null,
    children: isDir && recurse ? await listLevel(path) : null,
  };
}

async function listLevel(root: string): Promise<ConfigDirEntry[] | null> {
  try {
    const names = await readdir(root);
    const entries = await Promise.all(names.map((name) => entryFor(join(root, name), name, false)));
    return entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  } catch {
    return null;
  }
}

export function createNodeHarnessFs(): HarnessReadFs {
  return {
    async read(path: string): Promise<FileRead> {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error(`not a file: ${path}`);
      if (metadata.size > MAX_FILE_BYTES) return { kind: "tooLarge", bytes: metadata.size };
      const bytes = await readFile(path);
      if (bytes.byteLength > MAX_FILE_BYTES) return { kind: "tooLarge", bytes: bytes.byteLength };
      if (bytes.includes(0)) return { kind: "binary", bytes: bytes.byteLength };
      try {
        return { kind: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch {
        return { kind: "binary", bytes: bytes.byteLength };
      }
    },

    async scan(root: string): Promise<ConfigScan> {
      try {
        const names = await readdir(root);
        const entries = await Promise.all(
          names.map((name) => entryFor(join(root, name), name, true)),
        );
        entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        return { status: "listing", root, entries };
      } catch (error) {
        if (errorCode(error) === "ENOENT") return { status: "missing", root };
        return {
          status: "unreadable",
          root,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
