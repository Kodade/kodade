# Deepening

Use this guide to consolidate shallow modules without hiding a dependency or
moving test pain elsewhere. It assumes the vocabulary in [SKILL.md](SKILL.md).

## Classify each dependency

The dependency type determines the seam and how you prove the deepened module.

### In-process

Pure calculations and in-memory state can be brought into the module directly.
Consolidate the responsibility and test it through the resulting interface. No
adapter is needed.

### Locally substitutable

Some I/O has a trustworthy local stand-in, such as a temporary filesystem or a
test database. Deepen around it only when that stand-in is available in normal
tests. Keep this seam inside the module rather than exposing a port solely for
test setup.

### Remote and owned

For a networked system your team controls, place a small port at the seam. The
deep module owns the behaviour; transport arrives as an injected adapter. Use
an in-memory adapter in tests and an HTTP, RPC, or queue adapter in production.

### Truly external

For a third-party system, take the external dependency as an injected port.
Test with a mock or controlled adapter that proves the contract your module
relies on; production supplies the vendor adapter.

## Hold the seam line

- A seam earns its cost when two justified adapters exist, normally production
  and test. One adapter is a hypothetical variation, not a reason to add a
  port.
- Private seams may support the module's implementation and tests. Do not turn
  them into caller-facing configuration.
- Keep the deep module responsible for the rule. An adapter translates at the
  seam; it should not scatter the rule back into callers.

## Replace the proof as you deepen

1. Name the responsibility the deep module will own and classify its
   dependencies.
2. Write or retain outcome-focused tests at the proposed interface.
3. Move the collaborating implementation behind that interface.
4. Remove tests that only exercise the old shallow modules after the new tests
   cover their observable behaviour.
5. Verify that an internal refactor would leave the interface tests intact.

Testing through the interface is the point. A test that fails merely because
private choreography moved is preserving the old shape, not the behaviour.
