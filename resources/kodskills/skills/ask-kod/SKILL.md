---
name: ask-kod
description: Ask which skill or flow fits the current situation — a router over the skills in this collection. Use when the user isn't sure where to start or which skill applies.
disable-model-invocation: true
---

# Ask Kod

You don't have to remember every skill — ask, and get routed to the right
one. A **flow** is a path through the skills. Most work travels one **main
flow**; a few on-ramps merge onto it, and the rest are standalone tools or
vocabulary running underneath.

## The main flow: idea → ship

You have an idea and want it built.

1. **`/grill`** — sharpen the idea by relentless interview. In a codebase it
   leaves a paper trail (`CONTEXT.md` glossary + ADRs); with no codebase it
   still works, just stateless.
2. **Branch — can every question be settled in conversation?** If one needs a
   runnable answer (a state model, business logic, a UI you have to see),
   detour: `/handoff` out, open a fresh session, `/prototype` the answer,
   `/handoff` back.
3. **Branch — is this a multi-session build?**
   - **Yes** → `/spec` (turn the thread into a build-ready spec), then
     `/tickets` (split into tracer-bullet tickets with blocking edges). Then
     run `/implement` per ticket, **one ticket per fresh context**, working
     the frontier — tickets whose blockers are closed.
   - **No** → `/implement` right here.
4. **`/ship`** — the landing gate when the work is done: full gate suite,
   branches merged in order, pushed, git state verified. Nothing is "done"
   until `/ship` says so.

`/implement` drives `/tdd` internally — one red-green slice at a time — and
closes each ticket with `/code-review` before committing. Reach for `/tdd`
alone to build one behavior test-first, and `/code-review` alone to review
any branch or PR against a fixed point.

**Context hygiene:** keep grill → spec → tickets in one unbroken context
window so they build on the same thinking. Each `/implement` starts fresh
from the ticket. When a session degrades before the tickets exist, `/handoff`
and continue in a new thread — don't push on foggy.

## On-ramps

- **Something's broken** → `/debug`. For the bug that resists a first
  glance: it builds a tight feedback loop before theorizing, then fixes with
  a regression test. When the post-mortem shows there was no good seam to
  lock the bug down, that finding feeds `/unslop`.
- **A huge, foggy effort** — greenfield project or a feature too big to even
  spec → `/kodmap`. It charts a shared map of decision tickets on the issue
  tracker and resolves them one at a time until the way is clear, then
  merges onto the main flow at `/spec` (or straight to `/implement` if the
  effort shrank).
- **Mid-merge conflict** → `/merge-conflicts`. Recovers both sides' intent
  before resolving.

## Codebase health

- **`/unslop`** — run in a spare moment to audit for AI slop and
  architectural drift. It surveys and ranks cleanup candidates; picking one
  generates an idea you take into the main flow at `/grill`.
- **`/codebase-design`** — the vocabulary bench underneath: deep modules,
  seams, interfaces, design-it-twice. `/tdd` and `/unslop` both speak it.
  Reach for it directly when the *words* are the problem, not the process.

## Research and crossing sessions

- **`/research`** — clarify-first parallel research (codebase, docs, web)
  before planning. Its findings feed `/grill` — research sharpens thinking,
  it doesn't replace it.
- **`/handoff`** — compact the session into a file and continue in a fresh
  one. Forks the context. Your CLI's `/compact` continues in place with a
  summary — use it between phases; use `/handoff` when you want a genuinely
  fresh session with the context preserved.

## How to answer

When the user describes a situation, name the one skill (or short chain) that
fits, say why in a sentence, and start it if they agree. Don't recite this
whole map back at them.
