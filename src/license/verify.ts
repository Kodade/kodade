// The license verifier: a pure, synchronous, fully-offline function
//
//     verifyLicense(token, publicKey, now) -> VerifyResult
//
// It parses the token, checks the Ed25519 signature against the embedded public
// key, then checks the time window. It is the ONE module that touches crypto —
// feature code never imports this; it reads booleans from the entitlements
// selector instead (see entitlements.ts / licenseStore.ts).

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  base64urlToBytes,
  splitToken,
  utf8Encode,
  utf8Decode,
} from "./codec";
import type { LicenseToken, VerifyResult } from "./types";

// Ed25519 verification needs SHA-512. noble keeps its sync path hash-agnostic;
// injecting @noble/hashes' sha512 here lets verifyLicense stay synchronous and
// offline (no WebCrypto, works under happy-dom in tests). Set once at load.
ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));

// Accept the embedded key as raw bytes or a hex string (config convenience).
function toKeyBytes(publicKey: Uint8Array | string): Uint8Array {
  return typeof publicKey === "string" ? ed.etc.hexToBytes(publicKey) : publicKey;
}

// Structural validation of the decoded payload. Returns a typed token or null;
// we never trust fields we didn't shape-check.
function parsePayload(json: unknown): LicenseToken | null {
  if (typeof json !== "object" || json === null) return null;
  const value = json as Record<string, unknown>;
  const { id, tier, issuedAt, expiry, features } = value;
  if (typeof id !== "string") return null;
  if (tier !== "free" && tier !== "pro") return null;
  if (typeof issuedAt !== "string") return null;
  if (expiry !== null && typeof expiry !== "string") return null;
  if (!Array.isArray(features) || features.some((f) => typeof f !== "string")) {
    return null;
  }
  return { id, tier, issuedAt, expiry, features: features as string[] };
}

/**
 * Verify a license token string.
 * @param token   the compact `<payload>.<signature>` string
 * @param publicKey the embedded Ed25519 public key (bytes or hex)
 * @param now     current time in epoch ms (injected so this stays pure/testable)
 */
export function verifyLicense(
  token: string,
  publicKey: Uint8Array | string,
  now: number,
): VerifyResult {
  const split = splitToken(token);
  if (!split) {
    return { status: "malformed", token: null, message: "License key is not in the expected format." };
  }

  // Check the signature over the exact payload-segment bytes FIRST — it doesn't
  // depend on JSON parsing, so any tampering (even edits that break the payload)
  // is caught here as a signature failure rather than looking like malformed.
  let signatureOk = false;
  try {
    const signature = base64urlToBytes(split.signatureSegment);
    const message = utf8Encode(split.payloadSegment);
    signatureOk = ed.verify(signature, message, toKeyBytes(publicKey));
  } catch {
    signatureOk = false; // bad signature encoding / wrong length / bad key
  }
  if (!signatureOk) {
    // Tampered payload or a token signed by a different key — indistinguishable
    // and both untrusted, so we return no token.
    return {
      status: "invalid-signature",
      token: null,
      message: "License key failed verification (it may be edited or not issued for this app).",
    };
  }

  // Signature is authentic. Now decode + shape-check the payload; a validly
  // signed but wrong-shaped payload is malformed (shouldn't happen from a real
  // issuer, but we never trust an unparseable payload).
  let payload: LicenseToken | null;
  try {
    const json = JSON.parse(utf8Decode(base64urlToBytes(split.payloadSegment)));
    payload = parsePayload(json);
  } catch {
    payload = null;
  }
  if (!payload) {
    return { status: "malformed", token: null, message: "License key is not in the expected format." };
  }

  // Enforce the time window.
  const issuedAtMs = Date.parse(payload.issuedAt);
  if (Number.isNaN(issuedAtMs) || issuedAtMs > now) {
    return {
      status: "not-yet-valid",
      token: payload,
      message: "License is not valid yet — check your system clock.",
    };
  }
  if (payload.expiry !== null) {
    const expiryMs = Date.parse(payload.expiry);
    if (Number.isNaN(expiryMs) || expiryMs <= now) {
      return {
        status: "expired",
        token: payload,
        message: "License has expired — renew to keep Pro features.",
      };
    }
  }

  return { status: "valid", token: payload, message: "License active." };
}
