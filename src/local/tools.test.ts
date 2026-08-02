import { describe, expect, it, vi } from "vitest";
import { initialDegradationState, nextDegradationStep, parseToolCall } from "./toolcall";
import {
  executeToolDecision,
  LOCAL_AGENT_TOOLS,
  toolSystemPrompt,
  type ToolExecutionPolicy,
} from "./tools";

const POLICY: ToolExecutionPolicy = {
  entitled: true,
  enabled: true,
  confirmEveryCall: false,
  autoApproveWrite: false,
};

function decision(tool: string, args: Record<string, unknown>) {
  const parsed = parseToolCall(JSON.stringify({ tool, args }), LOCAL_AGENT_TOOLS);
  if (!parsed.valid) throw new Error(parsed.reason);
  const next = nextDegradationStep(initialDegradationState("constrained"), parsed);
  if (next.action !== "execute") throw new Error("validated call was not executable");
  return next;
}

describe("KödLocal v1 tools", () => {
  it("exposes only the fixed safe set and documents that there is no shell", () => {
    expect(LOCAL_AGENT_TOOLS.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_dir",
      "write_file",
      "git",
      "gh",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_fill",
      "browser_press",
      "answer",
    ]);
    expect(toolSystemPrompt()).toContain("No arbitrary shell tool exists");
    expect(toolSystemPrompt()).toContain("Never silently switch to Chrome");
  });

  it("routes a validator decision to the real dispatch command with an absolute confined candidate", async () => {
    const call = vi.fn().mockResolvedValue({ kind: "text", content: "hello" });
    const outcome = await executeToolDecision(decision("read_file", { path: "docs/a.md" }), {
      projectRoot: "/repo",
      policy: POLICY,
      confirm: vi.fn(),
      host: { call },
    });
    expect(call).toHaveBeenCalledWith("fs_read_file", { path: "/repo/docs/a.md" });
    expect(outcome).toMatchObject({ status: "executed", result: "hello" });
  });

  it("rejects absolute schema paths before the Rust boundary", async () => {
    const call = vi.fn();
    const outcome = await executeToolDecision(decision("read_file", { path: "/etc/passwd" }), {
      projectRoot: "/repo",
      policy: POLICY,
      confirm: vi.fn(),
      host: { call },
    });
    expect(call).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "error" });
  });

  it("leaves relative traversal for the real Rust confinement boundary", async () => {
    const call = vi.fn().mockRejectedValue(new Error("path is outside the project root"));
    const outcome = await executeToolDecision(
      decision("write_file", { path: "../outside.txt", content: "nope" }),
      {
        projectRoot: "/repo",
        policy: { ...POLICY, autoApproveWrite: true },
        confirm: vi.fn(),
        host: { call },
      },
    );
    expect(call).toHaveBeenCalledWith("fs_write_file", {
      path: "/outside.txt",
      contents: "nope",
    });
    expect(outcome).toEqual({ status: "error", result: "path is outside the project root" });
  });

  it("defaults writes to y/N confirmation and yolo skips only that prompt", async () => {
    const host = { call: vi.fn().mockResolvedValue(null) };
    const confirm = vi.fn().mockResolvedValue(false);
    const write = decision("write_file", { path: "notes.txt", content: "one\ntwo\nthree" });

    const denied = await executeToolDecision(write, {
      projectRoot: "/repo",
      policy: POLICY,
      confirm,
      host,
    });
    expect(confirm.mock.calls[0][0]).toContain("notes.txt");
    expect(confirm.mock.calls[0][0]).toContain("13 bytes");
    expect(denied.status).toBe("denied");
    expect(host.call).not.toHaveBeenCalled();

    await executeToolDecision(write, {
      projectRoot: "/repo",
      policy: { ...POLICY, autoApproveWrite: true },
      confirm,
      host,
    });
    expect(host.call).toHaveBeenCalledWith("fs_write_file", {
      path: "/repo/notes.txt",
      contents: "one\ntwo\nthree",
    });
  });

  it("returns headless writes as suggested artifacts without prompting or executing", async () => {
    const host = { call: vi.fn() };
    const confirm = vi.fn();
    const outcome = await executeToolDecision(
      decision("write_file", { path: "notes.txt", content: "frontier applies this" }),
      {
        projectRoot: "/repo",
        policy: { ...POLICY, suggestWrites: true },
        confirm,
        host,
      },
    );

    expect(outcome).toMatchObject({
      status: "suggested",
      result: expect.stringContaining("TOOL NOT EXECUTED"),
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(host.call).not.toHaveBeenCalled();
  });

  it("executes weak-model reads only after per-call approval and skips declined calls", async () => {
    const host = { call: vi.fn().mockResolvedValue([]) };
    const confirm = vi.fn().mockResolvedValue(true);
    const approved = await executeToolDecision(decision("list_dir", { path: "." }), {
      projectRoot: "/repo",
      policy: { ...POLICY, confirmEveryCall: true },
      confirm,
      host,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(host.call).toHaveBeenCalledOnce();
    expect(approved.status).toBe("executed");

    host.call.mockClear();
    confirm.mockResolvedValueOnce(false);
    const declined = await executeToolDecision(decision("read_file", { path: "README.md" }), {
      projectRoot: "/repo",
      policy: { ...POLICY, confirmEveryCall: true },
      confirm,
      host,
    });
    expect(declined.status).toBe("denied");
    expect(host.call).not.toHaveBeenCalled();
  });

  it("never executes unentitled tools even when confirmation would approve", async () => {
    const host = { call: vi.fn().mockResolvedValue([]) };
    const confirm = vi.fn().mockResolvedValue(true);
    const suggested = await executeToolDecision(decision("list_dir", { path: "." }), {
      projectRoot: "/repo",
      policy: { ...POLICY, entitled: false },
      confirm,
      host,
    });
    expect(suggested.status).toBe("suggested");
    expect(host.call).not.toHaveBeenCalled();
  });

  it("routes the internal browser even when project filesystem tools are unentitled", async () => {
    const call = vi.fn().mockResolvedValue({ title: "Kodade" });
    const outcome = await executeToolDecision(decision("browser_snapshot", {}), {
      projectRoot: "/repo",
      policy: {
        ...POLICY,
        entitled: false,
        alwaysAllowedTools: ["browser_snapshot"],
      },
      confirm: vi.fn(),
      host: { call },
    });

    expect(call).toHaveBeenCalledWith("browser_agent_command", {
      action: "snapshot",
    });
    expect(outcome).toMatchObject({
      status: "executed",
      result: expect.stringContaining("Kodade"),
    });
  });

  it("escapes ANSI, OSC, C0, C1, and newlines in model-controlled write previews", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const path = `notes\u001b]0;fake title\u0007\u009b31m.txt`;
    const content = `first\nsecond\u001b[2J\u001b]8;;https://evil.invalid\u0007link\u001b]8;;\u0007`;

    await executeToolDecision(decision("write_file", { path, content }), {
      projectRoot: "/repo",
      policy: POLICY,
      confirm,
      host: { call: vi.fn() },
    });

    const preview = String(confirm.mock.calls[0][0]);
    expect(preview).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(preview).toContain("\\x1b]0;fake title\\x07\\x9b31m.txt");
    expect(preview).toContain("first\\n+ second\\x1b[2J");
    expect(preview).toContain("\\x1b]8;;https://evil.invalid\\x07");
  });

  it("caps large native output before it enters model context", async () => {
    const outcome = await executeToolDecision(decision("git", { args: ["status"] }), {
      projectRoot: "/repo",
      policy: POLICY,
      confirm: vi.fn(),
      host: {
        call: vi.fn().mockResolvedValue({ stdout: "x".repeat(10_000), stderr: "" }),
      },
    });
    expect(outcome.result.length).toBeLessThan(2_000);
    expect(outcome.result).toContain("tool result truncated");
  });
});
