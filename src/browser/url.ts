// Browser input stays deliberately small: add HTTPS for a bare host and reject
// every scheme except HTTP(S) before anything crosses the Rust seam.
export function normalizeBrowserUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
