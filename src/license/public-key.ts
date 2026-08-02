// The Ed25519 public key the app verifies license tokens against.
//
// ⚠️ DEV KEY — NOT A PRODUCTION SIGNING KEY.
// This is the public half of the deterministic dev keypair in
// src/license/__fixtures__/dev-keypair.ts, used so the whole activation flow is
// exercisable end-to-end during development.
//
// BEFORE SHIPPING PRO: replace this with the PUBLIC key of the production
// signing keypair (whose private key lives only in the license issuer's
// secrets, never in this repo). Swapping this constant is the entire cutover —
// no other code changes. Tests point at the dev key explicitly, so they keep
// passing after the swap.
export const LICENSE_PUBLIC_KEY =
  "bd988e92baec2f89a211b271c62cb70a6027f712ee9c76a6d036de7d922cc9f5";
