// Theme store logic against injected fakes — no matchMedia, no DOM apply. Pins
// resolution (system -> dark/light), explicit picks, unknown-id tolerance,
// system-following live switches, and the apply/save side-effect contract.

import { describe, expect, it, vi } from "vitest";
import type { Theme } from "../themes";
import { SYSTEM_DARK_THEME, SYSTEM_LIGHT_THEME } from "../themes";
import { createThemeStore, resolveTheme } from "./theme";

// A store wired to fakes: a mutable dark flag, and recorders for apply/save.
function makeStore(opts: { dark?: boolean; initial?: string } = {}) {
  let dark = opts.dark ?? true;
  const applied: Theme[] = [];
  const saved: string[] = [];
  const store = createThemeStore(
    {
      prefersDark: () => dark,
      apply: (t) => void applied.push(t),
      save: (sel) => void saved.push(sel),
    },
    opts.initial ?? "system",
  );
  return { store, applied, saved, setDark: (v: boolean) => (dark = v) };
}

describe("resolveTheme", () => {
  it("system follows the OS appearance", () => {
    expect(resolveTheme("system", true).id).toBe(SYSTEM_DARK_THEME.id);
    expect(resolveTheme("system", false).id).toBe(SYSTEM_LIGHT_THEME.id);
  });

  it("an explicit valid id wins over the OS appearance", () => {
    expect(resolveTheme("dark", false).id).toBe("dark");
    expect(resolveTheme("light", true).id).toBe("light");
  });

  it("an unknown/garbage id falls back to system-following (tolerant)", () => {
    expect(resolveTheme("does-not-exist", true).id).toBe(SYSTEM_DARK_THEME.id);
    expect(resolveTheme("", false).id).toBe(SYSTEM_LIGHT_THEME.id);
    expect(resolveTheme("💥", true).id).toBe(SYSTEM_DARK_THEME.id);
  });

  it("ids persisted before the six-theme collapse coerce to system", () => {
    // e.g. a doc saved on 1.3.x with "catppuccin-mocha" — no migration code,
    // just tolerant coercion back to system-following.
    const { store } = makeStore({ initial: "catppuccin-mocha", dark: true });
    expect(store.getState().selection).toBe("system");
    expect(store.getState().resolved.id).toBe(SYSTEM_DARK_THEME.id);
  });
});

describe("theme store", () => {
  it("initializes resolved from the initial selection and OS appearance", () => {
    expect(makeStore({ dark: true }).store.getState().resolved.id).toBe(SYSTEM_DARK_THEME.id);
    expect(makeStore({ dark: false }).store.getState().resolved.id).toBe(SYSTEM_LIGHT_THEME.id);
  });

  it("hydrates from a persisted explicit id", () => {
    const { store } = makeStore({ initial: "dark" });
    expect(store.getState().selection).toBe("dark");
    expect(store.getState().resolved.id).toBe("dark");
  });

  it("setSelection resolves, applies, and persists the choice", () => {
    // Start on a dark system so picking "light" is a real change to apply.
    const { store, applied, saved } = makeStore({ dark: true });
    store.getState().setSelection("light");
    expect(store.getState().selection).toBe("light");
    expect(store.getState().resolved.id).toBe("light");
    expect(applied.at(-1)?.id).toBe("light");
    expect(saved.at(-1)).toBe("light");
  });

  it("system appearance flip re-resolves live while following system", () => {
    const { store, applied, saved, setDark } = makeStore({ dark: true });
    expect(store.getState().resolved.id).toBe(SYSTEM_DARK_THEME.id);

    setDark(false);
    store.getState().systemAppearanceChanged();
    expect(store.getState().resolved.id).toBe(SYSTEM_LIGHT_THEME.id);
    expect(applied.at(-1)?.id).toBe(SYSTEM_LIGHT_THEME.id);
    // A system flip is not a user choice — it must NOT persist.
    expect(saved).toEqual([]);
  });

  it("system flip is ignored when an explicit theme is selected", () => {
    const { store, setDark, applied } = makeStore({ dark: true, initial: "dark" });
    const before = applied.length;
    setDark(false);
    store.getState().systemAppearanceChanged();
    expect(store.getState().resolved.id).toBe("dark"); // unchanged
    expect(applied.length).toBe(before); // no re-apply
  });

  it("reapply force-paints the current resolved theme without persisting", () => {
    const { store, applied, saved } = makeStore({ dark: true });
    store.getState().reapply();
    expect(applied.at(-1)?.id).toBe(SYSTEM_DARK_THEME.id);
    expect(saved).toEqual([]); // reapply is not a user choice
  });

  it("does not re-apply when the resolved theme is unchanged", () => {
    const { store, applied } = makeStore({ dark: true, initial: "dark" });
    const before = applied.length;
    // "system" also resolves to Ködade Dark in dark — same resolved theme, no churn.
    store.getState().setSelection("system");
    expect(applied.length).toBe(before);
  });
});
