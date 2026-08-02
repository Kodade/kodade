---
name: merge-conflicts
description: Resolve an in-progress Git merge or rebase conflict without losing either change's intent. Use when Git reports unresolved conflict markers during a merge or rebase.
---

# Merge Conflicts

Resolve the conflict in front of you. Do not abort the merge or rebase.

## Read the situation

Start with the repository state, history, and unresolved files. Use `git
status`, inspect the conflict hunks, and identify whether Git is merging or
rebasing.

## Recover both intents

For each conflicted hunk, trace both sides to their primary sources: commits,
commit messages, pull requests, and the issue or ticket that motivated them.
Understand what each change was meant to preserve before editing.

## Make the smallest correct resolution

- Preserve both intents when they work together.
- When they cannot coexist, choose the behavior that serves the stated goal of
  the merge or rebase and record the trade-off.
- Do not introduce unrelated behavior while resolving the hunk.
- Remove every conflict marker and inspect the final combined code, not only
  the edited lines.

## Prove and finish

Discover the project's checks and run the relevant formatter, type check, and
tests. Fix any breakage caused by integrating the changes.

Stage the resolved files. For a merge, create the merge commit when Git needs
one. For a rebase, run `git rebase --continue` and repeat the same process for
each remaining conflict until the rebase completes.
