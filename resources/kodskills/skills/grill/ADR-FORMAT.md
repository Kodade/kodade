# ADR format

Architecture Decision Records live in `docs/adr/`, numbered sequentially:
`0001-slug.md`, `0002-slug.md`. Create the directory lazily when the first
ADR is needed; scan for the highest number and increment.

## Template

```md
# {Short title of the decision}

{1-3 sentences: the context, what was decided, and why.}
```

That's the whole thing. The value is recording *that* a decision was made and
*why* — not filling out sections. Add extras only when they genuinely earn it:

- `status:` frontmatter (`proposed | accepted | deprecated | superseded by
  ADR-NNNN`) — when decisions get revisited
- **Considered options** — when the rejected alternatives are worth remembering
- **Consequences** — when non-obvious downstream effects need calling out

## What qualifies

An ADR must pass all three gates: hard to reverse, surprising without
context, and the result of a real trade-off. Things that typically qualify:

- **Architectural shape.** "Monorepo." "Event-sourced writes, Postgres-projected reads."
- **Integration patterns.** "Contexts talk via domain events, not synchronous HTTP."
- **Lock-in technology choices.** Database, message bus, auth provider,
  deployment target — the ones that would take a quarter to swap, not every library.
- **Boundary decisions.** "Customer data is owned by the Customer context;
  everyone else references it by ID." The explicit no's are as valuable as the yes's.
- **Deliberate deviations from the obvious path.** "Manual SQL instead of an
  ORM because X" — stops the next engineer from "fixing" something deliberate.
- **Constraints invisible in the code.** Compliance requirements, partner API
  latency contracts.
- **Non-obvious rejections.** If GraphQL was considered and REST won for
  subtle reasons, record it — or someone re-proposes GraphQL in six months.
