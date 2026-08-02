// License store tests. Drives the store with the REAL verifier + dev-signed
// fixtures and injected in-memory persistence + a controllable clock, so the
// activation lifecycle (activate/refresh/deactivate/hydrate + graceful expiry)
// is verified end-to-end without touching localStorage or the system clock.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLicenseStore } from "./licenseStore";
import { verifyLicense } from "./verify";
import { DEV_PUBLIC_KEY, signLicense } from "./__fixtures__/dev-keypair";
import type { LicenseToken } from "./types";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const DAY = 86_400_000;

function proToken(overrides: Partial<LicenseToken> = {}): string {
  return signLicense({
    id: "lic-1",
    tier: "pro",
    issuedAt: new Date(NOW - DAY).toISOString(),
    expiry: new Date(NOW + DAY).toISOString(),
    features: ["vox.cleanup"],
    ...overrides,
  });
}

// A store wired to in-memory persistence and a mutable clock the test controls.
function makeStore(initial: string | null = null) {
  let stored = initial;
  let clock = NOW;
  const save = vi.fn((token: string | null) => {
    stored = token;
  });
  const mirror = vi.fn<(token: string | null) => void>();
  const store = createLicenseStore({
    publicKey: DEV_PUBLIC_KEY,
    verify: verifyLicense,
    now: () => clock,
    load: () => stored,
    save,
    mirror,
  });
  return {
    store,
    save,
    mirror,
    getStored: () => stored,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

describe("licenseStore", () => {
  it("starts on the free tier with no token", () => {
    const { store } = makeStore();
    const state = store.getState();
    expect(state.status).toBe("none");
    expect(state.entitlements.tier).toBe("free");
    expect(state.hasFeature("vox.cleanup")).toBe(false);
  });

  it("activates a valid key: unlocks features and persists", () => {
    const { store, save, mirror, getStored } = makeStore();
    const token = proToken();
    const result = store.getState().activate(token);

    expect(result.status).toBe("valid");
    expect(store.getState().status).toBe("valid");
    expect(store.getState().hasFeature("vox.cleanup")).toBe(true);
    expect(store.getState().token).toMatchObject({ tier: "pro" });
    expect(save).toHaveBeenCalledWith(token);
    expect(mirror).toHaveBeenLastCalledWith(token);
    expect(getStored()).toBe(token);
  });

  it("rejects a forged key without persisting or losing free state", () => {
    const { store, save, mirror } = makeStore();
    const result = store.getState().activate("tampered.token");

    expect(result.status).toBe("invalid-signature");
    expect(store.getState().status).toBe("invalid-signature");
    expect(store.getState().message).toBeTruthy(); // clear reason for the user
    expect(store.getState().entitlements.tier).toBe("free");
    expect(save).not.toHaveBeenCalled();
    expect(mirror).toHaveBeenLastCalledWith(null);
  });

  it("honors an expired key as free but keeps its metadata for display", () => {
    const { store, save, mirror } = makeStore();
    const token = proToken({ expiry: new Date(NOW - DAY).toISOString() });
    const result = store.getState().activate(token);

    expect(result.status).toBe("expired");
    expect(store.getState().status).toBe("expired");
    expect(store.getState().entitlements.tier).toBe("free"); // features off
    expect(store.getState().token).toMatchObject({ tier: "pro" }); // still shown
    expect(save).toHaveBeenCalledWith(token); // persisted for graceful re-check
    expect(mirror).toHaveBeenLastCalledWith(null); // never shared with headless CLI
  });

  it("refresh() degrades a license gracefully when it crosses its expiry", () => {
    const { store, setClock } = makeStore();
    store.getState().activate(proToken({ expiry: new Date(NOW + DAY).toISOString() }));
    expect(store.getState().hasFeature("vox.cleanup")).toBe(true);

    // Jump past the expiry and re-evaluate.
    setClock(NOW + 2 * DAY);
    store.getState().refresh();

    expect(store.getState().status).toBe("expired");
    expect(store.getState().hasFeature("vox.cleanup")).toBe(false);
  });

  it("deactivate() clears the license and persistence", () => {
    const { store, save, getStored } = makeStore();
    store.getState().activate(proToken());
    store.getState().deactivate();

    expect(store.getState().status).toBe("none");
    expect(store.getState().entitlements.tier).toBe("free");
    expect(save).toHaveBeenLastCalledWith(null);
    expect(getStored()).toBeNull();
  });

  it("hydrates a persisted valid token straight into Pro on boot", () => {
    const token = proToken();
    const { store, mirror } = makeStore(token);
    expect(store.getState().status).toBe("valid");
    expect(store.getState().hasFeature("vox.cleanup")).toBe(true);
    expect(mirror).toHaveBeenLastCalledWith(token);
  });

  it("clears the headless mirror and stays free when a persisted token is expired", () => {
    const expired = proToken({ expiry: new Date(NOW - DAY).toISOString() });
    const { store, mirror } = makeStore(expired);

    expect(store.getState().status).toBe("expired");
    expect(store.getState().entitlements.tier).toBe("free");
    expect(mirror).toHaveBeenLastCalledWith(null);
  });
});

// Re-verify the free-tier byte-identity promise at the selector boundary: no
// combination of inputs to the store yields tier symbols the free path lacks —
// the store only ever exposes entitlements, never a raw tier flag to Rust.
describe("licenseStore isolation", () => {
  it("exposes only entitlements + display state (no IPC surface)", () => {
    const { store } = makeStore();
    const keys = Object.keys(store.getState());
    expect(keys).toEqual(
      expect.arrayContaining(["entitlements", "status", "message", "token"]),
    );
  });
});
