// Keybindings: the full shortcut list, read-only for v1. Sourced from the
// binding table the dispatcher uses, so it can never drift out of sync.
// (Push-to-talk is the one rebindable pair today; it lives in KödWhisper.)

import { BINDINGS, detectMacPlatform, labelFor } from "../../shortcuts/bindings";
import { SettingsCard } from "./SettingsCard";

export function KeybindingsSection() {
  const isMac = detectMacPlatform();

  return (
    <SettingsCard title={isMac ? "⌘ shortcuts" : "Ctrl shortcuts"}>
      <ul className="px-4 py-2">
        {BINDINGS.map((binding) => (
          <li
            key={binding.id}
            className="flex items-center justify-between gap-6 py-1.5 text-xs text-text-dim"
          >
            <span className="truncate">{binding.description}</span>
            <kbd className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-text">
              {labelFor(binding.id, isMac)}
            </kbd>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}
