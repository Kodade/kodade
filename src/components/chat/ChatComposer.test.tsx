// ChatComposer layout and the thinking-level pill (issue #7): the run-control
// pills sit BELOW the rounded input surface, and the thinking pill renders
// only for a provider/model with a verified thinking flag.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS, type Provider } from "../../providers/catalog";
import { ChatComposer } from "./ChatComposer";

// A chat-capable provider with NO thinking support: like the real catalog
// entries, minus thinkingArgs/thinkingLevels.
const NO_THINKING_PROVIDER: Provider = {
  id: "plain",
  name: "Plain CLI",
  bin: "plain",
  launch: "plain",
  install: "https://example.com",
  stream: {
    dialect: "claude",
    args: ["-p"],
    accessArgs: { plan: [], standard: [], full: [] },
    models: [{ id: "m1", label: "M1" }],
  },
};

function mount(overrides: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ChatComposer
        providers={PROVIDERS}
        providerId="claude"
        model={null}
        access="standard"
        thinking={null}
        attachments={[]}
        draft=""
        working={false}
        onProviderChange={() => undefined}
        onModelChange={() => undefined}
        onAccessChange={() => undefined}
        onThinkingChange={() => undefined}
        onRemoveAttachment={() => undefined}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onCancel={() => undefined}
        {...overrides}
      />,
    );
  });
  return { host, root };
}

let mounted: Root | null = null;
afterEach(() => {
  const root = mounted;
  mounted = null;
  if (root) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("ChatComposer layout", () => {
  it("renders the run-control pills below the input surface, not inside it", () => {
    const { host, root } = mount();
    mounted = root;

    const surface = host.querySelector(".rounded-xl")!;
    expect(surface).not.toBeNull();
    // The textarea and send button stay inside the rounded surface…
    expect(surface.querySelector("textarea")).not.toBeNull();
    expect(surface.querySelector('button[aria-label="Send"]')).not.toBeNull();
    // …while every pill lives outside it.
    for (const label of ["Provider", "Model", "Access level", "Thinking level"]) {
      const pill = host.querySelector(`button[aria-label="${label}"]`);
      expect(pill, label).not.toBeNull();
      expect(surface.contains(pill), `${label} must sit below the surface`).toBe(false);
    }
  });
});

describe("the thinking-level pill", () => {
  it("offers the selected model's levels and reports the pick", () => {
    const onThinkingChange = vi.fn();
    const { host, root } = mount({ onThinkingChange });
    mounted = root;

    const trigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Thinking level"]',
    )!;
    act(() => trigger.click());
    const labels = [...host.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    );
    // Claude 2.1.223's --effort levels, plus the default escape hatch.
    expect(labels[0]).toContain("Default");
    for (const label of ["Low", "Medium", "High", "XHigh", "Max"]) {
      expect(labels.some((entry) => entry?.includes(label)), label).toBe(true);
    }
    const xhigh = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.textContent?.includes("XHigh"),
    )!;
    act(() => xhigh.click());
    expect(onThinkingChange).toHaveBeenCalledWith("xhigh");
  });

  it("shows the chosen level on the chip", () => {
    const { host, root } = mount({ thinking: "high" });
    mounted = root;
    expect(
      host.querySelector('button[aria-label="Thinking level"]')?.textContent,
    ).toContain("High");
  });

  it("does not render for a provider without thinking support", () => {
    const { host, root } = mount({
      providers: [NO_THINKING_PROVIDER],
      providerId: "plain",
    });
    mounted = root;
    // The other pills still render; only the thinking pill is absent.
    expect(host.querySelector('button[aria-label="Model"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Thinking level"]')).toBeNull();
  });

  it("widens to the model's own list when the model goes higher", () => {
    const { host, root } = mount({ providerId: "codex", model: "gpt-5.6-sol" });
    mounted = root;
    const trigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Thinking level"]',
    )!;
    act(() => trigger.click());
    const labels = [...host.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    );
    // gpt-5.6-sol's registry entry goes through ultra; the provider-wide
    // default (shown for "Default model") stops at xhigh.
    expect(labels.some((entry) => entry?.includes("Ultra"))).toBe(true);
  });
});
