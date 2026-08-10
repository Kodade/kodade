---
name: kodmem-project
description: Load and maintain project-scoped KödMem context at session start, during durable research or decisions, and before a substantive handoff.
metadata:
  contract: kodmem-project
  contract-version: 1
---

# KödMem project workflow

Use only the KödMCP tools exposed in the current session. Never infer or select
another project.

## Start

1. Call `get_context` for the current workspace before planning.
2. Confirm the returned logical project matches the current workspace.
3. Treat repository files and the issue tracker as implementation truth. Treat
   KödMem as durable project context.
4. Retain the hash of the returned `state` source for a state-changing
   checkpoint.

## Search and remember

- Use `search_memories` before asking the user to repeat prior project facts.
  Verify consequential results against current repository truth.
- Use `remember` only for durable decisions, facts, tasks, preferences, or
  concise outcomes. Use a stable idempotency key when retrying.
- Use optimistic version and content checks when revising or deleting a memory.
- Never store credentials, authentication material, raw transcripts, transient
  logs, or content already clear in the repository.

## Checkpoint

At a substantive handoff:

1. Refresh with `get_context`.
2. Summarize verified outcomes, decisions and reasons, cold-startable next
   actions, and workspace-relative changed paths.
3. If `checkpoint` is available, pass a stable idempotency key. When updating
   current state, also pass the refreshed state source hash as
   `expectedStateHash`.
4. If state changed concurrently, reload, reconcile, and submit a new
   intentional checkpoint. Never overwrite a concurrent edit.
5. Verify the returned checkpoint or refreshed context.

If write tools are not available, report that the connection is read-only and
do not invent another persistence channel.
