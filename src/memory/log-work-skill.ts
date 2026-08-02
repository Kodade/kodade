import type { ProjectSkillSourceBundle } from "../ipc/contract";

const SKILL = `---
name: kodmem-log-work
description: Keep project working memory current at session starts, durable decisions, commits, and handoffs.
---

# KödMem log work

Use this skill when a project exposes the KödMCP tools \`get_context\`,
\`remember\`, and \`checkpoint\`.

## Start

1. Call \`get_context\` before changing the project.
2. Treat \`.kodade/memory/STATE.md\` and the recent worklog returned by KödMCP
   as the current handoff. Resolve conflicts in favor of the readable files.

## During work

- Use \`remember\` only for durable decisions, facts, tasks, or preferences that
  should outlive the current handoff.
- Never store credentials, tokens, private keys, authorization headers, or other
  secrets in KödMem.
- Do not create a Git commit unless the user or repository workflow asks for one.

## Checkpoint

Call \`checkpoint\` at a natural handoff, before an authorized commit, and before
ending a substantive session. Include a concise summary, decisions, next actions,
and workspace-relative changed paths. Use a stable idempotency key when retrying
the same handoff.

Ködade also records a minimal fallback when a connected session exits or a Git
commit is observed. Your explicit checkpoint should be more useful than that
fallback without inventing work that did not happen.
`;

export const KODMEM_LOG_WORK_SKILL: ProjectSkillSourceBundle = {
  root: "kodade://bundled/kodmem-log-work",
  files: [{ path: "SKILL.md", contents: SKILL }],
};
