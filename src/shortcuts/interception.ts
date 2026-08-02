import { BINDINGS, comboFor, detectMacPlatform } from "./bindings";
import { eventMatchesCombo, isAppChord, parseCombo } from "./match";

// xterm must release only exact app-owned Mod chords. Explicit Ctrl chords and
// ordinary shell controls (Ctrl+C, Ctrl+Z, etc.) remain terminal input.
export function shouldInterceptXtermKey(
  event: KeyboardEvent,
  isMac = detectMacPlatform(),
): boolean {
  return BINDINGS.some(
    (binding) =>
      isAppChord(comboFor(binding.id)) &&
      eventMatchesCombo(event, parseCombo(comboFor(binding.id)), isMac),
  );
}
