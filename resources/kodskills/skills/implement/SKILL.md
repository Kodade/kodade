---
name: implement
description: Builds one well-defined ticket from its acceptance criteria through tests, review, commit, and ticket closure. Use when the user invokes `/implement` for a GitHub Issue or local markdown ticket that is ready to build.
disable-model-invocation: true
---

# Implement

Build one ticket at a time. Start each ticket in a fresh context so its scope,
test evidence, review, and commit all point to one piece of work.

`/implement` is the build loop, not the landing gate. `/ship` owns pushing,
merging, final reporting, and other end-of-work handling.

## 1. Read the job before touching code

Resolve the ticket and its source material first.

- Default to GitHub Issues: use `gh issue view <number>` when the repository
  has a GitHub remote and `gh` is authenticated.
- If that is unavailable, read the local markdown ticket under
  `.scratch/<effort>/issues/`. Treat that file as the ticket of record.
- Read linked specs, acceptance criteria, and relevant code before proposing
  a change. Read root `CONTEXT.md` when present, plus applicable ADRs, so the
  implementation uses the project’s established terms and decisions.
- State the ticket’s outcome, constraints, and the first test seam in a short
  working plan. If the ticket or spec leaves a real product decision open,
  stop and ask one focused question. Do not use implementation to guess.
- Check the working tree. Preserve unrelated changes and keep them out of this
  ticket’s tests and commit.

The ticket’s accepted behaviors are the seam agreement for `/tdd`. If they do
not name testable public boundaries, propose the smallest useful seams and get
confirmation before writing a test.

## 2. Build in vertical slices

Drive `/tdd` one observable behavior at a time. Do not write a wall of tests
or a whole subsystem before getting the first behavior green.

For every slice:

1. Name one accepted behavior at one public seam.
2. Use `/tdd` to write a failing behavior test and prove it fails for the
   expected reason.
3. Add the smallest production change that makes that test pass.
4. Run the focused test, then make only safe behavior-preserving cleanup.
5. Record what the slice proved and choose the next acceptance behavior.

Run focused tests after each green slice. Run type checks, lint, or other fast
repository gates regularly rather than saving all feedback for the end. Keep
the full suite for the completed ticket, along with any ticket-specific
validation the project documents.

Do not widen the ticket to clean up nearby code, add imagined future features,
or fix unrelated failures. Create or point to a follow-up ticket instead.

## 3. Review the finished diff

Before the final commit, run `/code-review` against the ticket’s starting
point. Give it the ticket/spec and the fixed point captured before the work
started. It checks the implementation independently against repo standards and
the requested behavior.

Fix material findings, rerun the affected tests and checks, then rerun review
when the fixes materially change the diff. A green test suite does not excuse
a standards or spec miss.

## 4. Commit and close the ticket

When the acceptance criteria, tests, and review are clean:

- Commit only the ticket’s files with
  `<type>: <description>`, where type is one of `feat`, `fix`, `refactor`,
  `docs`, `test`, `chore`, `perf`, or `ci`.
- Close the GitHub Issue with its commit and validation evidence, or update
  the local ticket’s status and closure note. Do not close a ticket with an
  unresolved requirement or known regression.
- Hand off to `/ship` for branch landing: pushing, merging, release-facing
  checks, cleanup, and the final status report all belong there.

