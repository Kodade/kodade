---
name: ship
description: "The ship skill runs the end-of-work gate before a change is called complete: it executes the full project checks, verifies push and merge access, integrates parallel work in order, and confirms the final Git state. Use it when the user says “ship”, “ship it”, or “land this”, or when closing a multi-branch effort."
disable-model-invocation: true
---

# Ship

This is the final proof gate. Do not report the work as complete until the integrated result passes every applicable step below. Use it for a single branch as well as parallel worktree work.

## Steps

1. **Run the full gate suite.** Read the project's agent instructions, package scripts, and CI configuration. Run the defined tests, lint, type checks, builds, and other release gates against the final integrated state. If a gate fails, fix it or report the failure; do not merge over red checks.
2. **Confirm access before merging.** Verify the remote is reachable and that authentication permits the required push and merge operations before beginning integration—for example, with `git ls-remote` and the hosting CLI's auth check. If access is missing, stop and ask for the needed decision or access in one batched request.
3. **Integrate parallel work in declared order.** Merge the worktree branches in the declared integration order. Resolve conflicts deliberately, rerun the full gate suite after the last merge, then remove merged worktrees and delete merged branches when the repository's workflow allows it.
4. **Verify the final Git state.** Check `git status`, merged branches, the target branch's relationship to its remote, and the commit log. Confirm the intended work is on the target branch, pushed, clean, and not stranded in an orphaned worktree or unpushed commit.
5. **Update durable project memory when applicable.** If the project keeps a worklog or agent-memory system, update it with the shipped state and any useful follow-up before reporting completion.

## Rules

- Worker or agent claims are hints, not proof; this checklist is the proof.
- Report failed gates, rejected pushes, unresolved conflicts, and skipped steps plainly with the relevant output.
- Never imply that work shipped when the final integrated checks or remote state are unverified.
