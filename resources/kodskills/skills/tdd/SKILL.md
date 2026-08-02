---
name: tdd
description: Runs a disciplined red-green-refactor loop for one observable behavior at a public seam. Use while `/implement` is building a ticket, or whenever a feature or bug fix needs test-first evidence.
---

# Test-Driven Development

Use this loop for one vertical slice at a time: one public seam, one behavior,
one small production change. A test should explain what a caller can do, not
how the code happens to work inside.

Before starting, read the ticket’s acceptance criteria, root `CONTEXT.md` when
present, and ADRs that govern the area. Use their domain terms in test names.
Test only seams already agreed in the ticket or confirmed with the user. If the
seam is unclear, pause and ask; an invented boundary produces fragile tests.

Read [TESTS.md](./TESTS.md) before choosing the test shape. Read
[MOCKING.md](./MOCKING.md) whenever a test may replace a dependency.

## Red

Write one test for the smallest unproven behavior through its public interface.

- Name the behavior a user or caller recognizes.
- Use an expected value from the spec, a worked example, or another independent
  source of truth — never a copy of the production calculation.
- Run the narrowest test command and confirm it fails for the behavior you are
  about to add. A failure from broken setup, a typo, or an already-implemented
  behavior is not useful red.

## Green

Write only enough production code to satisfy that one failing test.

- Do not prebuild later ticket requirements or general-purpose abstractions.
- Run the focused test again and make it pass.
- Run a nearby fast check when the repository provides one; catch type and
  integration breakage while the slice is still small.

## Refactor

Once green, make small behavior-preserving improvements only when they clarify
the finished slice. Keep the test green after each change. Do not turn the
refactor step into a cleanup campaign or speculative design exercise; leave
broader design concerns for `/code-review` or a separate ticket.

Repeat from Red for the next accepted behavior. Run the full relevant suite
only after the ticket’s slices are complete.

## Non-negotiables

- Test observable behavior at public seams, not private methods or internal
  call order.
- Prefer real in-process collaborators and a test database when setup is
  cheap. Mock only a true system boundary.
- Keep every cycle vertical. Do not write all tests first and then attempt all
  implementation.
- Do not let a passing test hide an unverified requirement. Each acceptance
  behavior needs its own evidence.

