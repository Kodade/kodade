import { externalUrls as tauriExternalUrls } from "../ipc/transport";

// Mirrors Rust's allowlist so invalid or relative links do not even invoke the
// opener. Rust repeats this validation because the frontend is not a boundary.
export function isAllowedExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Read the literal attribute, not HTMLAnchorElement.href: the latter resolves a
// relative or fragment link against the running app/dev-server URL before the
// allowlist sees it.
export function rawAllowedAnchorHref(link: HTMLAnchorElement): string | null {
  const href = link.getAttribute("href");
  return href && isAllowedExternalUrl(href) ? href : null;
}

export async function openMarkdownLink(value: string): Promise<void> {
  if (!isAllowedExternalUrl(value)) return;
  await tauriExternalUrls.openUrl(value);
}
