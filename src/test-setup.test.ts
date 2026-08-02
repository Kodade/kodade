import { expect, it } from "vitest";

it("configures React's act environment for every frontend test", () => {
  expect(Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toBe(true);
});
