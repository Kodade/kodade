// Token wire format + encoding helpers, kept in one place so the verifier and
// the dev-only signing helper agree byte-for-byte on what gets signed.
//
// A license token is a compact, URL-safe, JWT-like string:
//
//     <base64url(payload JSON)>.<base64url(signature)>
//
// The signed message is the UTF-8 bytes of the *payload segment* (the text
// before the dot) — signing the encoded segment, not re-serialized JSON, means
// verification never depends on JSON key ordering or whitespace.

export const TOKEN_SEPARATOR = ".";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

// Uint8Array -> base64url (no padding). btoa/atob exist in the WKWebView and in
// happy-dom (test env); we go through a binary string to stay dependency-free.
export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// base64url -> Uint8Array. Throws on invalid input so callers treat it as a
// malformed token rather than silently decoding garbage.
export function base64urlToBytes(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64); // throws on non-base64 chars
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Split a token into its two segments. Returns null when the shape is wrong so
// the verifier can report "malformed" instead of throwing.
export function splitToken(
  token: string,
): { payloadSegment: string; signatureSegment: string } | null {
  const parts = token.trim().split(TOKEN_SEPARATOR);
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  return { payloadSegment: parts[0], signatureSegment: parts[1] };
}

// Join a payload segment and raw signature bytes into a token string.
export function joinToken(payloadSegment: string, signature: Uint8Array): string {
  return `${payloadSegment}${TOKEN_SEPARATOR}${bytesToBase64url(signature)}`;
}
