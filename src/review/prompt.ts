// Compiles a set of review comments into one plain-text fix prompt for the
// agent session that wrote the code. Comments never mutate files — this is
// the read-only handoff: quote the relevant diff excerpt so the agent has
// exact context, then hand off the comment text.

import type { FileDiff, ReviewComment } from "./model";

// Lines from `file`'s hunks whose line number falls in [startLine, endLine],
// rendered with their diff marker (+/-/space) so add/del context is legible.
function excerptFor(file: FileDiff, startLine: number, endLine: number): string {
  const rows: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const lineNo = line.newLine ?? line.oldLine;
      if (lineNo === null || lineNo < startLine || lineNo > endLine) continue;
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      rows.push(marker + line.content);
    }
  }
  return rows.join("\n");
}

export function compileFixPrompt(comments: ReviewComment[], files: FileDiff[]): string {
  const byPath = new Map<string, FileDiff>();
  for (const f of files) {
    const p = f.newPath ?? f.oldPath;
    if (p) byPath.set(p, f);
  }

  const sorted = [...comments].sort((a, b) =>
    a.path === b.path ? a.startLine - b.startLine : a.path.localeCompare(b.path),
  );

  const out: string[] = [
    "Address the following review comments. Each entry quotes the relevant diff excerpt for context.",
    "",
  ];

  for (const c of sorted) {
    const file = byPath.get(c.path);
    const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
    const excerpt = file ? excerptFor(file, c.startLine, c.endLine) : "";
    out.push(`## ${c.path}:${range}`);
    out.push("```diff");
    out.push(excerpt.length > 0 ? excerpt : "(no matching diff excerpt found)");
    out.push("```");
    out.push(c.body);
    out.push("");
  }

  out.push("Keep changes scoped to the comments above — do not make unrelated edits.");
  return out.join("\n");
}
