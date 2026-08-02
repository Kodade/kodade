// The KödSSH domain model (M11a): host list entries parsed from the user's
// OpenSSH client config, and the host:path pair a remote project pins to.
// Leaf module — types only, no IPC — so config.ts and store/ssh.ts can both
// depend on it without cycles (mirrors harness/model.ts's role).

// One concrete `Host` block from ~/.ssh/config. `alias` is the literal name
// the user types (`ssh <alias>`); the rest are the optional keys we care
// about. Everything else in the block (IdentityFile, ProxyJump, etc.) is left
// to ssh itself — kodade only needs enough to label and connect to the host.
// hostName/user/port are best-effort display metadata: wildcard defaults
// (`Host *`) and Match blocks are NOT resolved into them; ssh computes the
// effective config itself on connect.
export type SshHost = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
};

// A pinned remote project (Pro, M11c): a host alias plus an absolute or `~/…`
// path on that host. Modeled here because it's a shared shape between the
// store and command-building (`src/ssh/command.ts`). Pinned targets persist
// in kodade.json (owned by the projects store) and behave like project entries.
export type RemoteTarget = {
  host: string;
  path: string;
};

// A stable string key for one pinned target, used to index runtime detection
// state (src/store/ssh.ts) and to dedupe pins. `\0` can't appear in a host or
// path, so it's an unambiguous separator.
export function remoteTargetKey(target: RemoteTarget): string {
  return `${target.host}\0${target.path}`;
}

// Remote targets participate in the same project/session tree as local
// projects. Derive their ids from the persisted host:path pair so reopening
// Kodade restores the same nested chats without another id field to migrate.
export const REMOTE_PROJECT_PREFIX = "remote:";

export function remoteProjectId(target: RemoteTarget): string {
  return `${REMOTE_PROJECT_PREFIX}${encodeURIComponent(target.host)}:${encodeURIComponent(target.path)}`;
}

export function remoteTargetForProjectId(
  targets: readonly RemoteTarget[],
  projectId: string,
): RemoteTarget | null {
  return targets.find((target) => remoteProjectId(target) === projectId) ?? null;
}

// Trust a persisted pinned-target entry only if both fields are non-empty
// strings — a hand-edited/partially-corrupt doc must not abort hydration
// (mirrors parseProject's posture in the projects store).
export function parseRemoteTarget(value: unknown): RemoteTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.host !== "string" || typeof c.path !== "string") return null;
  if (c.host === "" || c.path === "") return null;
  // Control chars (only reachable by hand-editing kodade.json) would be typed
  // into the PTY mid-quote — reject rather than trust shell continuation.
  if (/\p{Cc}/u.test(c.host) || /\p{Cc}/u.test(c.path)) return null;
  return { host: c.host, path: c.path };
}

// Remote terminal sessions (M11b) are ordinary sessions created via
// launchInSession(command, base) with base = `${REMOTE_SESSION_PREFIX}<label>`
// — the same session-naming convention every other launcher (gh, providers)
// already uses for its badge, not a parallel labeling system. The prefix
// doubles as the cheap, reliable way to recognize a remote session afterward
// (e.g. counting live ones for the free-tier one-at-a-time gate): no local
// shell or provider base name starts with "ssh ".
export const REMOTE_SESSION_PREFIX = "ssh ";

export function remoteSessionBase(label: string): string {
  return `${REMOTE_SESSION_PREFIX}${label}`;
}

export function isRemoteSessionName(name: string): boolean {
  return name.startsWith(REMOTE_SESSION_PREFIX);
}

// Whether a session runs over ssh (#121). The explicit `remote` marker (set
// at creation from the base-name convention above, and persisted) is
// authoritative — it survives a manual rename, which the prefix check can't.
// The name prefix remains as the fallback for sessions persisted before the
// marker existed. Structural param so this leaf module never imports the
// projects store's SessionMeta.
export function isRemoteSession(s: { name: string; remote?: boolean }): boolean {
  return s.remote === true || isRemoteSessionName(s.name);
}
