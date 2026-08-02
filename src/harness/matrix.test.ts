// Pure projection tests: the matrix groups artifacts sharing one (kind, path)
// across CLIs into a single row, and falls back to per-artifact rows when
// paths differ — no React, no store, just plain data in and out.

import { describe, expect, it } from "vitest";
import type { HarnessArtifact } from "./model";
import { projectMatrix } from "./matrix";

function artifact(overrides: Partial<HarnessArtifact> = {}): HarnessArtifact {
  return {
    id: `${overrides.cli ?? "claude"}:project:instruction:AGENTS.md`,
    cli: "claude",
    scope: "project",
    kind: "instruction",
    name: "AGENTS.md",
    path: "/repo/AGENTS.md",
    source: { via: "file" },
    enabled: true,
    status: "ok",
    ...overrides,
  };
}

describe("projectMatrix", () => {
  it("merges artifacts from different CLIs sharing the same (kind, path) into one row", () => {
    const codexAgents = artifact({ cli: "codex" });
    const opencodeAgents = artifact({ cli: "opencode" });
    const rows = projectMatrix([codexAgents, opencodeAgents], ["codex", "opencode"]);

    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("/repo/AGENTS.md");
    expect(rows[0].cells.codex).toBe(codexAgents);
    expect(rows[0].cells.opencode).toBe(opencodeAgents);
  });

  it("falls back to one row per artifact when paths differ", () => {
    const claudeMd = artifact({ cli: "claude", path: "/repo/CLAUDE.md", name: "CLAUDE.md" });
    const agentsMd = artifact({ cli: "codex", path: "/repo/AGENTS.md" });
    const rows = projectMatrix([claudeMd, agentsMd], ["claude", "codex"]);

    expect(rows).toHaveLength(2);
    expect(rows[0].cells).toEqual({ claude: claudeMd });
    expect(rows[1].cells).toEqual({ codex: agentsMd });
  });

  it("excludes CLIs outside the given column roster (free-tier single column)", () => {
    const claudeMd = artifact({ cli: "claude" });
    const codexMd = artifact({ cli: "codex", path: "/repo/AGENTS.md" });
    const rows = projectMatrix([claudeMd, codexMd], ["claude"]);

    expect(rows).toHaveLength(1);
    expect(rows[0].cells).toEqual({ claude: claudeMd });
  });

  it("keeps first-seen order across rows and picks the first-seen artifact as representative", () => {
    const first = artifact({ cli: "codex", path: "/repo/AGENTS.md" });
    const second = artifact({ cli: "opencode", path: "/repo/AGENTS.md" });
    const other = artifact({ cli: "claude", path: "/repo/CLAUDE.md", name: "CLAUDE.md" });
    const rows = projectMatrix([other, first, second], ["claude", "codex", "opencode"]);

    expect(rows.map((r) => r.path)).toEqual(["/repo/CLAUDE.md", "/repo/AGENTS.md"]);
    expect(rows[1].representative).toBe(first);
  });

  it("different kinds at the same path never merge", () => {
    const instruction = artifact({ cli: "claude", kind: "instruction", path: "/repo/x" });
    const skill = artifact({ cli: "codex", kind: "skill", path: "/repo/x" });
    const rows = projectMatrix([instruction, skill], ["claude", "codex"]);
    expect(rows).toHaveLength(2);
  });

  it("merges skill aliases that resolve to the same canonical symlink target", () => {
    const claude = artifact({
      cli: "claude",
      kind: "skill",
      name: "code-review",
      path: "/home/.claude/skills/code-review",
      source: { via: "symlink", target: "/dotfiles/skills/code-review" },
    });
    const codex = artifact({
      cli: "codex",
      kind: "skill",
      name: "code-review",
      path: "/home/.agents/skills/code-review",
      source: { via: "symlink", target: "/dotfiles/skills/code-review" },
    });

    const rows = projectMatrix([claude, codex], ["claude", "codex"]);

    expect(rows).toHaveLength(1);
    expect(rows[0].paths).toEqual([
      "/home/.claude/skills/code-review",
      "/home/.agents/skills/code-review",
    ]);
    expect(rows[0].cells).toEqual({ claude, codex });
  });

  it("merges managed copies with the same canonical group id", () => {
    const claude = artifact({
      cli: "claude",
      kind: "skill",
      name: "review",
      path: "/repo/.claude/skills/review",
      source: { via: "dir" },
      canonicalGroupId: "project-skill:review:abc123",
    });
    const codex = artifact({
      cli: "codex",
      kind: "skill",
      name: "review",
      path: "/repo/.agents/skills/review",
      source: { via: "dir" },
      canonicalGroupId: "project-skill:review:abc123",
    });

    expect(projectMatrix([claude, codex], ["claude", "codex"])).toHaveLength(1);
  });

  it("keeps same-named skills separate when their sources differ", () => {
    const claude = artifact({
      cli: "claude",
      kind: "skill",
      name: "review",
      path: "/home/.claude/skills/review",
      source: { via: "symlink", target: "/dotfiles/one/review" },
    });
    const codex = artifact({
      cli: "codex",
      kind: "skill",
      name: "review",
      path: "/home/.agents/skills/review",
      source: { via: "symlink", target: "/dotfiles/two/review" },
    });

    expect(projectMatrix([claude, codex], ["claude", "codex"])).toHaveLength(2);
  });

  it("never groups orphaned symlinks by an unresolved target string", () => {
    const claude = artifact({
      cli: "claude",
      kind: "skill",
      name: "review",
      path: "/one/.claude/skills/review",
      source: { via: "symlink", target: "../missing/review" },
      status: "orphaned-symlink",
    });
    const codex = artifact({
      cli: "codex",
      kind: "skill",
      name: "review",
      path: "/two/.agents/skills/review",
      source: { via: "symlink", target: "../missing/review" },
      status: "orphaned-symlink",
    });

    expect(projectMatrix([claude, codex], ["claude", "codex"])).toHaveLength(2);
  });
});
