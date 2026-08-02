// KödSSH store (M11a): Zustand vanilla factory, injected deps — same shape as
// the harness store (src/store/harness.ts). init() detects the user's ssh
// binary, reads ~/.ssh/config (following Include directives), parses it with
// the pure src/ssh/config.ts parser, and populates the host list. No UI yet
// — this is the foundation M11b's sidebar section will read from.

import { createStore } from "zustand/vanilla";
import type { SshIpc } from "../ipc/contract";
import type { RemoteTarget, SshHost } from "../ssh/model";
import { remoteTargetKey } from "../ssh/model";
import { parseSshConfig } from "../ssh/config";
import { assertHost, quoteRemoteArgv } from "../ssh/command";
import { AVAILABLE_PROVIDERS } from "../providers/catalog";

export type SshDeps = {
  ssh: SshIpc;
  // Injectable so tests can shorten the per-probe timeout; defaults to
  // PROBE_TIMEOUT_MS. This is the ms budget handed to each ssh_exec probe.
  probeTimeoutMs?: number;
};

export type SshStatus = "idle" | "loading" | "ready" | "error";

// Per-provider remote detection state for one pinned target (Pro, M11c). Every
// remote call has a visible pending/failed/ready presentation — a slow or
// non-POSIX remote surfaces as "failed", never a hang or crash.
export type DetectionState =
  | { status: "pending" }
  | { status: "ready" } // `command -v <bin>` found the CLI on the remote
  | { status: "failed"; reason: string }; // not found, unsupported remote, or timeout

// key (remoteTargetKey) -> providerId -> state.
export type TargetDetections = Record<string, Record<string, DetectionState>>;

// The agent CLIs probed on a remote, derived from the provider catalog rather
// than hardcoded, so adding a provider there extends remote detection too.
const PROBE_PROVIDERS = AVAILABLE_PROVIDERS.map((p) => ({
  id: p.id,
  bin: p.remote?.bin ?? p.bin,
}));

// Per-probe ssh_exec budget. Each `command -v` is tiny, but a dead/slow host
// must not stall the row — Rust kills the child at this bound and the call
// rejects, which we render as "failed".
const PROBE_TIMEOUT_MS = 8000;

export type SshState = {
  status: SshStatus;
  sshPath?: string;
  sshVersion?: string;
  hosts: SshHost[];
  error?: string;
  // Runtime-only (never persisted): remote provider detection per pinned target.
  detections: TargetDetections;

  // Detect ssh, read+parse the config (including Include targets), and
  // populate hosts. Safe to call again (e.g. a manual refresh) — each call
  // starts from a clean slate.
  init(): Promise<void>;

  // Probe the agent CLIs on a pinned target over ssh_exec, moving each
  // provider pending -> ready/failed. Concurrent across providers; safe to
  // call again (re-detect) — a stale in-flight probe can't clobber a newer
  // run for the same target (monotonic per-key generation guard).
  detectTarget(target: RemoteTarget): Promise<void>;

  // Drop a target's detection state (called on unpin). Also invalidates any
  // in-flight probe run for the key, so a stale result can't repopulate the
  // entry — an unpin → repin re-probes from scratch.
  clearDetections(target: RemoteTarget): void;
};

// Include recursion is bounded so a self-referencing or cyclical Include
// chain can never hang the store — five hops covers every realistic config
// layout (main file + a handful of conf.d fragments).
const MAX_INCLUDE_DEPTH = 5;
// Key used to dedup the main config file in the visited set (readConfig's
// `path` is undefined for it, which can't itself be a Set key alongside the
// string include paths).
const MAIN_CONFIG_KEY = "\0main";

export function createSshStore(deps: SshDeps) {
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  // Monotonic per-target generation: each detectTarget() run claims the next
  // token for its key; a probe result applies only if no newer run has started.
  const detectGeneration = new Map<string, number>();

  return createStore<SshState>((set, get) => ({
    status: "idle",
    hosts: [],
    detections: {},

    clearDetections(target: RemoteTarget) {
      const key = remoteTargetKey(target);
      // Bump the generation so an in-flight detectTarget run for this key
      // discards its results instead of resurrecting the cleared entry.
      detectGeneration.set(key, (detectGeneration.get(key) ?? 0) + 1);
      set((s) => {
        if (!(key in s.detections)) return {};
        const next = { ...s.detections };
        delete next[key];
        return { detections: next };
      });
    },

    async detectTarget(target: RemoteTarget) {
      const key = remoteTargetKey(target);
      const gen = (detectGeneration.get(key) ?? 0) + 1;
      detectGeneration.set(key, gen);

      // Validate the host once up front; an invalid host fails every provider
      // rather than throwing (Rust would reject it too, but this keeps the UI
      // honest without a round-trip).
      let host: string;
      try {
        host = assertHost(target.host);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        set((s) => ({
          detections: {
            ...s.detections,
            [key]: Object.fromEntries(
              PROBE_PROVIDERS.map((p) => [
                p.id,
                { status: "failed", reason } as DetectionState,
              ]),
            ),
          },
        }));
        return;
      }

      // Everything starts pending — visible immediately.
      set((s) => ({
        detections: {
          ...s.detections,
          [key]: Object.fromEntries(
            PROBE_PROVIDERS.map((p) => [
              p.id,
              { status: "pending" } as DetectionState,
            ]),
          ),
        },
      }));

      // Apply one provider's outcome, but only if this run is still current.
      const applyState = (providerId: string, next: DetectionState) => {
        if (detectGeneration.get(key) !== gen) return;
        set((s) => ({
          detections: {
            ...s.detections,
            [key]: { ...(s.detections[key] ?? {}), [providerId]: next },
          },
        }));
      };

      // Probe every provider concurrently. `command -v <bin>` exits 0 and
      // prints a path when the CLI is on the remote PATH; anything else (exit
      // non-zero, a rejected/timed-out call on a slow or non-POSIX remote) is a
      // clean "failed", never a throw that escapes.
      await Promise.all(
        PROBE_PROVIDERS.map(async ({ id, bin }) => {
          try {
            const res = await deps.ssh.exec(
              host,
              quoteRemoteArgv(["command", "-v", bin]),
              probeTimeoutMs,
            );
            const found = res.status === 0 && res.stdout.trim() !== "";
            applyState(
              id,
              found
                ? { status: "ready" }
                : { status: "failed", reason: "not found" },
            );
          } catch (err) {
            applyState(id, {
              status: "failed",
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    },

    async init() {
      set({ status: "loading", error: undefined });

      let sshPath: string | undefined;
      let sshVersion: string | undefined;
      try {
        const detected = await deps.ssh.detect();
        sshPath = detected.path;
        sshVersion = detected.version;
      } catch (error) {
        set({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          sshPath: undefined,
          sshVersion: undefined,
          hosts: [],
        });
        return;
      }

      try {
        const hosts = await loadHosts(deps.ssh);
        set({ status: "ready", sshPath, sshVersion, hosts, error: undefined });
      } catch (error) {
        set({
          status: "error",
          sshPath,
          sshVersion,
          hosts: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }));
}

// A simple trailing glob (`<dir>/*` or `<dir>/*<suffix>`, e.g. `config.d/*`
// or `conf.d/*.conf`) — the pattern tools like 1Password/orbstack write.
// Returns the directory part and the required name suffix ("" for a bare
// `*`), or null when the include isn't a glob we expand (no wildcard, a
// wildcard in the directory part, or a non-trailing-star pattern) —
// conservative, matching the parser's own posture.
function splitTrailingGlob(
  include: string,
): { dir: string; suffix: string } | null {
  if (!include.includes("*") && !include.includes("?")) return null;
  const slash = include.lastIndexOf("/");
  const dir = slash >= 0 ? include.slice(0, slash) : "";
  const pattern = slash >= 0 ? include.slice(slash + 1) : include;
  if (dir.includes("*") || dir.includes("?")) return null;
  if (!pattern.startsWith("*")) return null;
  const suffix = pattern.slice(1);
  if (suffix.includes("*") || suffix.includes("?")) return null;
  return { dir, suffix };
}

// Read the main config, then walk its Include directives (bounded depth,
// deduped by path) merging every file's concrete Host aliases into one list.
// Simple trailing-glob Includes are expanded via the guarded ssh_list_dir;
// other patterns are skipped. First occurrence of an alias wins (mirrors
// config.ts's own within-file rule), and a missing file (readConfig() ->
// null) at any depth simply contributes no hosts — only the main config's
// own read failure propagates as a store error; a bad Include target is
// skipped so one stray Include can't blank the whole host list.
async function loadHosts(ssh: SshIpc): Promise<SshHost[]> {
  const visited = new Set<string>();
  const byAlias = new Map<string, SshHost>();
  const order: string[] = [];

  function merge(hosts: SshHost[]) {
    for (const host of hosts) {
      if (byAlias.has(host.alias)) continue;
      byAlias.set(host.alias, host);
      order.push(host.alias);
    }
  }

  async function visit(path: string | undefined, depth: number): Promise<void> {
    const key = path ?? MAIN_CONFIG_KEY;
    if (visited.has(key) || depth > MAX_INCLUDE_DEPTH) return;
    visited.add(key);

    const text = await ssh.readConfig(path);
    if (text === null) return;
    const parsed = parseSshConfig(text);
    merge(parsed.hosts);

    for (const include of parsed.includes) {
      try {
        const glob = splitTrailingGlob(include);
        if (glob) {
          // Expand `<dir>/*<suffix>`: list the (guarded) directory and visit
          // each matching fragment. A missing dir lists as null — no hosts.
          const names = await ssh.listDir(
            glob.dir === "" ? undefined : glob.dir,
          );
          for (const name of names ?? []) {
            if (!name.endsWith(glob.suffix)) continue;
            const path = glob.dir === "" ? name : `${glob.dir}/${name}`;
            await visit(path, depth + 1);
          }
        } else if (!include.includes("*") && !include.includes("?")) {
          await visit(include, depth + 1);
        }
        // Any other pattern shape (a wildcard mid-path, `?` globs) is
        // conservatively skipped — those hosts still work via ad-hoc entry.
      } catch {
        // A rejected Include target (outside ~/.ssh, permission denied, …)
        // is skipped rather than failing the whole store.
      }
    }
  }

  await visit(undefined, 0);
  return order.map((alias) => byAlias.get(alias)!);
}
