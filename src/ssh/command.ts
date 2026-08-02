// The one place Ködade builds SSH launch and exec strings. Every caller goes
// through here so quoting and validation live in a
// single, thoroughly-tested choke point instead of being re-derived at each
// call site.

import { detectMacPlatform } from "../shortcuts/bindings";
import type { RemoteTarget, SshHost } from "./model";

// Conservative allowlist for anything that becomes part of a local shell
// string typed into a terminal (buildSshLaunch) or an ssh argv element
// (buildRemoteExec's host). It must start with an alphanumeric (blocks a
// leading `-`, which ssh/getopt would otherwise treat as a flag) and contain
// only alphanumerics, `.`, `-`, `_`, `@`, `:` — no whitespace, quotes, `;`,
// `$`, `(`, `)`, or any other shell metacharacter.
const HOST_ALLOWLIST = /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/;

// Structural shape of an ad-hoc `user@host[:port]` entry, once the coarse
// allowlist above has already rejected anything hostile.
const AD_HOC_SHAPE = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+)(?::(\d+))?$/;

export type ParsedAdHocHost = {
  user?: string;
  host: string;
  port?: number;
};

// Validate a bare host/alias token (no user@ or :port parts expected) — used
// for SshHost aliases from ~/.ssh/config and RemoteTarget.host. Throws with a
// message safe to surface in the UI.
function validateAlias(alias: string): string {
  if (!HOST_ALLOWLIST.test(alias)) {
    throw new Error(`invalid host: ${alias || "(empty)"}`);
  }
  return alias;
}

// Public alias of validateAlias for callers that only need to validate a
// RemoteTarget.host before handing it to ssh_exec (the store's detection path).
// Throws with a UI-safe message; Rust re-checks the same allowlist.
export function assertHost(host: string): string {
  return validateAlias(host);
}

// Parse and validate an ad-hoc `user@host[:port]` string. Returns null
// (never throws) so the sidebar's input field can validate as-you-type
// without a try/catch — same validation buildSshLaunch relies on internally.
export function parseAdHocHost(raw: string): ParsedAdHocHost | null {
  if (!HOST_ALLOWLIST.test(raw)) return null;
  const match = raw.match(AD_HOC_SHAPE);
  if (!match) return null;
  const [, user, host, portStr] = match;
  if (!host) return null;
  if (!portStr) return { user: user || undefined, host };
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { user: user || undefined, host, port };
}

// The interactive command typed into a local shell to connect: `ssh -t
// <alias>` for a known config host (ssh itself resolves HostName/User/Port
// from the alias — kodade never re-derives them), or `ssh -t user@host [-p
// port]` for an ad-hoc target. Throws on a hostile/malformed host string —
// callers validate ad-hoc input with parseAdHocHost before offering connect,
// but this is the last line of defense.
export function buildSshLaunch(host: string | SshHost): string {
  if (typeof host !== "string") {
    return `ssh -t ${validateAlias(host.alias)}`;
  }
  const parsed = parseAdHocHost(host);
  if (!parsed) throw new Error(`invalid host: ${host || "(empty)"}`);
  const userHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host;
  return parsed.port
    ? `ssh -t ${userHost} -p ${parsed.port}`
    : `ssh -t ${userHost}`;
}

// Single-quote wrap for a POSIX remote shell: closes the quote, emits an
// escaped literal single quote, reopens it. Standard `'"'"'` technique —
// safe for any byte sequence, including embedded `'`, `$()`, backticks, etc.
export function quotePosix(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

// Quote a path for the POSIX shell on the REMOTE host while preserving the
// user-facing `~/…` shorthand offered by KödSSH. A quoted `~` is literal, so
// home-relative paths use the trusted remote `$HOME` value plus a separately
// quoted suffix. Every other path remains one fully quoted literal.
function quoteRemotePath(path: string): string {
  if (path === "~") return `"$HOME"`;
  if (path.startsWith("~/")) {
    return `"$HOME"/${quotePosix(path.slice(2))}`;
  }
  return quotePosix(path);
}

// Single-quote each element of a remote command for the POSIX remote shell.
// ssh concatenates everything after the host with spaces before handing it to
// the remote shell, so without per-element quoting a value like "foo bar" would
// split into two remote arguments. This is the quoting the ssh_exec IPC caller
// (src/store/ssh.ts detection) passes as `argv`; Rust adds the
// `-o BatchMode=yes <host> --` wrapper and runs argv as discrete process args,
// so there is no local injection surface.
export function quoteRemoteArgv(argv: string[]): string[] {
  return argv.map(quotePosix);
}

// Build one trusted program invocation for the POSIX shell on a pinned remote.
// The executable comes from Kodade's provider catalog; every argument is quoted
// independently so a saved endpoint URL cannot become remote shell syntax.
export function buildRemoteProgramLaunch(
  program: string,
  args: string[] = [],
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(program)) {
    throw new Error(`invalid remote program: ${program || "(empty)"}`);
  }
  return `exec ${[program, ...args].map(quotePosix).join(" ")}`;
}

// KödChat uses the same streaming agent process contract locally and remotely.
// For a remote project, the local process is OpenSSH with no pseudo-terminal;
// stdin/stdout stay clean JSON streams while the agent itself runs after a
// quoted `cd` on the host.
export function buildRemoteAgentSpawn(
  target: RemoteTarget,
  program: string,
  args: string[],
): { bin: "ssh"; args: string[] } {
  const host = validateAlias(target.host);
  const remote = `cd ${quoteRemotePath(target.path)} && ${buildRemoteProgramLaunch(program, args)}`;
  return {
    bin: "ssh",
    args: ["-o", "BatchMode=yes", "-T", host, "--", remote],
  };
}

// The full ssh argv vector form (host + `--` wrapper included), kept for
// callers/tests that want the complete shape in one place. The live detection
// path uses quoteRemoteArgv + a separate host arg because Rust's ssh_exec owns
// the `-o BatchMode=yes <host> --` wrapper.
export function buildRemoteExec(
  target: RemoteTarget,
  argv: string[],
): string[] {
  return [
    "-o",
    "BatchMode=yes",
    validateAlias(target.host),
    "--",
    ...quoteRemoteArgv(argv),
  ];
}

// --- Remote file tree + preview (M11d) ---
//
// Both builders return a fully-quoted argv ready for SshIpc.exec (Rust adds
// the `-o BatchMode=yes <host> --` wrapper). They live HERE, not in the
// remoteFiles store, so every remote-command string kodade constructs stays
// inside this one audited choke point.

// The portable remote listing probe, run via `sh -c <probe>` — the probe
// travels as a single argv element carrying full shell syntax, single-quoted
// once for the remote shell by quoteRemoteArgv.
//
// Why this shape, not `find -printf`: `-printf` is a GNU findutils-only
// extension (BSD/macOS find doesn't have it), so it can't be the portable
// choice. Instead each matched entry runs a POSIX
// `-exec printf '<marker>:%s\n' {} \;` — `-exec ... {} ;` and `printf` are
// both POSIX-required, so this marks dir/file/symlink type without relying on
// any implementation-specific flag. `-maxdepth` is technically a de facto
// (not POSIX-strict) extension, but it's present in GNU, BSD, and every find
// a real workstation ships — the alternative (no depth cap) is a strictly
// worse tradeoff given the plan's bounded-recursion requirement. `.git` and
// `node_modules` are pruned so a typical repo doesn't blow the entry cap on
// build/dependency noise. The pipeline runs through `head -n <cap+1>` so
// truncation is detectable (line count > cap) without a second round trip,
// and a runaway remote tree can't stream unbounded output over ssh_exec.
//
// The probe cds into the target first and runs `find .`, so every entry
// comes back `./`-relative. That keeps the listing independent of what the
// remote expands `"$HOME"` to: parseRemoteFind rejoins the relative entries
// to the literal pinned root (which may be `~/…`), a value Kodade knows,
// instead of trying to match find's expanded absolute prefix (which it
// doesn't). The `cd` also un-masks a bad/missing target path — it fails
// BEFORE the pipeline, so `&&` short-circuits and sh exits nonzero with
// cd's stderr, surfacing as a "failed" listing rather than an empty one.
//
// MASKED-FAILURE EDGE (narrowed, not gone): the pipeline's exit status is
// `head`'s, not `find`'s (a POSIX pipeline reports the LAST command's
// status). So a POSIX-ish host that has `sh` but no `find` prints "find:
// not found" to stderr, `head` still exits 0, and the result parses as an
// empty directory — NOT as the 127 "unsupported remote" state (127 only
// fires when `sh` itself is unresolvable). Acceptable for v1 (a real POSIX
// workstation always has find); revisit during M11e's Windows-remote
// verification.
export function buildRemoteListArgv(
  path: string,
  maxDepth: number,
  entryCap: number,
): string[] {
  const probe =
    `cd ${quoteRemotePath(path)} && ` +
    `find . -maxdepth ${maxDepth} ` +
    `\\( -name .git -o -name node_modules \\) -prune ` +
    `-o -type d -exec printf 'D:%s\\n' {} \\; ` +
    `-o -type f -exec printf 'F:%s\\n' {} \\; ` +
    `-o -type l -exec printf 'L:%s\\n' {} \\; ` +
    `| head -n ${entryCap + 1}`;
  return quoteRemoteArgv(["sh", "-c", probe]);
}

// A capped read of one remote file for the read-only preview. Requests one
// byte past the cap so the response length alone reveals truncation without
// a second round trip; `head -c` enforces the cap REMOTELY, so a huge file
// never crosses the wire.
export function buildRemotePreviewArgv(
  path: string,
  byteCap: number,
): string[] {
  return [
    ...quoteRemoteArgv(["head", "-c", String(byteCap + 1)]),
    quoteRemotePath(path),
  ];
}

// PowerShell single-quoted strings are literal (no `$` interpolation, no
// backtick escapes) — the one property we need for the outer wrap. The only
// escape PowerShell recognizes inside a single-quoted string is a doubled
// literal quote (`''` -> `'`), unlike POSIX's `'"'"'` close/escape/reopen
// trick. Used for the outer (LOCAL shell) layer only on Windows — never for
// the inner remote-shell quoting, which stays POSIX (quotePosix) regardless
// of the local OS because the remote is always POSIX.
// Caveat: PowerShell re-marshals the parsed argument when invoking a native
// binary (ssh.exe), and Windows PowerShell 5.1's legacy marshalling differs
// from pwsh 7.2+ (PSNativeCommandArgumentPassing) for args containing quotes
// WITH spaces. Today's inputs (exec "$SHELL" -l, bare provider tokens) never
// hit that case — revisit before passing quoted-args-with-spaces here.
function quotePowerShell(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// cmd.exe has no single-quote quoting at all — a bare `'` is just a literal
// character, so a single-quoted string with an embedded `&&` still splits on
// cmd's own command-separator rules. Double quotes DO suppress cmd's
// metacharacter handling for the span they enclose, so this wraps in double
// quotes and backslash-escapes any embedded `"` — the same convention the
// receiving process's own argv parser (CommandLineToArgvW / CRT, which is
// what ssh.exe uses) expects for a literal embedded quote. cmd.exe is only
// ever the LOCAL shell as PATH's last-resort fallback when neither pwsh nor
// powershell.exe is found (src-tauri/src/shell.rs); PowerShell is preferred
// and is the primary supported Windows shell.
// NOTE: this branch is unreachable in production v1 (defaultLocalShell never
// returns "cmd") and is defense-in-depth only. Known cmd caveats if it is
// ever wired: cmd expands %VAR% even inside double quotes, and its quote
// scan toggles on every raw `"` (no backslash awareness) before argv parsing.
function quoteCmd(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

// Which LOCAL shell interprets the line launchInSession types. "posix" is
// bash/zsh (macOS, and any POSIX login shell); "powershell" is pwsh/
// powershell.exe, kodade's preferred Windows shell; "cmd" is the ComSpec
// fallback shell.rs uses only when no PowerShell binary is found. Exported so
// callers/tests can force a branch without faking navigator.
export type LocalShellKind = "posix" | "powershell" | "cmd";

// Default local shell inferred from OS: mac/Linux -> posix, Windows ->
// powershell (kodade always prefers pwsh/powershell over cmd when spawning a
// login shell — see src-tauri/src/shell.rs's resolution order). Reuses the
// same isMac detection every other platform-conditional in the repo uses
// (src/shortcuts/bindings.ts) rather than inventing a second convention.
function defaultLocalShell(): LocalShellKind {
  return detectMacPlatform() ? "posix" : "powershell";
}

// The interactive command typed into a LOCAL shell to open a remote PROJECT
// terminal: ssh with a tty, `cd` into the remote path, then run
// `remoteCommand` on the remote. The default drops the user into their own
// login shell in that directory; a provider launch passes `exec <launch>` so
// the CLI starts already cd'd into the remote project.
//
// Because launchInSession TYPES this line into the local shell, the whole
// remote command (cd && exec …) must travel as ONE quoted argument — an
// unquoted `&&` would be interpreted by the LOCAL shell, running the exec
// locally after ssh exits instead of on the remote. So: the path is
// single-quoted for the remote shell first (always POSIX — the remote is
// always POSIX per plan), then the entire remote command is quoted AGAIN for
// the LOCAL shell using that shell's own literal-string syntax (`localShell`,
// defaulting to the caller's OS): quotePosix's '"'"' escaping on macOS/Linux,
// PowerShell's doubled-`'` escaping or cmd's backslash-`"` escaping on
// Windows — bash/zsh, PowerShell, and cmd each parse quoting differently, so
// using POSIX escaping unconditionally (the pre-M11e bug) types a broken or
// silently-wrong line into a Windows local shell. Only the path is
// attacker-influenced; the inner quotePosix neutralizes spaces/quotes/`;`/
// `$()` in it, the host is allowlist-validated, and `remoteCommand` is
// trusted catalog text. Throws on a hostile/malformed host.
export function buildSshProjectLaunch(
  target: RemoteTarget,
  remoteCommand: string = `exec "$SHELL" -l`,
  localShell: LocalShellKind = defaultLocalShell(),
): string {
  const host = validateAlias(target.host);
  const remote = `cd ${quoteRemotePath(target.path)} && ${remoteCommand}`;
  const quoteOuter =
    localShell === "posix"
      ? quotePosix
      : localShell === "powershell"
        ? quotePowerShell
        : quoteCmd;
  return `ssh -t ${host} ${quoteOuter(remote)}`;
}
