# CONTEXT.md format

`CONTEXT.md` is the project glossary — the words this project uses, one
definition each, nothing else.

## Structure

```md
# {Project or Context Name}

{One or two sentences: what this context is and why it exists.}

## Language

**Estimate**:
A priced proposal for a scope of work, sent to a customer for approval.
_Avoid_: Quote, bid, proposal

**Job**:
An approved estimate that has been scheduled for work.
_Avoid_: Project, order
```

## Rules

- **Be opinionated.** When several words exist for one concept, pick the best
  one and park the rest under `_Avoid_`.
- **Tight definitions.** One or two sentences. Say what it IS, not what it does.
- **Project terms only.** General programming concepts (timeouts, retries,
  error types) don't belong, no matter how often the code uses them.
- **Group under subheadings** only when natural clusters emerge; a flat list
  is fine.

## Single vs multi-context repos

Most repos: one `CONTEXT.md` at the root. Larger repos with genuinely
separate domains: a `CONTEXT-MAP.md` at the root listing each context, where
its `CONTEXT.md` lives, and how the contexts relate (events consumed, shared
types).

Infer which applies: `CONTEXT-MAP.md` present → multi-context (read it to
find the right glossary); only a root `CONTEXT.md` → single; neither →
create a root `CONTEXT.md` lazily when the first term is resolved. If it's
unclear which context a topic belongs to, ask.
