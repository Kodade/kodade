---
name: debug
description: Diagnose hard bugs and performance regressions with a disciplined evidence loop. Use when the user says "diagnose" or "debug this", or reports something broken, throwing, failing, flaky, or slow.
---

# Debug

Debugging starts with a feedback loop, not a theory. Get a fast signal that
can catch the reported symptom, then use it to cut through the guesses.
Skip a phase only when you can state why it does not apply.

Before touching code, read the repo's `CONTEXT.md` if present and the ADRs
nearest the affected area. Learn the local terms and decisions first.

## 1. Build the feedback loop

This is the foundation. A tight pass/fail signal lets you test hypotheses,
instrument the right boundary, and use bisection. Reading code without one is
just educated guessing.

Build a loop that drives the real path and can fail on the user's exact
symptom. Try the least costly fit first:

1. A focused unit, integration, or end-to-end test.
2. A `curl` or HTTP script against the dev server.
3. A CLI command with fixture input and a known-good output snapshot.
4. A headless browser check that asserts the relevant DOM, console, or network
   behavior.
5. A saved production request, payload, or event trace replayed in isolation.
6. A small harness that starts only the necessary component with mocked
   dependencies.
7. A property or fuzz loop for intermittent bad output.
8. A bisection harness when the failure has known good and bad revisions.
9. A differential check that compares versions or configurations using one
   input.
10. A human-guided shell loop only when automation cannot reach the action.
    Copy and tailor [hitl-loop.template.sh](./scripts/hitl-loop.template.sh)
    so the prompts and captured evidence remain repeatable.

Treat the loop like a job-site test setup: make it quick, specific, and
repeatable.

- **Make it faster.** Cache setup, skip unrelated services, and narrow the
  scope.
- **Make it sharper.** Assert the reported failure, not merely that the process
  stayed alive.
- **Make it stable.** Pin time, seeds, filesystem state, and network inputs.

For a flaky issue, aim for a high reproduction rate rather than a perfect
single run. Repeat the trigger many times, add safe load or timing pressure,
and narrow the race window until the failure is frequent enough to work on.

If no loop can be built, stop and say so. List the attempts, then ask for one
of: access to the reproducing environment, a captured artifact such as logs,
HAR, dump, or timestamped recording, or permission to add temporary
production instrumentation. Do not move into theory without evidence.

### Gate: the loop is red-capable

Do not begin diagnosis until you have run one unattended command and captured
its output. It must be:

- **Red-capable:** follows the actual path and can detect this symptom.
- **Repeatable:** produces the same verdict, or a known high failure rate for a
  flaky issue.
- **Fast:** measured in seconds where practical.
- **Agent-runnable:** requires no manual action except through the structured
  HITL template.

Record the exact invocation and its observed result. If you catch yourself
forming a code theory before this exists, go back and finish the loop.

## 2. Reproduce and reduce

Run the loop until it fails. Confirm it is the user's failure, not a nearby
error, and capture the exact message, incorrect output, or timing.

Then reduce the case one piece at a time: inputs, callers, configuration,
data, and steps. Re-run after every removal. Keep only what makes the failure
possible.

The repro is small enough when each remaining part is load-bearing: removing
any one turns the loop green. Do not move on with a broad, unexamined scenario.

## 3. Rank hypotheses

Write three to five possible causes before probing any one of them. Rank them
by fit with the evidence. Each must make a testable prediction:

> If `<cause>` is responsible, then changing `<one condition>` will make the
> symptom appear, disappear, or change in a stated way.

Discard vague hunches. Show the ranked list to the user before testing so they
can re-rank it with deployment or domain context. If they are unavailable,
continue with the stated ranking rather than waiting indefinitely.

## 4. Probe the boundary

For every probe, name the hypothesis and prediction it distinguishes. Change
one variable at a time.

Prefer:

1. Debugger or REPL inspection when the environment supports it.
2. Narrow, temporary logs at the boundary between competing explanations.

Never spray logs across the whole system and hunt through the pile later. Tag
every temporary log with a unique marker such as `[DEBUG-a4f2]` so it can be
found and removed in one search.

For a performance regression, measure before changing code. Use a timing
harness, profiler, query plan, or other baseline, then use that measurement to
test hypotheses and bisect when useful. Logging is rarely a performance probe.

## 5. Fix and lock it down

First decide whether a regression test has a correct seam: it must reproduce
the real call pattern, not a shallow approximation that merely looks related.
If no such seam exists, document that finding; the architecture is preventing
the issue from being locked down.

When there is a correct seam:

1. Turn the minimized repro into a failing regression test.
2. Run it and see the expected failure.
3. Apply the smallest fix that addresses the proven cause.
4. Run the test again and see it pass.
5. Re-run the original full feedback loop, not only the reduced test.

## 6. Clean up and close

Before reporting success, verify all of the following:

- The original feedback loop is green.
- The regression test passes, or the missing test seam is clearly documented.
- All temporary `[DEBUG-...]` instrumentation is gone.
- Throwaway harnesses and probes are removed, unless deliberately retained in
  an obvious debug location.
- The root cause is recorded in the relevant commit or PR description so the
  next person does not have to rediscover it.

Ask what would have prevented the issue. If the answer is structural—hidden
coupling, tangled paths, or no usable test seam—route the concrete finding to
`/codebase-design` after the fix is secure.
