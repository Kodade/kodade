# Test Shape

## Test behavior through the seam

Use the public interface and assert an outcome the caller cares about.

```ts
test("confirms an order with an approved payment", async () => {
  const result = await checkout(readyCart, approvedPayment);

  expect(result.status).toBe("confirmed");
});
```

Good tests:

- name the capability, not the implementation;
- survive internal refactors;
- use known literals or documented examples as expected values; and
- have one clear reason to fail.

## Avoid implementation-detail tests

Do not test a private method, a collaborator call count, or a database row
when the feature can be observed through its real interface.

```ts
// Fragile: this locks in a particular internal collaboration.
test("checkout calls payment processor", async () => {
  await checkout(readyCart, payment);
  expect(payment.process).toHaveBeenCalledOnce();
});

// Durable: this proves the caller-visible result.
test("confirms an order with an approved payment", async () => {
  expect((await checkout(readyCart, approvedPayment)).status).toBe("confirmed");
});
```

Do not calculate the expectation by repeating the production algorithm. A
known example is stronger:

```ts
expect(total([{ price: 10 }, { price: 5 }])).toBe(15);
```

Never use a batch of imagined tests to design an entire feature. Let each
red-green cycle teach you what the next slice needs.

