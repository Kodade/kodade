import { describe, expect, it } from "vitest";
import { approvalBanner } from "./approval";

describe("KödLocal CLI approval preview", () => {
  it("renders path and content ESC/OSC payloads as inert visible text", () => {
    const path = `bad\u001b]0;spoofed\u0007\u009b31m.txt`;
    const content = `approve?\n\u001b[2J\u001b]8;;https://evil.invalid\u0007click\u001b]8;;\u0007`;
    const output = approvalBanner(`write_file ${path}\n+ ${content}`);
    const preview = output.split("\n").slice(2, -1).join("\n");

    expect(preview).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(preview).toContain("bad\\x1b]0;spoofed\\x07\\x9b31m.txt");
    expect(preview).toContain("approve?\\n\\x1b[2J");
    expect(preview).toContain("\\x1b]8;;https://evil.invalid\\x07");
  });
});
