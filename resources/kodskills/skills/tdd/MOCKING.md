# Mocking

Mock a system boundary, not your own design.

## What qualifies

Use a fake or mock only when the dependency is outside the behavior under
test or costly to control directly:

- an external service such as payments, email, or a vendor API;
- clock, randomness, or process environment;
- filesystem or network access when a real temporary resource will not do;
- a database only when a test database is impractical.

Do not mock your own modules, private collaborators, or code the repository
controls. Prefer exercising the real interface together; otherwise the test
mostly proves that the mock repeats your setup.

## Keep boundaries easy to replace

Pass boundary dependencies in instead of constructing them inside business
logic. Give the boundary a small, purpose-built interface rather than a giant
generic transport wrapper.

```ts
// The payment boundary is explicit and easy to replace in a test.
function confirmOrder(order: Order, payments: Payments) {
  return payments.charge(order.total);
}

// This hides the boundary inside the behavior under test.
function confirmOrder(order: Order) {
  return new PaymentsClient(process.env.PAYMENTS_KEY).charge(order.total);
}
```

Make each boundary operation specific (`charge`, `sendReceipt`, `loadAccount`)
so a test fixture returns one known shape. Avoid a catch-all `fetch(endpoint,
options)` mock that needs its own routing logic to simulate the system.

## Assertions

Assert the behavior visible at the public seam. Do not make call counts,
internal ordering, or private payload shaping the purpose of the test unless
that interaction is itself the documented boundary contract.

