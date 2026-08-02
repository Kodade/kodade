---
name: kodmap
description: Plans work too large for one agent session as a shared map of investigation tickets, resolving one decision at a time until the route is clear. Use when an idea has too many unknowns for a normal spec-and-tickets pass, or the user asks to map a large effort.
disable-model-invocation: true
---

# Kodmap

When a job is bigger than one session and the route is still hidden, do not
start building. First make a shared map of the decisions that reveal the way.
`/kodmap` is for finding the route to a destination, not hauling material to
the finish line.

Name the **destination** before you create a ticket. It can be the decision
that unlocks a plan, a spec ready for `/tickets`, or a clearly bounded change.
That destination sets the boundary for every question on the map.

## Plan, do not deliver

Kodmap plans by default. Each ticket answers a question or clears a necessary
blocker; the map is complete when no meaningful decision remains before the
next person can do the work.

- Do not turn map tickets into implementation tickets just because the answer
  seems obvious. That is the edge of the map; hand the now-clear work to
  `/spec`, `/tickets`, or `/implement`.
- An effort may explicitly override this in **Notes**, but otherwise create
  decisions, not deliverables.
- Resolve no more than one ticket in a session. That keeps the record useful
  and prevents a session from quietly becoming an untracked build.

## Speak in ticket names

Use a ticket's title whenever a person will read it. Never write a bare issue
number, slug, or filename as if it explained itself. Link the title where a
link helps: `[Choose the workspace storage model](#42)`, not just `#42`.

## Choose the tracker

Use GitHub Issues through `gh` when this repository has an accessible GitHub
remote and `gh` is authenticated. The map is one issue labeled `kodmap:map`;
map tickets are regular issues that reference that map in their body. Create
the label if it is missing.

```sh
gh label create 'kodmap:map' --color '1D76DB' --description 'Kodmap index issue' --force
gh issue create --title '<destination as a short map title>' --label 'kodmap:map' --body-file <map-body-file>
```

If there is no usable GitHub remote or `gh` cannot authenticate, use local
markdown instead:

```text
.scratch/<effort>/
├── MAP.md
└── issues/
    ├── choose-storage-model.md
    └── test-offline-recovery.md
```

Work local tickets blockers-first. Keep the same headings, names, questions,
links, and resolution record as the GitHub version. Do not create a second
tracker.

## The map is an index

The map is the low-resolution view you load at the start of each session. It
does not store ticket answers. A decision belongs in exactly one place: the
ticket that resolved it. On the map, leave only a one-line gist linked to that
ticket.

Do not list open tickets in the map body. Find them with a tracker query or by
reading `.scratch/<effort>/issues/`; otherwise the index immediately goes
stale.

### Map body

```markdown
## Destination

<What reaching the end of this map looks like: the spec, decision, or change
this effort is finding its way to. Keep it to one or two lines.>

## Notes

<Domain context, skills each session should consult, and standing preferences.>

## Decisions so far

<!-- One line per closed ticket: enough to judge relevance, then follow the
link for the ticket's full answer. -->

- [<closed ticket title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- In-scope fog that is not sharp enough to become a ticket yet. -->

## Out of scope

<!-- Work ruled beyond this destination. It is closed and never graduates. -->
```

## Tickets and the frontier

Size each ticket to one agent session. Its body starts with the decision it
will settle:

```markdown
## Question

<The decision or investigation this ticket resolves.>

## Map

[<map title>](link)

## Blocked by

- [ ] [<blocking ticket title>](link) (`Blocked by #N`)
```

On GitHub, give every ticket one `kodmap:<type>` label: `research`,
`prototype`, `grilling`, or `task`. To record a dependency, use either a
GitHub task-list entry or a `Blocked by #N` line in the ticket body. Create
the issues first, then wire dependencies after their numbers exist.

The **frontier** is the open map tickets whose blockers are closed. Search for
open issues that reference the map, then inspect their blocker lines or task
lists; do not infer the frontier from the map body. A claimed ticket is not
available to another session. On GitHub, claim it by assigning it to the
person driving the work before doing any investigation. For local tickets,
record `Status: claimed by <name>` at the top.

When you can, query GitHub directly instead of relying on remembered state.
Search for the map title that every ticket carries in its **Map** section:

```sh
gh issue list --state open --search 'in:body "<map title>"' --json number,title,assignees,labels,url,body
```

## Ticket types

Every ticket is either AFK (the agent can drive it alone) or HITL (the user
must answer for themselves). Never fake the human half of a HITL ticket.

- **Research — AFK.** Read code, documentation, or outside sources and link a
  short written finding from the resolution. Use `/research` when it needs a
  deliberate research pass.
- **Prototype — HITL.** Make a rough artifact to react to when the real
  question is behavior, shape, or feel. Use `/prototype`; link the artifact
  from the resolution.
- **Grilling — HITL.** Interview the user in small batches of related
  questions until the decision is real. Use `/grill`. This is the default when the unknown is a choice the
  user must make.
- **Task — AFK or HITL.** Do the smallest manual action needed to unblock a
  decision: provision access, sign up for a service, or expose data in a form
  that can be judged. It earns a place only by unblocking a decision, never by
  delivering the destination. If the user must act, give them a precise
  checklist.

## Fog and scope

Leave the map incomplete on purpose. The **Not yet specified** section holds
in-scope questions you can see coming but cannot state precisely enough to
ticket yet.

- Create a ticket when you can state its question clearly, even if it is
  blocked.
- Keep it in fog when the question is still vague. Do not cut vague work into
  fake ticket-sized pieces; one answer may reveal several real questions, or
  none.
- Keep closed decisions, live tickets, and out-of-scope work out of **Not yet
  specified**.

The destination is the stop line. Work beyond it belongs under **Out of
scope**, not in fog. If an existing ticket proves out of scope, close it and
add a linked one-line reason under **Out of scope**. Do not add it to
**Decisions so far**.

## Start a map

Use this mode when the user brings a loose, multi-session idea.

1. **Set the destination.** Use `/grill` to settle what this effort is trying
   to make clear. Do not create tickets until the destination has a boundary.
2. **Survey breadth-first.** Use `/grill` across the decision space rather
   than digging into one thread. Identify the questions that are sharp now,
   their first takeable steps, and the vague in-scope areas. If the route is
   already clear enough for one session, stop and ask whether to continue with
   `/implement` or the normal `/spec` → `/tickets` flow instead.
3. **Create the map.** Add the `kodmap:map` issue (or `MAP.md`) with
   Destination and Notes completed, no decisions yet, and the remaining fog
   in **Not yet specified**.
4. **Create sharp tickets, then wire blockers.** Each ticket references the
   map. Add dependencies only after all required issues exist. Leave unclear
   work in fog.
5. **Stop.** Charting is a complete session. Do not also resolve a ticket.

## Work one ticket

Use this mode when the user gives a map link, number, or local `MAP.md`. A
specific ticket is optional; if they omit it, choose the next frontier ticket.

1. **Read the map first.** Load the low-resolution map, not every ticket.
2. **Choose and claim a frontier ticket.** Honor the ticket named by the user;
   otherwise choose the first open, unblocked, unclaimed ticket found by
   query. Claim it before investigating.
3. **Resolve the question.** Read related tickets only when their detail is
   needed. Follow skills named in **Notes**; use `/grill` for user decisions
   and `/prototype` when discussion needs something concrete.
4. **Record and close it.** Put the full answer in a resolution comment on
   the GitHub issue, or in that local ticket's `## Resolution` section. Close
   or mark it resolved. Append only a linked one-line pointer to **Decisions
   so far** on the map.
5. **Update what became visible.** Create and wire newly sharp tickets; remove
   each graduated item from **Not yet specified** so it now lives only in its
   ticket. Close and move anything past the destination to **Out of scope**.
   Update invalidated tickets rather than leaving a false route behind.

Unblocked tickets can move in parallel, so expect concurrent edits. Refresh
the tracker before claiming work and keep every decision with its own ticket.
When the frontier and fog are empty, the map has done its job: hand the clear
route to `/spec`, `/tickets`, `/implement`, or `/handoff`.
