// KödWhisper Pro voice commands (M9f) — the deterministic command grammar.
//
// This is the public TDD seam: a pure function from a final transcript (plus a
// little app context) to a recognized command OR a "dictation" fall-through.
// There is NO LLM and no separate command engine — matching is a small, closed
// set of anchored patterns over a normalized string. Anything that isn't an
// EXACT match for a known action falls through to dictation, so a near-miss or
// adversarial utterance ("delete the project") can never trigger an action.
//
// Safety properties this file guarantees:
// - Case/punctuation tolerant, but exact on the action (every pattern is
//   anchored ^…$ against the normalized utterance).
// - No partial/substring matching: "send the file to bob" is NOT "send".
// - The grammar never decides to run anything — it only classifies. The store
//   owns the confirm guard, entitlement re-check, and execution.

// A recognized command. Deliberately tiny and closed; new verbs are added here
// (and gated + guarded in the store) rather than inferred.
export type VoiceCommand =
  | { kind: "new-session" }
  | { kind: "switch-terminal"; index: number } // 1-based, as spoken
  | { kind: "next-terminal" }
  | { kind: "prev-terminal" }
  | { kind: "send" } // submits the focused terminal — always confirm-guarded
  | { kind: "cancel" } // abort: clears the voice UI, no app/repo state change
  | { kind: "discard" }; // abort: same, framed for a pending dictation

// Minimal app context for the parser. Reserved for grammar that must validate a
// target against live state; the executor independently enforces existence
// (an out-of-range terminal no-ops gracefully rather than mis-firing).
export type CommandContext = {
  sessionCount?: number;
};

export type CommandParse =
  | { type: "command"; command: VoiceCommand }
  | { type: "dictation" };

// Submitting commands can NEVER auto-fire — they always require the visible
// confirm guard, regardless of the auto-confirm preference. "send" injects a
// carriage return into a live agent REPL, so it is the highest-risk verb.
export function isSubmittingCommand(command: VoiceCommand): boolean {
  return command.kind === "send";
}

// Abort commands touch no app/repo state — they only clear the voice UI — so
// confirming them would be nonsensical; they execute immediately.
export function isAbortCommand(command: VoiceCommand): boolean {
  return command.kind === "cancel" || command.kind === "discard";
}

// Human label for the confirm prompt + command reference.
export function commandLabel(command: VoiceCommand): string {
  switch (command.kind) {
    case "new-session":
      return "New terminal";
    case "switch-terminal":
      return `Switch to terminal ${command.index}`;
    case "next-terminal":
      return "Next terminal";
    case "prev-terminal":
      return "Previous terminal";
    case "send":
      return "Send to terminal";
    case "cancel":
      return "Cancel";
    case "discard":
      return "Discard";
  }
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

// Lowercase, drop everything that isn't a letter/number/space, collapse runs of
// whitespace. This is what makes matching case- and punctuation-tolerant while
// the ^…$ anchors keep it exact on the action.
function normalize(transcript: string): string {
  return transcript
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A spoken index — a digit run ("2") or a number word ("two"). Returns null for
// anything else, so "terminal to" (a mis-hearing) safely falls through.
function toIndex(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const n = Number.parseInt(token, 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  return NUMBER_WORDS[token] ?? null;
}

function command(command: VoiceCommand): CommandParse {
  return { type: "command", command };
}

// Classify a final transcript. Pure and total: every input yields either a
// command or a dictation fall-through — it never throws and never guesses.
export function parseVoiceCommand(
  transcript: string,
  _context: CommandContext = {},
): CommandParse {
  const text = normalize(transcript);
  if (!text) return { type: "dictation" };

  // New terminal.
  if (/^(?:new|create) (?:session|terminal|tab)$/.test(text)) {
    return command({ kind: "new-session" });
  }

  // Switch to terminal N (optionally with a lead-in verb). Checked after
  // new-session so a bare "new terminal" can't be read as a switch.
  const switchMatch = text.match(
    /^(?:switch to |go to |focus |jump to )?(?:terminal|session|tab) (\w+)$/,
  );
  if (switchMatch) {
    const index = toIndex(switchMatch[1]);
    if (index !== null && index >= 1) {
      return command({ kind: "switch-terminal", index });
    }
  }

  // Relative navigation.
  if (/^next (?:terminal|session|tab)$/.test(text)) {
    return command({ kind: "next-terminal" });
  }
  if (/^(?:previous|prev) (?:terminal|session|tab)$/.test(text)) {
    return command({ kind: "prev-terminal" });
  }

  // Submit (guarded). Kept deliberately narrow to minimize false positives on
  // the one verb that can push text into an agent.
  if (/^(?:send|send it|submit|run it)$/.test(text)) {
    return command({ kind: "send" });
  }

  // Aborts. "delete"/"remove" are intentionally NOT triggers, so utterances
  // like "delete the project" stay dictation.
  if (/^(?:cancel|cancel that|never mind|nevermind)$/.test(text)) {
    return command({ kind: "cancel" });
  }
  if (/^(?:discard|discard that|scratch that)$/.test(text)) {
    return command({ kind: "discard" });
  }

  return { type: "dictation" };
}

// The user-facing command reference (Settings). One row per verb, with an
// example phrasing. Kept next to the grammar so they never drift.
export const COMMAND_REFERENCE: { example: string; effect: string }[] = [
  { example: "new terminal", effect: "Open a new terminal session" },
  { example: "terminal 2", effect: "Switch to terminal 2" },
  { example: "next terminal", effect: "Switch to the next terminal" },
  { example: "previous terminal", effect: "Switch to the previous terminal" },
  { example: "send", effect: "Submit the focused terminal (always confirmed)" },
  { example: "cancel", effect: "Dismiss without doing anything" },
];
