// Dev-only license minting CLI. Prints the dev public key (to confirm it matches
// src/license/public-key.ts) and mints a signed token you can paste into
// Settings → License while the real issuer is stubbed.
//
//   node scripts/gen-dev-license.ts                 # perpetual Pro token, all flags
//   node scripts/gen-dev-license.ts --days 30       # expires in 30 days
//   node scripts/gen-dev-license.ts --tier free     # a free-tier token
//   node scripts/gen-dev-license.ts --features ssh.pro,harness.pro  # subset
//
// Self-contained (imports only node_modules) so it runs under plain Node's TS
// type-stripping without the app's bundler resolution. It re-implements the tiny
// wire format from src/license/codec.ts — the canonical, test-covered signer is
// the helper in src/license/__fixtures__/dev-keypair.ts.
//
// ⚠️ Uses the DEV keypair (scripts + tests only). Never mints production
// licenses.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// Must equal DEV_PRIVATE_KEY in src/license/__fixtures__/dev-keypair.ts.
const DEV_PRIVATE_KEY = new TextEncoder().encode(
  "kodade-dev-license-signing-key-0",
);

// Keep in sync with src/license/features.ts (the typo-safety catalog).
const FEATURES = [
  "vox.cleanup",
  "vox.vocabulary",
  "vox.commands",
  "vox.streaming",
  "local.agent",
  "local.tools",
  "local.orchestrate",
  "local.multibox",
  "harness.pro",
  "kodpr.branch",
  "kodpr.pr",
  "ssh.pro",
];

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return Buffer.from(binary, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const tier = arg("tier") ?? "pro";
const featuresOverride = arg("features")
  ?.split(",")
  .map((f) => f.trim())
  .filter(Boolean);
const daysRaw = arg("days");
const days = daysRaw ? Number(daysRaw) : null;
const now = Date.now();

const payload = {
  id: `dev-${now}`,
  tier,
  issuedAt: new Date(now).toISOString(),
  expiry:
    days === null ? null : new Date(now + days * 86_400_000).toISOString(),
  features: tier === "free" ? [] : (featuresOverride ?? FEATURES),
};

const enc = new TextEncoder();
const payloadSegment = bytesToBase64url(enc.encode(JSON.stringify(payload)));
const signature = ed.sign(enc.encode(payloadSegment), DEV_PRIVATE_KEY);
const token = `${payloadSegment}.${bytesToBase64url(signature)}`;

console.log(
  "dev public key:",
  ed.etc.bytesToHex(ed.getPublicKey(DEV_PRIVATE_KEY)),
);
console.log("token payload: ", JSON.stringify(payload));
console.log("");
console.log(token);
