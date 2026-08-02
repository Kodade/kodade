// KödSSH remote file tree + preview store (M11d, Pro). Zustand vanilla
// factory, injected SshIpc — same DI shape as src/store/ssh.ts. Owns two
// pieces of state, both keyed off the pinned RemoteTarget:
//   - listings: one capped/depth-bounded `find` probe per target
//   - previews: one capped `head -c` read per (target, path) file
// Every remote call has a visible pending/failed state and a monotonic
// per-key generation guard (mirrors ssh.ts's detectTarget), so a stale
// in-flight probe can never clobber a newer refresh/navigation.

import { createStore } from "zustand/vanilla";
import type { SshIpc } from "../ipc/contract";
import type { RemoteTarget } from "../ssh/model";
import { remoteTargetKey } from "../ssh/model";
import { assertHost, buildRemoteListArgv, buildRemotePreviewArgv } from "../ssh/command";
import { parseRemoteFind, type RemoteListing } from "../ssh/remoteTree";

export type RemoteFilesDeps = {
  ssh: SshIpc;
  listTimeoutMs?: number;
  previewTimeoutMs?: number;
};

// Depth/entry caps for the tree probe (plan requirement: depth 4, 2000
// entries). Byte cap for a file preview: 256 KiB, matching the plan's
// suggested `head -c` size.
const MAX_DEPTH = 4;
const ENTRY_CAP = 2000;
const PREVIEW_BYTE_CAP = 262_144;
const LIST_TIMEOUT_MS = 15_000;
const PREVIEW_TIMEOUT_MS = 10_000;

export type ListingState =
  | { status: "pending" }
  | { status: "ready"; listing: RemoteListing }
  | { status: "failed"; reason: string }
  // The remote probe ran but looks like a non-POSIX shell (exit 127 — the
  // classic "command not found" from cmd.exe/PowerShell as the login shell).
  // Distinct from "failed" so the UI can show the plan's honest
  // "unsupported remote" copy instead of a generic error.
  | { status: "unsupported" };

export type PreviewState =
  | { status: "pending" }
  | { status: "ready"; content: string; truncated: boolean }
  | { status: "binary" } // NUL byte sniffed in the first chunk — no render
  | { status: "failed"; reason: string };

export type RemoteFilesState = {
  listings: Record<string, ListingState>; // key = remoteTargetKey(target)
  // Preview keys are `${host}\0${absolute file path}` — NOT remoteTargetKey —
  // because a remote absolute path is already globally unique per host, and
  // the preview tab (src/store/tabs.ts's `remote-preview` kind) only carries
  // host+path, not the pinned target's root. Keying previews the same way
  // means closing/reopening a preview tab never needs the root path back.
  previews: Record<string, PreviewState>;

  // List one target's tree (the "refresh" affordance re-runs this from
  // scratch — no incremental diffing, matching the plan's read-only scope).
  listTarget(target: RemoteTarget): Promise<void>;
  // Drop a cached listing (tab closed) and invalidate any in-flight probe
  // for it, so reopening the tab re-lists from scratch (mirrors clearPreview).
  clearListing(target: RemoteTarget): void;
  // Fetch one file's read-only preview content, capped and binary-sniffed.
  fetchPreview(host: string, path: string): Promise<void>;
  // Drop a cached preview (tab closed) and invalidate any in-flight fetch for
  // it, so a stale result can't repopulate the entry after it's gone.
  clearPreview(host: string, path: string): void;
};

export function createRemoteFilesStore(deps: RemoteFilesDeps) {
  const listTimeoutMs = deps.listTimeoutMs ?? LIST_TIMEOUT_MS;
  const previewTimeoutMs = deps.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS;
  const listGeneration = new Map<string, number>();
  const previewGeneration = new Map<string, number>();

  return createStore<RemoteFilesState>((set) => ({
    listings: {},
    previews: {},

    async listTarget(target: RemoteTarget) {
      const key = remoteTargetKey(target);
      const gen = (listGeneration.get(key) ?? 0) + 1;
      listGeneration.set(key, gen);

      const apply = (next: ListingState) => {
        if (listGeneration.get(key) !== gen) return; // superseded by a newer refresh
        set((s) => ({ listings: { ...s.listings, [key]: next } }));
      };
      apply({ status: "pending" });

      let host: string;
      try {
        host = assertHost(target.host);
      } catch (err) {
        apply({ status: "failed", reason: err instanceof Error ? err.message : String(err) });
        return;
      }

      try {
        // Argv construction (find probe shape, quoting, caps-in-command)
        // lives in src/ssh/command.ts — the single audited choke point.
        // NOTE the masked-failure edge documented on buildRemoteListArgv:
        // `find … | head` reports HEAD's exit status, so a host with sh but
        // no find parses as an empty dir, not "unsupported" (127 fires only
        // when sh itself is unresolvable). M11e re-verifies this on Windows.
        const res = await deps.ssh.exec(
          host,
          buildRemoteListArgv(target.path, MAX_DEPTH, ENTRY_CAP),
          listTimeoutMs,
        );
        if (res.status === 127) {
          apply({ status: "unsupported" });
          return;
        }
        if (res.status !== 0) {
          apply({ status: "failed", reason: res.stderr.trim() || `find exited ${res.status}` });
          return;
        }
        const listing = parseRemoteFind(target.path, res.stdout, ENTRY_CAP);
        apply({
          status: "ready",
          listing: { ...listing, truncated: listing.truncated || res.truncated },
        });
      } catch (err) {
        apply({ status: "failed", reason: err instanceof Error ? err.message : String(err) });
      }
    },

    async fetchPreview(rawHost: string, path: string) {
      const previewKey = `${rawHost}\0${path}`;
      const gen = (previewGeneration.get(previewKey) ?? 0) + 1;
      previewGeneration.set(previewKey, gen);

      const apply = (next: PreviewState) => {
        if (previewGeneration.get(previewKey) !== gen) return; // superseded/cleared
        set((s) => ({ previews: { ...s.previews, [previewKey]: next } }));
      };
      apply({ status: "pending" });

      let host: string;
      try {
        host = assertHost(rawHost);
      } catch (err) {
        apply({ status: "failed", reason: err instanceof Error ? err.message : String(err) });
        return;
      }

      try {
        // buildRemotePreviewArgv requests cap+1 bytes so the response length
        // alone reveals truncation (see src/ssh/command.ts, the choke point).
        const res = await deps.ssh.exec(
          host,
          buildRemotePreviewArgv(path, PREVIEW_BYTE_CAP),
          previewTimeoutMs,
        );
        if (res.status !== 0) {
          apply({ status: "failed", reason: res.stderr.trim() || `read exited ${res.status}` });
          return;
        }
        // NUL is valid UTF-8 (a one-byte codepoint), so Rust's lossy decode
        // preserves it — a NUL in the first chunk is a reliable binary sniff
        // even though genuinely non-UTF-8 binary bytes elsewhere in the file
        // get lossily mangled by the exec IPC's String-based transport.
        if (res.stdout.includes("\0")) {
          apply({ status: "binary" });
          return;
        }
        const byteLength = new TextEncoder().encode(res.stdout).length;
        const truncated = byteLength > PREVIEW_BYTE_CAP || res.truncated;
        // Trim back to the requested cap (approximate on the exact byte
        // boundary vs. character boundary — acceptable for a capped preview).
        const content = truncated ? res.stdout.slice(0, PREVIEW_BYTE_CAP) : res.stdout;
        apply({ status: "ready", content, truncated });
      } catch (err) {
        apply({ status: "failed", reason: err instanceof Error ? err.message : String(err) });
      }
    },

    clearListing(target: RemoteTarget) {
      const key = remoteTargetKey(target);
      // Bump the generation so an in-flight listTarget run for this key
      // discards its result instead of resurrecting the cleared entry.
      listGeneration.set(key, (listGeneration.get(key) ?? 0) + 1);
      set((s) => {
        if (!(key in s.listings)) return {};
        const next = { ...s.listings };
        delete next[key];
        return { listings: next };
      });
    },

    clearPreview(host: string, path: string) {
      const previewKey = `${host}\0${path}`;
      previewGeneration.set(previewKey, (previewGeneration.get(previewKey) ?? 0) + 1);
      set((s) => {
        if (!(previewKey in s.previews)) return {};
        const next = { ...s.previews };
        delete next[previewKey];
        return { previews: next };
      });
    },
  }));
}

