// KödWork's output-ledger seam (#44). The store owns review policy; the real
// implementation owns run-scoped filesystem observation, git diff loading,
// and reversible non-git snapshots.

import type { RiskBucket } from "../review/model";
import type { FileDiff, NumstatEntry, ReviewComment } from "../review/model";
import type { GitIpc, KodworkIpc } from "../ipc/contract";
import { parseStatusPorcelainV2, parseUnifiedDiff } from "../review/parse";
import { compileFixPrompt } from "../review/prompt";
import { rankFiles } from "../review/rank";
import type { KodworkTask } from "./model";

export type KodworkFileChange = {
  path: string;
  relativePath: string;
  change: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  humanTouched: boolean;
  before: string | null;
  after: string | null;
  bucket: RiskBucket;
  reasons: string[];
};

export type KodworkReview = {
  kind: "git" | "folder" | null;
  status:
    | "idle"
    | "collecting"
    | "pending"
    | "accepted"
    | "restoring"
    | "restore-failed";
  files: KodworkFileChange[];
  feedback: string;
  fingerprint: string | null;
};

export const EMPTY_KODWORK_REVIEW: KodworkReview = {
  kind: null,
  status: "idle",
  files: [],
  feedback: "",
  fingerprint: null,
};

export type KodworkRestorePlan = {
  taskId: string;
  owner: { surface: "kodwork"; scopeId: string };
  files: KodworkFileChange[];
};

export interface KodworkLedger {
  begin(task: KodworkTask): Promise<void>;
  finish(task: KodworkTask): Promise<KodworkReview>;
  accept(taskId: string): Promise<void>;
  compileFeedback(review: KodworkReview): Promise<string> | string;
  prepareRestore(task: KodworkTask): Promise<KodworkRestorePlan> | KodworkRestorePlan;
  applyRestore(plan: KodworkRestorePlan): Promise<{ ok: true } | { ok: false; reason: string }>;
  rollbackRestore(plan: KodworkRestorePlan): Promise<void>;
}

export function createKodworkLedger({
  ipc,
  git,
}: {
  ipc: KodworkIpc;
  git: GitIpc;
}): KodworkLedger {
  const roots = new Map<string, string>();
  const diffsByFingerprint = new Map<string, FileDiff[]>();

  return {
    async begin(task) {
      roots.set(task.id, task.folder);
      await ipc.begin(task.id, task.folder);
    },

    async finish(task) {
      const native = await ipc.finish(task.id);
      let nativeFiles: Array<Omit<(typeof native.files)[number], "change"> & {
        change: KodworkFileChange["change"];
        originalPath?: string;
      }> = native.files;
      if (native.kind === "git") {
        try {
          const root = roots.get(task.id) ?? task.folder;
          const status = parseStatusPorcelainV2(
            (await git.run(root, ["status", "--porcelain=v2", "-z"])).stdout,
          );
          for (const rename of status.items.filter(
            (entry) => entry.kind === "renamed" && entry.origPath,
          )) {
            const next = nativeFiles.find((file) => file.relativePath === rename.path);
            const before = nativeFiles.find(
              (file) => file.relativePath === rename.origPath,
            );
            if (!next || !before) continue;
            nativeFiles = nativeFiles
              .filter((file) => file !== before)
              .map((file) =>
                file === next
                  ? {
                      ...file,
                      change: "renamed" as const,
                      originalPath: before.relativePath,
                      before: before.before,
                      dels: before.dels,
                    }
                  : file,
              );
          }
        } catch {
          // The byte ledger remains authoritative when status is unavailable.
        }
      }
      const rankInput: NumstatEntry[] = nativeFiles.map((file) => ({
        oldPath: file.originalPath ?? null,
        newPath: file.relativePath,
        adds: file.adds,
        dels: file.dels,
        binary: file.binary,
        renamed: file.change === "renamed",
      }));
      const ranked = new Map(
        rankFiles(rankInput).map((file) => [file.path, file]),
      );
      const files = nativeFiles.map<KodworkFileChange>((file) => {
        const rank = ranked.get(file.relativePath);
        return {
          path: file.path,
          relativePath: file.relativePath,
          change: file.change,
          binary: file.binary,
          humanTouched: false,
          before: file.before,
          after: file.after,
          // Deletion is never demoted or hidden, whatever the access level.
          bucket: file.change === "deleted" ? "risky" : (rank?.bucket ?? "routine"),
          reasons:
            file.change === "deleted"
              ? ["file deletion", ...(rank?.reasons ?? [])]
              : (rank?.reasons ?? []),
        };
      });

      const diffs: FileDiff[] = [];
      if (native.kind === "git") {
        const root = roots.get(task.id) ?? task.folder;
        for (const file of files) {
          try {
            const output = await git.run(root, [
              "diff",
              "--no-color",
              "--",
              file.relativePath,
            ]);
            diffs.push(...parseUnifiedDiff(output.stdout).items);
          } catch {
            // The ledger remains reviewable as a stat/before-after row.
          }
        }
      }
      diffsByFingerprint.set(native.fingerprint, diffs);
      return {
        kind: native.kind,
        status: "pending",
        files,
        feedback: "",
        fingerprint: native.fingerprint,
      };
    },

    async accept(taskId) {
      await ipc.accept(taskId);
      roots.delete(taskId);
    },

    compileFeedback(review) {
      const feedback = review.feedback.trim() || "Correct the reviewed task output.";
      const diffs = review.fingerprint
        ? (diffsByFingerprint.get(review.fingerprint) ?? [])
        : [];
      if (diffs.length === 0) {
        return [
          "Address the following KödWork output review feedback.",
          "",
          feedback,
          "",
          `Changed files: ${review.files.map((file) => file.relativePath).join(", ")}`,
          "Keep changes scoped to this feedback and preserve the review gate.",
        ].join("\n");
      }
      const first = diffs[0];
      const path = first.newPath ?? first.oldPath ?? review.files[0]?.relativePath ?? "output";
      const comment: ReviewComment = {
        path,
        startLine: 1,
        endLine: Math.max(
          1,
          ...first.hunks.flatMap((hunk) =>
            hunk.lines.map((line) => line.newLine ?? line.oldLine ?? 1),
          ),
        ),
        body: feedback,
      };
      return compileFixPrompt([comment], diffs);
    },

    prepareRestore(task) {
      return {
        taskId: task.id,
        owner: { surface: "kodwork", scopeId: task.id },
        files: task.review.files,
      };
    },

    async applyRestore(plan) {
      try {
        await ipc.restore(plan.taskId);
        roots.delete(plan.taskId);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    // The native restore command already restores the pre-restore bytes when
    // verification fails. This method exists so the store's transaction shape
    // remains identical for real and injected test ledgers.
    async rollbackRestore() {},
  };
}
