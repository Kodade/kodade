---
name: unslop
description: Audit a codebase for AI-generated slop and architectural drift, then rank evidence-backed cleanup candidates and guide the chosen change through design and verification. Use when asked to de-slop, simplify, consolidate, or improve an existing codebase's structure, testability, or maintainability.
disable-model-invocation: true
---

# Unslop

Treat this as a job-site walkthrough before demolition. Find the places where
the code makes ordinary work harder, separate proven friction from a hunch,
and make one sound cleanup choice at a time. Do not assume code is bad because
AI wrote it; judge the shape and the evidence.

## Establish the ground truth

Read `CONTEXT.md` and relevant `docs/adr/` records before drawing conclusions.
Use the terms from `/codebase-design`: **module**, **interface**,
**implementation**, **depth**, **seam**, **adapter**, **leverage**, and
**locality**. Use the project's glossary for domain terms.

- Respect a recorded decision unless current, observable friction justifies
  reopening it. Mark that conflict plainly.
- Keep an observation separate from its proposed cleanup. Cite the files,
  call paths, tests, or repeated patterns that support each observation.
- Do not start refactoring while the review is still choosing a target.

## Walk the codebase

Start at entry points and follow a few representative user flows through their
tests and dependencies. Read enough surrounding code to understand the
responsibility before flagging it. Look for work that is unnecessarily spread
out:

- A shallow module whose interface asks callers to understand nearly everything
  its implementation does.
- Pass-through modules, one-use helpers, or abstraction stacks that merely move
  a decision to another file.
- Repeated types, validation, branching, or error handling that has drifted
  between callers.
- Infrastructure details leaking over a seam into domain logic or callers.
- Tests coupled to private choreography instead of observable behaviour.
- Ambiguous names, generic indirection, dead paths, or speculative knobs that
  obscure the domain model.
- Changes to one behaviour that require edits across many modules, showing poor
  locality.

For every suspected shallow module, run the deletion test: mentally remove it.
If callers would each have to reconstruct its work, it is buying leverage. If
little changes beyond file locations, it is probably slop.

## Present the cleanup brief

Give the user a compact Markdown brief in the conversation. Do not create a
temporary HTML dashboard: the audit needs an actionable comparison, not a
second artifact to maintain. Include three to seven candidates, ranked by the
value and confidence of the evidence.

For every candidate, include:

- **Name and files** — name the responsibility and list the concrete paths.
- **Evidence** — what the walkthrough showed, with relevant symbols or lines.
- **Friction** — explain the problem in terms of depth, seam, locality, or
  leverage.
- **Cleanup direction** — describe the safe consolidation or separation, but
  do not settle a new interface yet.
- **Proof and risk** — tests to add, preserve, or replace; migration hazards;
  and any ADR conflict.
- **Strength** — `Strong`, `Worth exploring`, or `Speculative`.

End with one top recommendation and the reason it wins now. Ask the user to
choose a candidate. A simple before/after sketch is useful when call flow or
module ownership would otherwise be hard to see; omit decorative diagrams.

## Take the selected candidate to completion

For a cleanup with a real design choice, use `/grill` to settle the module's
responsibility, seam, and constraints before changing code. For a small,
well-bounded cleanup, state the intended observable behaviour and proof first,
then use `/implement`.

- Put new tests at the deepened module's interface. Once that proof exists,
  remove tests whose only purpose was pinning a discarded shallow wrapper.
- Introduce an adapter or seam only when at least two real implementations need
  it. See `/codebase-design` for dependency categories and alternative
  interfaces.
- Keep the cleanup focused. A candidate that exposes a larger design question
  becomes a separate follow-up rather than expanding the current change.
- Finish with `/code-review`: inspect the full change, confirm the old drift is
  gone rather than relocated, and run the relevant checks.
