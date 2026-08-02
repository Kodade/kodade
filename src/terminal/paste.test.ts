import { describe, expect, it } from "vitest";
import { pasteKindForShell, shellEscapePaths } from "./paste";

describe("terminal path paste", () => {
  it("preserves POSIX quoting and a trailing paste separator", () => {
    expect(shellEscapePaths(["/tmp/plain"])).toBe("'/tmp/plain' ");
    expect(shellEscapePaths(['/tmp/a file "final".txt'])).toBe(
      "'/tmp/a file \"final\".txt' ",
    );
    expect(shellEscapePaths(["/tmp/Keith's file.txt"])).toBe(
      "'/tmp/Keith'\\''s file.txt' ",
    );
    expect(shellEscapePaths(["/tmp/one", "/tmp/two files"])).toBe(
      "'/tmp/one' '/tmp/two files' ",
    );
  });

  it("quotes Windows paths for PowerShell and cmd", () => {
    expect(shellEscapePaths(["C:\\Keith's\\设计 🚀"], "powershell")).toBe(
      "'C:\\Keith''s\\设计 🚀' ",
    );
    expect(shellEscapePaths(["C:\\Keith & Team\\设计 🚀"], "cmd")).toBe(
      '"C:\\Keith & Team\\设计 🚀" ',
    );
    expect(shellEscapePaths(["C:\\%TEMP%\\unsafe"], "cmd")).toBe("");
    expect(shellEscapePaths(["C:\\!delayed!\\unsafe"], "cmd")).toBe("");
  });

  it("maps integrated shell names to their quoting rules", () => {
    expect(pasteKindForShell("zsh")).toBe("posix");
    expect(pasteKindForShell("pwsh.exe")).toBe("powershell");
    expect(pasteKindForShell("PowerShell")).toBe("powershell");
    expect(pasteKindForShell("CMD.EXE")).toBe("cmd");
  });

  it("keeps control characters out of every shell", () => {
    expect(shellEscapePaths(["safe", "bad\ncommand"], "powershell")).toBe(
      "'safe' ",
    );
    expect(shellEscapePaths(["bad\rcommand"], "cmd")).toBe("");
    expect(shellEscapePaths(["/tmp/evil\u0003rm -rf ~\n"])).toBe("");
  });
});
