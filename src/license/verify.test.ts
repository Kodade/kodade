// Verifier + entitlements-selector tests. The verifier is the pure TDD seam
//   verifyLicense(token, publicKey, now) -> VerifyResult
// exercised here against dev-keypair-signed fixtures: valid, expired, tampered,
// wrong-key, future-issued, malformed. The entitlements selector is tested
// alongside — only a "valid" result unlocks features; everything else is free.

import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { verifyLicense } from "./verify";
import { entitlementsFor, freeEntitlements } from "./entitlements";
import {
  DEV_PRIVATE_KEY,
  DEV_PUBLIC_KEY,
  signLicense,
} from "./__fixtures__/dev-keypair";
import type { LicenseToken } from "./types";

// Fixed clock so time-window assertions are deterministic.
const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const DAY = 86_400_000;

// A well-formed Pro token issued in the past, expiring in the future.
function proToken(overrides: Partial<LicenseToken> = {}): LicenseToken {
  return {
    id: "lic-123",
    tier: "pro",
    issuedAt: new Date(NOW - DAY).toISOString(),
    expiry: new Date(NOW + DAY).toISOString(),
    features: ["vox.cleanup", "vox.vocabulary"],
    ...overrides,
  };
}

describe("verifyLicense", () => {
  it("accepts a valid, in-window token signed by the dev key", () => {
    const token = signLicense(proToken());
    const result = verifyLicense(token, DEV_PUBLIC_KEY, NOW);
    expect(result.status).toBe("valid");
    expect(result.token).toMatchObject({ tier: "pro", id: "lic-123" });
  });

  it("verifies offline against a hex-encoded key (no network, no async)", () => {
    const token = signLicense(proToken());
    const hexKey = ed.etc.bytesToHex(DEV_PUBLIC_KEY);
    // A synchronous return value is itself proof there's no network/WebCrypto.
    const result = verifyLicense(token, hexKey, NOW);
    expect(result.status).toBe("valid");
  });

  it("reports expired when the expiry has passed", () => {
    const token = signLicense(
      proToken({ expiry: new Date(NOW - DAY).toISOString() }),
    );
    const result = verifyLicense(token, DEV_PUBLIC_KEY, NOW);
    expect(result.status).toBe("expired");
    expect(result.token).not.toBeNull(); // signature was authentic
  });

  it("treats a perpetual (expiry: null) token as valid", () => {
    const token = signLicense(proToken({ expiry: null }));
    expect(verifyLicense(token, DEV_PUBLIC_KEY, NOW).status).toBe("valid");
  });

  it("reports not-yet-valid when issuedAt is in the future (clock skew)", () => {
    const token = signLicense(
      proToken({ issuedAt: new Date(NOW + DAY).toISOString() }),
    );
    expect(verifyLicense(token, DEV_PUBLIC_KEY, NOW).status).toBe("not-yet-valid");
  });

  it("rejects a tampered payload as invalid-signature", () => {
    const token = signLicense(proToken());
    const [payloadSeg, sigSeg] = token.split(".");
    // Flip a character in the payload so it no longer matches the signature.
    const swapped = payloadSeg[0] === "A" ? "B" : "A";
    const tampered = `${swapped}${payloadSeg.slice(1)}.${sigSeg}`;
    const result = verifyLicense(tampered, DEV_PUBLIC_KEY, NOW);
    expect(result.status).toBe("invalid-signature");
    expect(result.token).toBeNull(); // untrusted payload is never returned
  });

  it("rejects a token signed by a different key", () => {
    const wrongKey = ed.utils.randomPrivateKey();
    const token = signLicense(proToken(), wrongKey);
    const result = verifyLicense(token, DEV_PUBLIC_KEY, NOW);
    expect(result.status).toBe("invalid-signature");
    expect(result.token).toBeNull();
  });

  it("reports malformed for junk / wrong-shape input", () => {
    expect(verifyLicense("", DEV_PUBLIC_KEY, NOW).status).toBe("malformed");
    expect(verifyLicense("not-a-token", DEV_PUBLIC_KEY, NOW).status).toBe("malformed");
    expect(verifyLicense("only.one.two.three", DEV_PUBLIC_KEY, NOW).status).toBe("malformed");
    // Valid signature over a shape-invalid payload still reads as malformed.
    const badShape = signLicense({ nope: true } as unknown as LicenseToken);
    expect(verifyLicense(badShape, DEV_PUBLIC_KEY, NOW).status).toBe("malformed");
  });

  it("matches the embedded public key derivation", () => {
    // Guards against the fixture private key drifting from public-key.ts.
    expect(ed.etc.bytesToHex(ed.getPublicKey(DEV_PRIVATE_KEY))).toBe(
      "bd988e92baec2f89a211b271c62cb70a6027f712ee9c76a6d036de7d922cc9f5",
    );
  });
});

describe("entitlementsFor", () => {
  it("unlocks the token's features on a valid result", () => {
    const result = verifyLicense(signLicense(proToken()), DEV_PUBLIC_KEY, NOW);
    const ent = entitlementsFor(result);
    expect(ent.tier).toBe("pro");
    expect(ent.hasFeature("vox.cleanup")).toBe(true);
    expect(ent.hasFeature("vox.vocabulary")).toBe(true);
    expect(ent.hasFeature("vox.commands")).toBe(false); // not in this token
  });

  it("degrades expired / tampered / future tokens to the free tier", () => {
    const expired = verifyLicense(
      signLicense(proToken({ expiry: new Date(NOW - DAY).toISOString() })),
      DEV_PUBLIC_KEY,
      NOW,
    );
    const tampered = verifyLicense("bad.token", DEV_PUBLIC_KEY, NOW);
    for (const result of [expired, tampered]) {
      const ent = entitlementsFor(result);
      expect(ent.tier).toBe("free");
      expect(ent.hasFeature("vox.cleanup")).toBe(false);
      expect(ent.features.size).toBe(0);
    }
  });

  it("freeEntitlements grants nothing", () => {
    const ent = freeEntitlements();
    expect(ent.tier).toBe("free");
    expect(ent.hasFeature("anything")).toBe(false);
  });
});
