import { describe, expect, it } from "vitest";
import { MockGit, MockKodworkIpc } from "../ipc/mock";
import { newTask } from "./model";
import { createKodworkLedger } from "./ledger";

describe("KödWork ledger", () => {
  it("reuses porcelain-v2 status to present a git rename as one change", async () => {
    const ipc = new MockKodworkIpc();
    const git = new MockGit();
    ipc.reviews.set("task-1", {
      kind: "git",
      fingerprint: "rename",
      files: [
        {
          path: "/repo/oldname.txt",
          relativePath: "oldname.txt",
          change: "deleted",
          binary: false,
          before: "before",
          after: null,
          adds: 0,
          dels: 1,
        },
        {
          path: "/repo/newname.txt",
          relativePath: "newname.txt",
          change: "added",
          binary: false,
          before: null,
          after: "after",
          adds: 1,
          dels: 0,
        },
      ],
    });
    git.responses.set("status", {
      stdout:
        "2 R. N... 100644 100644 100644 b15cc4741f8c3b17a900231c4d4398f0cb28be72 1707b561e5dc833c59672d74e97b4d3aa28c3692 R100 newname.txt\0oldname.txt\0",
      stderr: "",
    });
    const task = {
      ...newTask("task-1", "project-1", "/repo", "claude", 1),
      outcome: "rename the file",
    };
    const ledger = createKodworkLedger({ ipc, git });

    await ledger.begin(task);
    const result = await ledger.finish(task);

    expect(result.files).toEqual([
      expect.objectContaining({
        relativePath: "newname.txt",
        change: "renamed",
        before: "before",
        after: "after",
      }),
    ]);
    expect(git.calls[0]).toEqual(["status", "--porcelain=v2", "-z"]);
  });
});
