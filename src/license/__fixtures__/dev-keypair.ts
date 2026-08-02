// ⚠️ DEV-ONLY KEYPAIR + SIGNING HELPER — NOT FOR PRODUCTION.
//
// This is the deterministic dev keypair used to mint license tokens for tests
// and local development while the real issuer is stubbed.
// The private key here signs ONLY dev/test tokens; it must NEVER be the key that
// gates production Pro. The production private key lives exclusively in the
// license issuer's secrets and is never committed to this repo.
//
// The public half is embedded in the app for the M9d milestone
// (src/license/public-key.ts); swap both for the production keypair before ship.
//
// Nothing in the shipping app imports this file — only tests and the
// scripts/gen-dev-license.ts generator do.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToBase64url, joinToken, utf8Encode } from "../codec";
import type { LicenseToken } from "../types";

// Enable noble's sync signing path (mirrors verify.ts). Idempotent.
ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));

// 32-byte private seed = ASCII "kodade-dev-license-signing-key-0" (exactly 32
// bytes). Deterministic so fixtures and the embedded public key never drift.
export const DEV_PRIVATE_KEY: Uint8Array = utf8Encode("kodade-dev-license-signing-key-0");

// Derived public key. Matches LICENSE_PUBLIC_KEY in src/license/public-key.ts.
export const DEV_PUBLIC_KEY: Uint8Array = ed.getPublicKey(DEV_PRIVATE_KEY);
export const DEV_PUBLIC_KEY_HEX: string = ed.etc.bytesToHex(DEV_PUBLIC_KEY);

// Sign a license payload with the dev key, producing a token string in the wire
// format the verifier expects. This is exactly what the real serverless issuer
// will do, minus the production key.
export function signLicense(
  payload: LicenseToken,
  privateKey: Uint8Array = DEV_PRIVATE_KEY,
): string {
  const payloadSegment = bytesToBase64url(utf8Encode(JSON.stringify(payload)));
  const signature = ed.sign(utf8Encode(payloadSegment), privateKey);
  return joinToken(payloadSegment, signature);
}
