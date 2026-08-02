// base64 <-> bytes helpers for the PTY byte stream. We keep PTY output as raw
// bytes (Uint8Array) end-to-end so multibyte UTF-8 and escape sequences that
// straddle chunk boundaries stay intact; xterm decodes the bytes itself.

// Decode a base64 string (from a PTY output event) into raw bytes.
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Encode input text (keystrokes) as base64 for a PTY write. Handles non-ASCII.
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
