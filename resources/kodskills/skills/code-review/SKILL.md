---
name: code-review
description: "Reviews a change since a fixed point on two independent axes: documented repository standards and the originating ticket or spec. Use before committing or merging a ticket, when reviewing a branch or PR, or when asked to review since a base ref."
---

# Code Review

Review the same diff two ways and keep the answers separate.

- **Standards:** Does the change follow this repository’s documented rules and
  avoid meaningful design smells?
- **Spec:** Does the change deliver the originating ticket or specification —
  no less and no more?

One axis cannot excuse a failure on the other. Clean code can build the wrong
thing; a correct feature can still ignore the project’s rules.

## 1. Pin the comparison

Require a fixed point: a commit, branch, tag, merge-base, or the ticket’s
starting commit. Verify it first with `git rev-parse --verify <base>^{commit}`.

For committed branch work, capture these once:

```sh
git diff <base>...HEAD
git log <base>..HEAD --oneline
```

The three-dot diff compares `HEAD` with the merge-base, which is the default
review artifact. Also check that the diff is non-empty and run `git diff
--check` before sending anyone into a review.

For `/implement` work that has not been committed yet, review the current
worktree against the same fixed point with `git diff <base>` instead. Include
staged changes and list untracked files explicitly; do not silently review an
empty `...HEAD` diff and miss the ticket work.

If the caller supplied no base, ask for one rather than guessing. If there is
no change, report that plainly and stop.

## 2. Gather the two contracts

Find the originating requirement in this order:

1. the ticket passed by the caller or referenced by the branch and commits;
2. a GitHub Issue via `gh issue view <number>` when a GitHub remote and
   authenticated `gh` are available;
3. a matching spec under `docs/`, `specs/`, or `.scratch/`;
4. a local markdown ticket under `.scratch/<effort>/issues/` when GitHub is
   unavailable.

If no spec or ticket can be found, say **Spec: no source available**. Do not
invent requirements.

Read the repository’s standards sources before reviewing: root and applicable
subdirectory `AGENTS.md` or `CLAUDE.md`, `CONTRIBUTING.md`, coding standards,
test guidance, and relevant `CONTEXT.md` or ADRs. Repository rules outrank the
smell baseline below.

## 3. Review independently

When the host CLI supports sub-agents, run the Standards and Spec reviews in
parallel with the same pinned diff. Give each reviewer only its contract and
the diff context it needs. When parallel agents are unavailable, do two
separate sequential passes; finish and record one axis before starting the
other.

### Standards pass

Check every changed hunk against the documented rules. Label each finding as:

- **documented standard** — cite the file and rule; or
- **judgment call** — cite a relevant smell below and explain why it matters.

Use this smell baseline only where tooling does not already enforce the rule:

- **Mysterious name:** a name hides what the value or function means; give it
  an honest name or clarify the design.
- **Duplicated code:** two changed places carry the same logic shape; extract
  the shared behavior when doing so makes the code clearer.
- **Feature envy:** a method knows another object’s data better than its own;
  consider moving that behavior to the object it depends on.
- **Data clumps:** the same fields travel together repeatedly; consider one
  meaningful type or value object.
- **Primitive obsession:** a string or number stands in for a domain concept;
  give the concept a small type when its rules need protection.
- **Repeated switches:** the same conditional tree appears in several places;
  centralize it or use a behavior-bearing type.
- **Shotgun surgery:** one small behavior change needs scattered edits; bring
  the behavior’s moving parts closer together.
- **Divergent change:** one module changes for unrelated reasons; separate
  those responsibilities.
- **Speculative generality:** a hook, parameter, or abstraction serves no
  current requirement; remove it until a real need arrives.
- **Message chains:** a caller walks a long object path; hide the navigation
  behind a useful operation.
- **Middle men:** a type only passes every request onward; remove the layer
  unless it adds a real boundary.
- **Refused inheritance:** a subtype fights most of its parent contract;
  prefer composition or a better interface.

These are prompts for judgment, not automatic violations. If repository
guidance deliberately permits a pattern, its guidance wins.

### Spec pass

Compare the diff and tests directly with each acceptance criterion. Report:

- missing or partial requirements;
- behavior outside the requested scope; and
- requirements that look present but are implemented incorrectly.

Quote or cite the exact ticket/spec requirement for every finding. Do not call
an optional idea a missing requirement.

## 4. Report without blending the axes

Give findings with file and line, evidence, impact, and a practical next step.
Keep these headings distinct:

```md
## Standards

## Spec
```

State the finding count and worst issue within each axis. Do not combine or
rerank them into one score. If an axis is clean, say so; if its source was
missing, say that instead of pretending it passed.

When `/implement` requested the review, return the actionable findings to its
loop. It fixes the relevant issues, reruns proof, and reviews the changed diff
again before committing. This skill does not commit, push, or close tickets.
