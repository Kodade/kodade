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
2. Treat the STATE source and recent Worklog returned by KödMCP as the current
   handoff. For a mapped project, retain the STATE source's \`sha256\` before an
   explicit state-updating checkpoint.

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

For a mapped project, pass the retained STATE \`sha256\` as
\`expectedStateHash\`. If KödMCP returns \`content_conflict\`, refresh with
\`get_context\`, review the human edit, and retry intentionally with the new
hash. Append-only offload, session-exit, and Git-observation fallbacks must set
\`updateState: false\`; they belong in Worklog and must never overwrite STATE.

Ködade also records a minimal fallback when a connected session exits or a Git
commit is observed. Your explicit checkpoint should be more useful than that
fallback without inventing work that did not happen.
`;

export const KODMEM_LOG_WORK_SKILL: ProjectSkillSourceBundle = {
  root: "kodade://bundled/kodmem-log-work",
  files: [{ path: "SKILL.md", contents: SKILL }],
};
