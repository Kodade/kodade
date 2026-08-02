import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { entitlementsFor } from "../../src/license/entitlements";
import { FEATURES } from "../../src/license/features";
import { LICENSE_PUBLIC_KEY } from "../../src/license/public-key";
import type { VerifyStatus } from "../../src/license/types";
import { verifyLicense } from "../../src/license/verify";

const APP_IDENTIFIER = "com.kodade.desktop";
export const SHARED_LICENSE_FILE = "kodade-license.token";
const MAX_TOKEN_BYTES = 16 * 1024;

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function resolveAppDataDir(): string {
  const explicit = process.env.KODADE_DATA_DIR;
  if (explicit) return explicit;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_IDENTIFIER);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("APPDATA is not set; cannot locate the Ködade license");
    return join(appData, APP_IDENTIFIER);
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, APP_IDENTIFIER);
}

export type HeadlessLicense = {
  status: VerifyStatus | "none";
  hasAgent: boolean;
  hasTools: boolean;
  hasOrchestrate: boolean;
  message: string;
  tokenPath: string;
};

export async function readHeadlessLicense(
  options: { dataDir?: string; now?: number } = {},
): Promise<HeadlessLicense> {
  const tokenPath = join(options.dataDir ?? resolveAppDataDir(), SHARED_LICENSE_FILE);
  let token: string;
  try {
    const before = await lstat(tokenPath, { bigint: true });
    if (before.isSymbolicLink()) {
      throw new Error("Shared license token path must not be a symlink.");
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = await open(tokenPath, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat({ bigint: true });
      const after = await lstat(tokenPath, { bigint: true });
      if (
        !opened.isFile() ||
        after.isSymbolicLink() ||
        !sameFile(before, opened) ||
        !sameFile(opened, after) ||
        opened.size > BigInt(MAX_TOKEN_BYTES)
      ) {
        throw new Error("Shared license token is not a stable bounded regular file.");
      }
      const buffer = Buffer.alloc(MAX_TOKEN_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_TOKEN_BYTES) {
        throw new Error("Shared license token exceeds the size limit.");
      }
      token = buffer.subarray(0, bytesRead).toString("utf8").trim();
    } finally {
      await handle.close();
    }
    if (!token) throw new Error("Shared license token is empty.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "none",
        hasAgent: false,
        hasTools: false,
        hasOrchestrate: false,
        message: "No KödLocal Pro license is active.",
        tokenPath,
      };
    }
    return {
      status: "malformed",
      hasAgent: false,
      hasTools: false,
      hasOrchestrate: false,
      message: `Shared license token could not be read: ${error instanceof Error ? error.message : String(error)}`,
      tokenPath,
    };
  }
  const verified = verifyLicense(token, LICENSE_PUBLIC_KEY, options.now ?? Date.now());
  const entitlements = entitlementsFor(verified);
  return {
    status: verified.status,
    hasAgent: entitlements.hasFeature(FEATURES.localAgent),
    hasTools: entitlements.hasFeature(FEATURES.localTools),
    hasOrchestrate: entitlements.hasFeature(FEATURES.localOrchestrate),
    message: verified.message,
    tokenPath,
  };
}
