export type Tab =
  | { kind: "file"; path: string }
  | { kind: "github" }
  | { kind: "browser"; url: string }
  | { kind: "review" }
  // KödSSH (M11d, Pro): the browsable tree for one pinned remote target.
  | { kind: "remote-files"; host: string; path: string }
  // KödSSH (M11d, Pro): a read-only preview of one file on a remote target.
  | { kind: "remote-preview"; host: string; path: string };

// Persisted tab encoding stays a string[]: legacy file paths remain unchanged,
// while non-file tabs use reserved kind prefixes. This keeps old documents a
// valid migration input and leaves room for later browser tabs.
export const GITHUB_TAB_ENCODING = "github:";
export const BROWSER_TAB_PREFIX = "browser:";
// KödPR (M12): one review tab per project. Scope (worktree, and later branch/pr)
// lives in the review store, not the tab, so a single reserved encoding caps it
// at one tab per project — the scope picker (M12d) switches content in place.
// The `review:` prefix is reserved; only the bare form decodes today.
export const REVIEW_TAB_PREFIX = "review:";
// KödSSH (M11d): host and path are `\0`-joined (mirrors remoteTargetKey) —
// neither can contain a NUL byte (command.ts's host allowlist rejects control
// chars, and remote paths from the find probe are NUL-delimited-free line
// output), so the join is unambiguous to split back apart.
export const REMOTE_FILES_TAB_PREFIX = "remote-files:";
export const REMOTE_PREVIEW_TAB_PREFIX = "remote-preview:";

export function encodeTab(tab: Tab): string {
  if (tab.kind === "file") return tab.path;
  if (tab.kind === "browser") return `${BROWSER_TAB_PREFIX}${tab.url}`;
  if (tab.kind === "review") return REVIEW_TAB_PREFIX;
  if (tab.kind === "remote-files") return `${REMOTE_FILES_TAB_PREFIX}${tab.host}\0${tab.path}`;
  if (tab.kind === "remote-preview") return `${REMOTE_PREVIEW_TAB_PREFIX}${tab.host}\0${tab.path}`;
  return GITHUB_TAB_ENCODING;
}

// Split a `<host>\0<path>` remote tab body back into its parts. Returns null
// if the separator is missing (corrupt/hand-edited persistence) or either
// side is empty.
function splitRemoteBody(body: string): { host: string; path: string } | null {
  const sep = body.indexOf("\0");
  if (sep === -1) return null;
  const host = body.slice(0, sep);
  const path = body.slice(sep + 1);
  if (!host || !path) return null;
  return { host, path };
}

export function decodeTab(value: string): Tab | null {
  if (!value) return null;
  if (value === GITHUB_TAB_ENCODING) return { kind: "github" };
  if (value.startsWith(BROWSER_TAB_PREFIX)) {
    return { kind: "browser", url: value.slice(BROWSER_TAB_PREFIX.length) };
  }
  // KödHarness moved from workspace tabs into Settings. Drop legacy persisted
  // encodings so an old layout cannot reopen the retired workspace surface.
  if (value.startsWith("harness:")) return null;
  // KödMem moved from workspace tabs into Settings. Drop legacy persisted
  // encodings so an old layout cannot reopen the retired workspace surface.
  if (value.startsWith("memory:")) return null;
  if (value.startsWith(REVIEW_TAB_PREFIX)) {
    // Only the bare `review:` form is valid today; any suffix is an
    // unrecognized/corrupt encoding — drop it rather than guess a scope.
    return value === REVIEW_TAB_PREFIX ? { kind: "review" } : null;
  }
  if (value.startsWith(REMOTE_FILES_TAB_PREFIX)) {
    // The browsable remote tree moved from an editor tab into the far-right
    // files pane. Drop the old persisted tab so upgrading cannot reopen the
    // duplicate center-pane browser captured in the 1.4.8 field report.
    return null;
  }
  if (value.startsWith(REMOTE_PREVIEW_TAB_PREFIX)) {
    const parsed = splitRemoteBody(value.slice(REMOTE_PREVIEW_TAB_PREFIX.length));
    return parsed ? { kind: "remote-preview", ...parsed } : null;
  }
  return { kind: "file", path: value };
}

export function encodeTabs(tabs: Tab[]): string[] {
  return tabs.map(encodeTab);
}

export function decodeTabs(values: string[]): Tab[] {
  const seen = new Set<string>();
  let sawBrowser = false;
  const tabs: Tab[] = [];
  for (const value of values) {
    const tab = decodeTab(value);
    if (!tab) continue;
    const key = encodeTab(tab);
    if (seen.has(key) || (tab.kind === "browser" && sawBrowser)) continue;
    seen.add(key);
    if (tab.kind === "browser") sawBrowser = true;
    tabs.push(tab);
  }
  return tabs;
}

export function tabsEqual(a: Tab | null, b: Tab | null): boolean {
  if (a === null || b === null) return a === b;
  return encodeTab(a) === encodeTab(b);
}
