---
name: grill
description: A relentless interview — small batches of related questions — that stress-tests a plan or design before anything gets built, leaving a paper trail of resolved terms (CONTEXT.md) and decisions (ADRs) as it goes. Use when the user wants to pressure-test an idea, sharpen a plan, or says "grill me".
disable-model-invocation: true
---

# Grill

Before you pour concrete, you check the forms. Grilling is that check: a
relentless interview about a plan or design, run until agent and user reach a
shared understanding — and the understanding is written down where the next
session can find it.

## The interview

Interview the user about every aspect of the plan. Walk each branch of the
design tree, resolving decisions in dependency order.

- **Batch 3-4 related questions per round.** Group questions that share a
  decision area (scope, data model, UX, rollout) into one batch, ask it, and
  wait for the answers before the next round. One giant wall of questions is
  bewildering; one question per round wastes time and tokens. Never mix
  unrelated decision areas in a batch, and never batch a question whose
  answer depends on another question in the same batch — dependent questions
  wait for the next round. (If your CLI has a structured question tool like
  AskUserQuestion, use it — up to 4 questions per call fits a round exactly.)
- **Bring a recommendation to every question.** Never ask an open "what do
  you think?" — present the options and say which one you'd pick and why.
- **Facts are yours, decisions are theirs.** If something can be answered by
  reading the codebase, go read it — don't ask. The genuine decisions
  (trade-offs, scope, priorities) always go to the user.
- **Chase the weak point.** When an answer sounds fuzzy or contradicts
  something said earlier, dig there. The goal is to find the soft spots now,
  not during the build.
- **Do not start building.** Grilling ends when the user confirms shared
  understanding — usually the on-ramp to `/spec`, `/tickets`, or
  `/implement`. Do not enact the plan inside the grill session.

## The paper trail

Grilling is where the project's language and decisions get pinned down, so
write them down the moment they crystallize — not in a batch at the end.

### Glossary — CONTEXT.md

The repo root's `CONTEXT.md` is a glossary and nothing else — no
implementation details, no specs, no scratch notes. Create it lazily when the
first term is resolved. Format: [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

During the interview:

- **Challenge terms against the glossary.** If the user's words conflict with
  an existing definition, call it out: "CONTEXT.md says a 'lead' is X, but
  you seem to mean Y — which is it?"
- **Sharpen fuzzy words.** When a term is vague or overloaded ("account",
  "job", "order"), propose one canonical term and record what to avoid.
- **Stress-test with concrete scenarios.** Invent edge cases that force
  precise boundaries between concepts.
- **Cross-reference the code.** When the user states how something works,
  check whether the code agrees. Surface contradictions immediately.

### Decisions — docs/adr/

Offer to record an Architecture Decision Record only when all three hold:

1. **Hard to reverse** — changing your mind later costs real money or time.
2. **Surprising without context** — a future reader would wonder "why on
   earth did they do it this way?"
3. **A real trade-off** — genuine alternatives existed and one was chosen
   for specific reasons.

Miss any one of the three, skip the ADR. Format and what qualifies:
[ADR-FORMAT.md](./ADR-FORMAT.md).

## After the grill

State the shared understanding back in a few sentences and route onward:
multi-session build → `/spec` then `/tickets`; single-session build →
`/implement`; a question that needs runnable code to answer → `/prototype`
(bridge with `/handoff`). Keep the grill, spec, and tickets in one unbroken
context window when you can — they build on the same thinking.
