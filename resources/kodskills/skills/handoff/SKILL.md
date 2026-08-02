---
name: handoff
description: "The handoff skill captures the current session in a concise file so a fresh agent can continue without replaying the conversation. Use it when pausing work, switching sessions, or pairing with `/prototype` or `/kodmap`."
disable-model-invocation: true
---

# Handoff

Write a compact continuation note for the next session. Save it in the user's operating-system temporary directory, not in the current workspace.

Include:

- the current objective and what has been completed;
- the exact next step and any blockers;
- decisions, constraints, assumptions, and unresolved questions;
- pointers to existing specs, plans, ADRs, issues, commits, diffs, files, or URLs instead of copying their contents;
- commands or verification results the next agent needs;
- a `suggested skills` section naming the skills that should be considered next.

Keep the note focused on continuation. Do not duplicate durable information already recorded in project artifacts. Redact credentials, secrets, and personally identifying information.

If the user supplied an argument, treat it as the next session's focus and shape the handoff around that work. For a prototype or a multi-session map, preserve the pointer that lets the next agent find the experiment or map quickly.
