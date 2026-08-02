# Design It Twice

Do not settle on the first plausible interface for a deepening candidate.
Create several genuinely different designs, then compare the trade-offs using
the vocabulary in [SKILL.md](SKILL.md). Keep the project's domain names from
`CONTEXT.md` in every design.

## Frame the design space

Before drafting interfaces, state the problem in plain language:

- The responsibility and constraints the new module must carry.
- Its dependencies and their categories from [DEEPENING.md](DEEPENING.md).
- A small code sketch that makes the existing coupling concrete. It is context,
  not a preferred solution.

Show the frame to the user, then proceed with independent design passes. Do
not let the first draft become the template for every later option.

## Create independent options

Write at least three alternatives. Keep their briefs separate and deliberately
push each toward a different result:

1. **Minimal interface** — one to three entry points and the highest leverage
   per operation.
2. **Flexible interface** — make extension and uncommon use cases easy, while
   naming the extra caller burden honestly.
3. **Common-caller interface** — make the normal path nearly effortless and
   contain exceptions inside the module where possible.
4. **Ports-and-adapters interface** — add this option when a cross-process
   dependency needs a real seam.

For every option, provide:

1. The interface, including invariants, ordering, errors, and parameters.
2. A short caller example.
3. The behaviour kept behind the seam.
4. The dependency and adapter strategy.
5. The trade-off in depth, leverage, and locality.

## Compare, recommend, decide

Present each design clearly, then compare them on interface depth, where
knowledge and change collect, and the placement of each seam. Give a direct
recommendation rather than a menu. If a hybrid preserves the best properties
of two options, propose it explicitly.

Use this as a design exercise, not a vote on formatting. The winning interface
is the one that leaves callers with the least unnecessary knowledge while
keeping the responsibility coherent and testable.
