---
name: tickets
description: Break an approved spec, plan, or conversation into self-contained tracer-bullet tickets with explicit blocking edges. Use after `/spec` to create buildable work for fresh `/implement` contexts.
disable-model-invocation: true
---

# Tickets

Split the spec into narrow jobs that can be picked up cold and finished
cleanly. A ticket is a small piece of finished work, not a pile of tasks for
one layer of the codebase.

## Gather the job context

Start with the approved spec or the current conversation. If the user gives a
spec path, GitHub issue number, or URL, read its full body and comments before
you split it.

Then get just enough codebase context to make the tickets real:

- Read the root `CONTEXT.md` if it exists and use its glossary terms. Do not
  edit it.
- Respect applicable ADRs in `docs/adr/`.
- Inspect the present behavior and nearby test examples when the conversation
  has not already covered them.
- Identify prefactoring that makes the change straightforward and safe. Put it
  ahead of the feature slice it enables.

## Cut tracer bullets

Draft tickets as vertical slices:

- Each ticket delivers one narrow, complete path through the layers it needs:
  data, service, UI, tests, and operations where applicable.
- Each completed ticket is independently demoable or verifiable.
- Each ticket fits one fresh context window. A new `/implement` session should
  understand its goal, constraints, dependencies, acceptance criteria, and
  proof without reading the old chat.
- Put only genuine gates in `Blocked by`. A ticket with no blockers belongs on
  the frontier and can start now.

Do not force a broad mechanical refactor into a fake vertical slice. For a
rename or shared-contract change that breaks too many callers at once, use
expand–contract instead:

1. **Expand** by adding the new form beside the old one.
2. **Migrate** callers in batches sized to the blast radius, each blocked by
   the expand step and kept green on its own.
3. **Contract** by removing the old form only after every migration batch.

If individual batches cannot stay green, have them share an integration branch
and create a final integrate-and-verify ticket blocked by every batch. Be
plain that the green promise is made at integration, not per batch.

## Make each ticket buildable cold

Every ticket needs these parts:

```md
# <Short, outcome-focused title>

## What to build

Describe the user-visible or externally verifiable behavior this slice makes
work, plus the relevant existing behavior it preserves.

## Context and decisions

Give the domain context, settled constraints, contracts, and boundary choices
that an implementer needs. Link to the parent spec when one exists.

## Acceptance criteria

- [ ] Observable outcome or failure behavior
- [ ] Relevant boundary or compatibility behavior
- [ ] Proof at the chosen test seam

## Blocked by

- None — can start immediately.

## Verification

Name the checks, test seam, or manual proof that shows this slice is done.
```

Keep the ticket outcome-focused rather than a file-by-file task list. Avoid
paths and transient implementation snippets. A small prototype artifact is
the exception when it locks in a decision more precisely than prose; label its
origin and include only the decision-carrying part.

## Review the dependency map

Before creating anything, show the proposed work as a numbered list:

1. **Title** — what it delivers.
   **Blocked by:** ticket numbers or `None`.

Ask whether the slices are too coarse or too fine, whether any should merge or
split, and whether each blocking edge is a real gate. Revise until the user
approves.

## Create the ticket ledger

Use GitHub Issues by default. If the repository has a GitHub remote and `gh`
is authenticated, create one issue per approved ticket with `gh issue create`,
in dependency order so blockers receive issue numbers first. Do not close or
rewrite a parent issue.

In every GitHub issue, include the self-contained ticket content above. Write
each dependency as a checkable edge under `## Blocked by`:

```md
- [ ] Blocked by #123 — <blocker title>
```

Use `- None — can start immediately.` when there is no blocker. This makes the
dependency graph readable in GitHub without pretending GitHub has native
blocking relationships.

When there is no GitHub remote or `gh` is unavailable, create the same tickets
as local markdown files under `.scratch/<feature>/issues/`. Work blockers
first and number them in dependency order:

```text
.scratch/<feature>/issues/01-<slug>.md
.scratch/<feature>/issues/02-<slug>.md
```

Each local file carries the same sections. Under `## Blocked by`, name the
blocking file number and title, or write `None — can start immediately.` Keep
one ticket per file; do not collapse the set into a single planning document.

## Build from the frontier

Start with tickets whose blockers are complete, one at a time, using a fresh
`/implement` context for each. As edges clear, take the next frontier ticket.
That keeps the ticket brief as the whole job packet for the next builder.
