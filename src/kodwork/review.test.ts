import { describe, expect, it, vi } from "vitest";
import { MockAgentIpc, MockStorage } from "../ipc/mock";
import type { MemoryWorkspace, NewCheckpoint } from "../ipc/contract";
import { createKodworkStore } from "./store";
import type { KodworkLedger, KodworkReview } from "./ledger";

function review(kind: "git" | "folder" = "git"): KodworkReview {
  return {
    kind,
    status: "pending",
    files: [
      {
        path: "/repo/report.md",
        relativePath: "report.md",
        change: "modified",
        binary: false,
        humanTouched: false,
        before: kind === "folder" ? "old" : null,
        after: kind === "folder" ? "new" : null,
        bucket: "routine",
        reasons: [],
      },
      {
        path: "/repo/obsolete.md",
        relativePath: "obsolete.md",
        change: "deleted",
        binary: false,
        humanTouched: false,
        before: kind === "folder" ? "remove me" : null,
        after: null,
        bucket: "risky",
        reasons: ["deletion"],
      },
    ],
    feedback: "",
    fingerprint: "fingerprint-1",
  };
}

function setup(kind: "git" | "folder" = "git") {
  const agent = new MockAgentIpc();
  const storage = new MockStorage();
  const checkpoints: NewCheckpoint[] = [];
  const ledger: KodworkLedger = {
    begin: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(review(kind)),
    accept: vi.fn().mockResolvedValue(undefined),
    compileFeedback: vi.fn().mockResolvedValue("compiled review feedback"),
    prepareRestore: vi.fn(),
    applyRestore: vi.fn(),
    rollbackRestore: vi.fn(),
  };
  const store = createKodworkStore({
    agent,
    storage,
    ledger,
    enabled: () => true,
    projectRoot: () => "/repo",
    memory: {
      resolveWorkspace: async () => ({ id: "ws-1" }) as MemoryWorkspace,
      checkpoint: async (input) => {
        checkpoints.push(input);
        return { id: "cp-1" } as never;
      },
    },
    now: () => 1_000,
  });
  return { agent, ledger, checkpoints, store };
}

async function runToReview(ctx: ReturnType<typeof setup>) {
  await ctx.store.getState().start();
  await ctx.store.getState().openTask("task-1", "project-1");
  ctx.store.getState().setOutcome("task-1", "prepare a report");
  await ctx.store.getState().startTask("task-1");
  ctx.agent.emit(
    "task-1#1",
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "11111111-2222-3333-4444-555555555555",
    }),
  );
  ctx.agent.exit("task-1#1", 0);
  await vi.waitFor(() =>
    expect(ctx.store.getState().tasks["task-1"].review.status).toBe("pending"),
  );
}

describe("KödWork output review gate", () => {
  it("collects a run-scoped ledger and stops at needs-user before checkpointing", async () => {
    const ctx = setup();
    await runToReview(ctx);

    expect(ctx.ledger.begin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1", folder: "/repo" }),
    );
    expect(ctx.ledger.finish).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
    );
    expect(ctx.store.getState().tasks["task-1"]).toMatchObject({
      state: "needs-user",
      review: { status: "pending", kind: "git" },
    });
    expect(ctx.checkpoints).toEqual([]);
  });

  it("holds files from a failed run behind review without rewriting the failure as success", async () => {
    const ctx = setup();
    await ctx.store.getState().start();
    await ctx.store.getState().openTask("task-1", "project-1");
    ctx.store.getState().setOutcome("task-1", "prepare a report");
    await ctx.store.getState().startTask("task-1");
    ctx.agent.exit("task-1#1", 1, "agent crashed after writing");
    await vi.waitFor(() =>
      expect(ctx.store.getState().tasks["task-1"].review.status).toBe("pending"),
    );

    expect(ctx.store.getState().tasks["task-1"]).toMatchObject({
      state: "needs-user",
      reviewOutcomeState: "failed",
    });
    await ctx.store.getState().acceptReview("task-1");
    expect(ctx.store.getState().tasks["task-1"].state).toBe("failed");
    expect(ctx.checkpoints).toEqual([]);
  });

  it("accepts reviewed files, then finalizes the KödMem checkpoint with changed paths", async () => {
    const ctx = setup();
    await runToReview(ctx);
    await ctx.store.getState().acceptReview("task-1");
    await vi.waitFor(() => expect(ctx.checkpoints).toHaveLength(1));

    expect(ctx.ledger.accept).toHaveBeenCalledWith("task-1");
    expect(ctx.store.getState().tasks["task-1"]).toMatchObject({
      state: "done",
      review: { status: "accepted", files: [] },
    });
    expect(ctx.checkpoints[0].changedPaths).toEqual(["report.md", "obsolete.md"]);
  });

  it("rejects with compiled feedback by resuming the same CLI session", async () => {
    const ctx = setup();
    await runToReview(ctx);
    ctx.store.getState().setReviewFeedback("task-1", "The totals are wrong");
    await ctx.store.getState().rejectReview("task-1");

    expect(ctx.ledger.compileFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ feedback: "The totals are wrong" }),
    );
    expect(ctx.agent.starts[1]).toMatchObject({ id: "task-1#2" });
    expect(ctx.agent.sends[1]?.data).toContain("compiled review feedback");
    expect(ctx.agent.starts[1].args.join(" ")).toContain(
      "--resume 11111111-2222-3333-4444-555555555555",
    );
  });

  it("keeps non-git before/after text and deletions in the review", async () => {
    const ctx = setup("folder");
    await runToReview(ctx);

    const files = ctx.store.getState().tasks["task-1"].review.files;
    expect(files[0]).toMatchObject({ before: "old", after: "new" });
    expect(files).toEqual(
      expect.arrayContaining([expect.objectContaining({ change: "deleted" })]),
    );
  });

  it("rolls a failed restore back and reports the verified failure", async () => {
    const ctx = setup("folder");
    await runToReview(ctx);
    const plan = {
      taskId: "task-1",
      owner: { surface: "kodwork" as const, scopeId: "task-1" },
      files: review("folder").files,
    };
    vi.mocked(ctx.ledger.prepareRestore).mockResolvedValue(plan);
    vi.mocked(ctx.ledger.applyRestore).mockResolvedValue({ ok: false, reason: "hash mismatch" });
    await ctx.store.getState().prepareRestore("task-1");
    await ctx.store.getState().confirmRestore("task-1");

    expect(ctx.ledger.rollbackRestore).toHaveBeenCalledWith(plan);
    expect(ctx.store.getState().tasks["task-1"]).toMatchObject({
      review: { status: "restore-failed" },
      error: expect.stringContaining("hash mismatch"),
    });
  });

  it("stops a third reject when the output fingerprint is unchanged", async () => {
    const ctx = setup();
    await runToReview(ctx);
    await ctx.store.getState().rejectReview("task-1");
    ctx.agent.exit("task-1#2", 0);
    await vi.waitFor(() => expect(ctx.store.getState().tasks["task-1"].review.status).toBe("pending"));
    await ctx.store.getState().rejectReview("task-1");
    ctx.agent.exit("task-1#3", 0);
    await vi.waitFor(() => expect(ctx.store.getState().tasks["task-1"].review.status).toBe("pending"));
    await ctx.store.getState().rejectReview("task-1");

    expect(ctx.agent.starts).toHaveLength(3);
    expect(ctx.store.getState().tasks["task-1"]).toMatchObject({
      state: "needs-user",
      doomLoop: true,
      error: expect.stringContaining("same output three times"),
    });
  });

  it("blocks a checkpoint when even changed-path metadata resembles a secret", async () => {
    const ctx = setup();
    vi.mocked(ctx.ledger.finish).mockResolvedValue({
      ...review(),
      files: [{
        ...review().files[0]!,
        path: "/repo/api_key=abcdefghijklmnop.md",
        relativePath: "api_key=abcdefghijklmnop.md",
      }],
    });
    await runToReview(ctx);
    await ctx.store.getState().acceptReview("task-1");
    expect(ctx.checkpoints).toEqual([]);
  });
});
