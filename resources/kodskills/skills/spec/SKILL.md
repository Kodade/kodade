---
name: spec
description: Turn a grilled idea or the current conversation into a durable, build-ready product spec (PRD), using the repository's language and decisions. Use after `/grill` when a feature is too large for one `/implement` session and needs a clear handoff to `/tickets`.
disable-model-invocation: true
---

# Spec

A grill gets the forms square. This skill writes down what is agreed so the
crew building it does not have to guess.

Turn the current conversation and your codebase knowledge into a written,
build-ready spec. Do not restart discovery or make the user repeat the
interview they just completed. Synthesize the decisions already made.

## Read the ground first

Before writing, establish the current shape of the work:

- Read the relevant code and docs if you have not already done so. Confirm
  what exists, what the feature changes, and the nearby behavior it must not
  disturb.
- Read the root `CONTEXT.md` when it exists. It is the project's glossary;
  use its preferred terms throughout the spec. Do not edit it — `/grill`
  owns the glossary.
- Read relevant ADRs under `docs/adr/` and preserve their decisions. Point out
  a conflict instead of quietly designing around it.
- Find the highest useful test seam. Prefer an existing seam, and add one only
  where the feature cannot be proven otherwise. Fewer seams are easier to
  keep honest; one is ideal.

Do not turn this into another grill. If the thread leaves a material decision
or test seam unresolved, ask one narrow question with a recommendation. If it
does not block a useful spec, record it as an open question instead.

## Write the spec

Write a standalone PRD that a later `/tickets` session can use without the
original chat. Follow this shape, adding detail where the feature needs it and
cutting boilerplate that does not:

```md
# <Feature name>

## Problem statement

Describe the user's problem in their terms: what goes wrong today, for whom,
and why it matters.

## Solution

Describe the intended experience and outcome, from the user's point of view.

## User stories

1. As a <person or role>, I want <capability>, so that <outcome>.

Include the normal path, important variations, failure states, permissions or
roles where relevant, and the operational work needed for the feature to hold
up outside a happy-path demo.

## Implementation decisions

Record the decisions already settled: affected module boundaries, interface or
contract changes, data or schema changes, architecture, and notable behavior.
Explain the reason when it prevents a future reversal by accident.

## Testing decisions

State the external behavior that proves the feature works, the highest seams
to test, and useful prior art already in the repository. Test outcomes, not
private implementation details.

## Out of scope

Name nearby work that this effort deliberately does not include.

## Open questions

List only decisions that genuinely remain unresolved; omit this section when
there are none.

## Further notes

Capture constraints, rollout concerns, migration notes, or other context a
ticket author needs.
```

Make the user stories thorough enough to expose missing behavior, not long for
their own sake. Do not pin the plan to file paths or code snippets that will
rot. The exception is a small, decision-rich artifact from `/prototype` — a
state machine, reducer, schema, or type shape that says something prose cannot.
Label it as prototype output and include only the part that carries the
decision.

## Persist and hand off

Save the approved spec where the project keeps product work. When there is no
established convention, create a GitHub Issue with `gh issue create` when a
GitHub remote and authenticated `gh` are available; otherwise write
`.scratch/<effort>/SPEC.md`. Keep the full spec in that one durable location.

Briefly show the user the problem, solution, test seam, and any open question
before treating the spec as final. Then route the work to `/tickets`. A small,
single-session change can skip the ticket split and go straight to
`/implement`; larger work should become tickets before anyone starts coding.
