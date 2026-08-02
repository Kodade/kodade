// Pure parser for OpenSSH client config text (~/.ssh/config and its Include
// targets). Zero IPC — the caller (store/ssh.ts) reads the file bytes and
// resolves Include paths; this module only turns text into data.
//
// Conservative by design: only concrete `Host`
// aliases become list entries — any alias containing a wildcard (`*`, `?`)
// or a negation (`!...`) is skipped, since kodade only needs a literal name
// to hand to `ssh <alias>`, never OpenSSH's full pattern-matching semantics.
// Unknown keys are silently ignored.
//
// The hostName/user/port on each SshHost are best-effort DISPLAY metadata
// from the alias's own block: wildcard defaults (`Host *`) and Match blocks
// are not resolved into them. ssh itself computes the effective config when
// the terminal actually connects, so the values here only label the list.

import type { SshHost } from "./model";

export type ParsedSshConfig = {
  hosts: SshHost[];
  // Raw `Include` values in file order, unexpanded (may contain `~`, globs,
  // relative fragments) — resolving/globbing them is the caller's job.
  includes: string[];
};

// A single Host alias is "concrete" (usable as a list entry / connect target)
// only if it carries none of OpenSSH's pattern syntax.
function isConcreteAlias(alias: string): boolean {
  return alias.length > 0 && !alias.includes("*") && !alias.includes("?") && !alias.startsWith("!");
}

// Split one non-comment, non-blank config line into (key, rest). Accepts the
// three separator forms OpenSSH allows: whitespace, `=`, or `key = value`.
function splitKeyValue(line: string): { key: string; value: string } | null {
  const match = line.match(/^([^\s=]+)\s*=?\s*(.*)$/);
  if (!match) return null;
  return { key: match[1], value: match[2].trim() };
}

export function parseSshConfig(text: string): ParsedSshConfig {
  // Preserve first-appearance order while letting a later block for the same
  // alias fill in already-set keys with the block that ran first (mirrors
  // OpenSSH's "first match wins" for a given parameter) — but since we only
  // read literal Host blocks in file order, in practice the common case is
  // one block per alias and this just means "earlier values are not
  // overwritten by a later duplicate block."
  const order: string[] = [];
  const byAlias = new Map<string, SshHost>();
  const includes: string[] = [];

  // The host entries the CURRENT Host directive's keys apply to. Reset on
  // every `Host` line; empty when every alias on the line was a pattern (so
  // its HostName/User/Port lines are simply ignored — matching nothing).
  let current: SshHost[] = [];

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const split = splitKeyValue(line);
    if (!split) continue;
    const key = split.key.toLowerCase();

    // A `Match` block ends the current Host block's key collection: we never
    // evaluate Match conditions, so its HostName/User/Port must not leak into
    // the preceding Host's entry.
    if (key === "match") {
      current = [];
      continue;
    }

    if (key === "host") {
      current = [];
      for (const alias of split.value.split(/\s+/).filter(Boolean)) {
        if (!isConcreteAlias(alias)) continue;
        let host = byAlias.get(alias);
        if (!host) {
          host = { alias };
          byAlias.set(alias, host);
          order.push(alias);
        }
        current.push(host);
      }
      continue;
    }

    if (key === "include") {
      for (const path of split.value.split(/\s+/).filter(Boolean)) includes.push(path);
      continue;
    }

    // Every remaining key we care about only makes sense inside a Host block.
    if (current.length === 0) continue;

    if (key === "hostname") {
      for (const host of current) if (host.hostName === undefined) host.hostName = split.value;
    } else if (key === "user") {
      for (const host of current) if (host.user === undefined) host.user = split.value;
    } else if (key === "port") {
      const port = Number.parseInt(split.value, 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        for (const host of current) if (host.port === undefined) host.port = port;
      }
    }
    // Unknown keys (IdentityFile, ProxyJump, etc.) are ignored — ssh itself
    // still honors them when the terminal actually connects.
  }

  return { hosts: order.map((alias) => byAlias.get(alias)!), includes };
}
