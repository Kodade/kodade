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

describe("Ollama composer semantics", () => {
  it("shows dynamic local models and hides agent access controls", () => {
    const { host, root } = mount({
      providerId: "ollama",
      ollama: {
        status: "ready",
        models: [{ id: "qwen3:8b", label: "qwen3:8b" }],
        message: null,
      },
    });
    mounted = root;
    expect(host.querySelector('[data-testid="ollama-chat-notice"]')?.textContent).toContain(
      "no filesystem access, tools, or server-side sessions",
    );
    expect(host.querySelector('button[aria-label="Model"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Access level"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Thinking level"]')).toBeNull();
  });

  it("keeps send disabled when Ollama is ready but has no installed models", () => {
    const { host, root } = mount({
      providerId: "ollama",
      draft: "keep this draft",
      ollama: {
        status: "ready",
        models: [],
        message: "Ollama is running, but no local models are installed yet.",
      },
    });
    mounted = root;
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(
      true,
    );
  });

  it("offers an explicit model refresh while unavailable without remounting", () => {
    const onRefreshOllama = vi.fn();
    const { host, root } = mount({
      providerId: "ollama",
      ollama: {
        status: "unavailable",
        models: [],
        message: "Ollama is not running. Start it, then retry.",
      },
      onRefreshOllama,
    });
    mounted = root;
    const refresh = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "refresh models",
    );
    act(() => refresh?.click());
    expect(onRefreshOllama).toHaveBeenCalledOnce();
  });
});

describe("dynamic OpenCode models", () => {
  it("offers Default plus only the discovered model ids", () => {
    const onModelChange = vi.fn();
    const { host, root } = mount({
      providerId: "opencode",
      providerModels: {
        status: "ready",
        models: [
          {
            id: "openrouter/~anthropic/claude-fable-latest",
            label: "openrouter/~anthropic/claude-fable-latest",
          },
        ],
        message: null,
      },
      onModelChange,
    });
    mounted = root;
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!;
    act(() => trigger.click());
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Default model"),
      expect.stringContaining("openrouter/~anthropic/claude-fable-latest"),
    ]);
    act(() => options[1]!.click());
    expect(onModelChange).toHaveBeenCalledWith(
      "openrouter/~anthropic/claude-fable-latest",
    );
  });

  it("stays Default-only when discovery is unavailable or intentionally withheld", () => {
    const { host, root } = mount({
      providerId: "opencode",
      providerModels: undefined,
    });
    mounted = root;
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!;
    act(() => trigger.click());
    expect([...host.querySelectorAll('[role="option"]')].map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Default model"),
    ]);
  });

  it("retries unavailable discovery without remounting", () => {
    const onRefreshProviderModels = vi.fn();
    const { host, root } = mount({
      providerId: "opencode",
      providerModels: {
        status: "unavailable",
        models: [],
        message: "OpenCode model discovery failed. Default remains available.",
      },
      onRefreshProviderModels,
    });
    mounted = root;

    const refresh = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "refresh models",
    );
    act(() => refresh?.click());
    expect(onRefreshProviderModels).toHaveBeenCalledOnce();
  });

  it("locks provider and model controls while a turn is working", () => {
    const { host, root } = mount({
      providerId: "opencode",
      working: true,
      providerModels: {
        status: "ready",
        models: [{ id: "provider/model", label: "provider/model" }],
        message: null,
      },
    });
    mounted = root;
    for (const label of ["Provider", "Model", "Access level"]) {
      expect(host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.disabled).toBe(
        true,
      );
    }
  });
});
