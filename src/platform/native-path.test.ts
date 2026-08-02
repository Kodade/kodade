import { describe, expect, it } from "vitest";
import {
  nativeBasename,
  nativeDirname,
  nativeEquals,
  nativeIsDescendant,
  nativeJoin,
  nativeRelativePath,
  normalizeNativeAbsolutePath,
  remapNativePath,
  validateNativeName,
} from "./native-path";

describe("native Windows paths", () => {
  it("normalizes drive, UNC, and verbatim paths without losing their roots", () => {
    expect(normalizeNativeAbsolutePath("C:\\work\\.\\kodade\\..\\app\\")).toBe(
      "C:\\work\\app",
    );
    expect(normalizeNativeAbsolutePath("\\\\server\\share\\team\\..\\repo\\")).toBe(
      "\\\\server\\share\\repo",
    );
    expect(normalizeNativeAbsolutePath("\\\\?\\C:\\long\\repo\\..\\app")).toBe(
      "\\\\?\\C:\\long\\repo\\..\\app",
    );
    expect(normalizeNativeAbsolutePath("\\\\?\\UNC\\server\\share\\repo")).toBe(
      "\\\\?\\UNC\\server\\share\\repo",
    );
  });

  it("compares and confines Windows paths case-insensitively by component", () => {
    expect(nativeEquals("C:\\Work\\Repo", "c:\\work\\repo\\")).toBe(true);
    expect(nativeEquals("C:\\CAFÉ\\Repo", "c:\\café\\repo")).toBe(true);
    expect(nativeIsDescendant("C:\\WORK\\Repo\\src\\app.ts", "c:\\work\\repo")).toBe(true);
    expect(nativeIsDescendant("C:\\work\\repository\\x", "C:\\work\\repo")).toBe(false);
    expect(nativeIsDescendant("\\\\SERVER\\Share\\repo\\x", "\\\\server\\share\\repo")).toBe(
      true,
    );
    expect(nativeEquals("C:\\Work\\Repo", "\\\\?\\c:\\work\\repo")).toBe(true);
    expect(nativeEquals("\\\\server\\share\\repo", "\\\\?\\UNC\\SERVER\\SHARE\\repo")).toBe(
      true,
    );
    expect(nativeIsDescendant("\\\\?\\C:\\work\\repo\\src\\app.ts", "c:\\WORK\\repo")).toBe(
      true,
    );
    expect(nativeEquals("C:\\app", "\\\\?\\C:\\work\\..\\app")).toBe(false);
  });

  it("extracts, joins, and remaps native components", () => {
    expect(nativeBasename("C:\\work\\repo\\app.ts")).toBe("app.ts");
    expect(nativeDirname("C:\\work\\repo\\app.ts")).toBe("C:\\work\\repo");
    expect(nativeDirname("C:\\")).toBeNull();
    expect(nativeJoin("C:\\work\\repo", "src")).toBe("C:\\work\\repo\\src");
    expect(remapNativePath("C:\\WORK\\repo\\src\\a.ts", "c:\\work\\repo", "D:\\code")).toBe(
      "D:\\code\\src\\a.ts",
    );
    expect(nativeRelativePath("C:\\WORK\\Repo\\Src\\App.ts", "c:\\work\\repo")).toBe(
      "Src\\App.ts",
    );
  });

  it("rejects Windows-reserved and lossy entry names", () => {
    for (const name of [
      "CON",
      "con.txt",
      "LPT9.log",
      "COM¹",
      "com².txt",
      "LPT³.log",
      "bad.",
      "bad ",
      "a:b",
      "a\\b",
      "a/b",
    ]) {
      expect(validateNativeName(name, "C:\\work")).not.toBeNull();
    }
    expect(validateNativeName("Café 🚀.txt", "C:\\work")).toBeNull();
    expect(validateNativeName("notes. ", "/work")).toBeNull();
  });
});

describe("native Unix paths", () => {
  it("keeps existing absolute, case-sensitive semantics", () => {
    expect(normalizeNativeAbsolutePath("/work/./repo/../app/")).toBe("/work/app");
    expect(nativeEquals("/Work", "/work")).toBe(false);
    expect(nativeIsDescendant("/work/repo/a.ts", "/work/repo")).toBe(true);
    expect(nativeIsDescendant("/work/repository/a.ts", "/work/repo")).toBe(false);
    expect(nativeJoin("/", "tmp")).toBe("/tmp");
  });

  it("rejects relative paths at the persistence boundary", () => {
    expect(normalizeNativeAbsolutePath("repo/a.ts")).toBe("");
    expect(normalizeNativeAbsolutePath("C:relative\\a.ts")).toBe("");
  });
});
