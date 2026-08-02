// Turn native file-drop paths into one paste-ready shell argument list.
// Paths containing CONTROL characters are dropped entirely: quoting cannot
// contain them - the tty layer acts on bytes like ^C and newline before the
// shell parses quotes, so a malicious filename could interrupt the line and
// execute what follows. Legitimate filenames never contain them.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CMD_EXPANSION_CHARS = /[%!]/;

export type ShellPasteKind = "posix" | "powershell" | "cmd";

export function pasteKindForShell(shellBase: string): ShellPasteKind {
  const name = shellBase.toLowerCase().replace(/\.exe$/, "");
  if (name === "pwsh" || name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  return "posix";
}

export function shellEscapePaths(
  paths: string[],
  kind: ShellPasteKind = "posix",
): string {
  // cmd expands %NAME% and (when delayed expansion is enabled) !NAME! even in
  // double quotes. Dropping those rare paths is safer than pasting text whose
  // meaning depends on the user's cmd settings.
  const safe = paths.filter(
    (p) =>
      !CONTROL_CHARS.test(p) &&
      (kind !== "cmd" || !CMD_EXPANSION_CHARS.test(p)),
  );
  if (safe.length === 0) return "";
  const quote = (path: string) => {
    if (kind === "powershell") return `'${path.replace(/'/g, "''")}'`;
    if (kind === "cmd") return `"${path.replace(/"/g, '""')}"`;
    return `'${path.replace(/'/g, "'\\''")}'`;
  };
  return `${safe.map(quote).join(" ")} `;
}
