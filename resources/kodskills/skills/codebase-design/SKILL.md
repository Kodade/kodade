---
name: codebase-design
description: Provide a shared vocabulary and practical rules for designing deep modules, choosing seams, improving interfaces, and making code easier to test and navigate. Use when designing or restructuring a module, evaluating abstraction depth, or when another skill needs consistent architecture language.
---

# Codebase Design

Use this vocabulary whenever you shape or restructure code. Aim to put useful
behaviour behind an interface that callers can learn quickly. That gives callers
leverage and keeps changes and verification local for maintainers.

## Shared vocabulary

Use these words consistently. A project may have its own domain terms in
`CONTEXT.md`; this is the architecture language that sits alongside them.

**Module** — a unit used through an interface with an implementation behind it.
It may be a function, class, package, or a vertical slice. Do not substitute
*component*, *service*, or *unit*.

**Interface** — the full set of facts a caller needs: operations, parameters,
invariants, ordering, errors, setup, and meaningful performance behaviour. A
type declaration alone is not the interface. Do not substitute *API* or
*signature*.

**Implementation** — the code hidden behind a module's interface. This names
what is inside; use **adapter** when describing a concrete occupant of a seam.

**Depth** — the useful behaviour available for the amount a caller must learn.
A **deep** module hides substantial work behind a compact interface. A
**shallow** module exposes nearly as much complexity as it contains.

**Seam** — the location where behaviour can be changed without editing the
callers at that location. An interface lives at a seam. Avoid *boundary*, which
already carries other meanings in domain design.

**Adapter** — a concrete implementation that satisfies an interface at a seam.
It describes the role, not the size or complexity of its code.

**Leverage** — the caller's return from depth: one learned interface unlocks
behaviour across many call sites and tests.

**Locality** — the maintainer's return from depth: knowledge, bugs, changes,
and verification stay concentrated instead of spreading through callers.

## Judge depth from the outside

Depth is about what callers must carry, not the number of lines hidden inside.
Ask these questions before adding an abstraction:

- Can the interface have fewer operations or simpler inputs?
- Can the module absorb a rule currently repeated by callers?
- If the module vanished, would its complexity reappear in many callers? This
  is the deletion test.
- Can callers and tests cross the same interface? If a test must reach past it,
  reconsider the module's shape.
- Does a seam have two real adapters? With only one, it is usually indirection
  without a present need.

A deep module may contain private seams for its own tests. Do not promote those
private details into the external interface.

## Design for natural tests

Pass dependencies in, return useful results, and keep observable behaviour at
the interface.

```typescript
// Callers and tests can choose the payment dependency.
function finalizeInvoice(invoice, payments) {}

// Constructing a concrete dependency here hides the seam from tests.
function finalizeInvoice(invoice) {
  const payments = new CardProcessor();
}
```

```typescript
// The calculation can be checked through a result.
function priceProposal(proposal): Price {}

// A mutation-only operation makes the effect harder to inspect.
function applyProposalPrice(proposal): void {
  proposal.total = computePrice(proposal);
}
```

Fewer entry points and simpler inputs reduce both caller knowledge and test
setup. Tests should describe outcomes through the interface and survive a
replacement of the implementation.

## Keep the relationships straight

- A module presents one interface to its callers and tests.
- Depth describes a module in relation to that interface.
- The interface is located at a seam.
- An adapter fills that interface at the seam.
- Depth creates leverage for callers and locality for maintainers.

Do not measure depth as implementation lines divided by interface lines; that
rewards bloated internals. Do not reduce interface to a language keyword or a
class's public methods; callers must know more than types alone.

## Continue with the right reference

- For safely consolidating a shallow cluster around its dependencies, read
  [DEEPENING.md](DEEPENING.md).
- For comparing several credible interfaces before committing to one, read
  [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md).
