// Dialect lookup: catalog entry → stream adapter. Adding a CLI to KödChat is a
// `stream` block in providers/catalog.ts plus (only if its output shape is
// genuinely new) one dialect file here.

import { AVAILABLE_PROVIDERS, type Provider } from "../providers/catalog";
import { createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import type { AgentStreamAdapter } from "./contract";

// The adapter for a provider, or null when it has no verified headless stream.
export function adapterForProvider(provider: Provider): AgentStreamAdapter | null {
  const stream = provider.stream;
  if (!stream) return null;
  switch (stream.dialect) {
    case "claude":
      return createClaudeAdapter(provider, stream);
    case "codex":
      return createCodexAdapter(provider, stream);
    default:
      return null;
  }
}

export function adapterFor(providerId: string): AgentStreamAdapter | null {
  const provider = AVAILABLE_PROVIDERS.find(
    (candidate) => candidate.id === providerId,
  );
  return provider ? adapterForProvider(provider) : null;
}

// Provider ids KödChat can drive, in catalog order — the composer's picker uses
// this to decide which entries are selectable.
export function chatProviderIds(): string[] {
  return AVAILABLE_PROVIDERS.filter((provider) => provider.stream).map(
    (provider) => provider.id,
  );
}
