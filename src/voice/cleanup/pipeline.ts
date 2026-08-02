// KödWhisper Pro cleanup pipeline — the defensible premium. Deterministic,
// side-effect-free post-processing that turns a rambling dictation into a clean
// agent prompt: strip fillers, collapse self-corrections, expand spoken
// symbols/slash-commands, repair identifiers against the project vocabulary, and
// tidy punctuation/casing. No LLM — every rule is heuristic and table-tested
// (the public TDD seam: `(raw, {vocabulary, provider}) -> cleanText`).
//
// Free tier never calls this; the store runs it only when `vox.cleanup` is
// entitled, so free-tier transcripts are byte-identical to the raw whisper text.

import type { Vocabulary } from "../vocabulary/types";
import { EMPTY_VOCABULARY } from "../vocabulary/types";

// Per-CLI presets. The only behavioral knob today is slash-command expansion
// (agent REPLs take `/plan`; a plain text field does not), but the shape leaves
// room for provider-specific rules without touching call sites.
export type CleanupProvider = "generic" | "claude" | "codex" | "grok";

export type CleanupOptions = {
  vocabulary?: Vocabulary;
  provider?: CleanupProvider;
};

type ProviderPreset = { slashCommands: boolean };

const PROVIDER_PRESETS: Record<CleanupProvider, ProviderPreset> = {
  claude: { slashCommands: true },
  codex: { slashCommands: true },
  grok: { slashCommands: true },
  generic: { slashCommands: false },
};

// --- Stage 1: whitespace normalization -------------------------------------

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

// --- Stage 2: self-correction collapse -------------------------------------
// A spoken correction ("… no wait …") means "ignore what I just said." Cut back
// to the start of the current sentence and keep the correction. Conservative and
// ordered left-to-right so the last correction in a sentence wins.

const CORRECTION_CUES = [
  "no wait",
  "wait no",
  "scratch that",
  "actually no",
  "i mean",
];

// Determiners that signal the cue's first word is a NOUN object ("the scratch
// that folder", "delete the scratch that we don't need") rather than a
// discourse marker ("…scratch that, run the build"). A real correction cue
// reads as a standalone clause — it doesn't follow "the"/"a"/etc. Excluding
// this case fixes a real false positive: a folder literally named "scratch"
// dictated as "open the scratch that folder" must not vanish.
const LEADING_DETERMINERS = new Set([
  "the", "a", "an", "this", "that", "these", "those",
  "my", "your", "our", "his", "her", "its", "their",
]);

// Find the first word-boundary match of `cue` in `text` that isn't preceded by
// a determiner. Word-boundary (not raw substring) so a cue can never fire
// across an unrelated word pair — e.g. "the pia**no wait**s for" must not be
// read as the correction cue "no wait".
function findCueIndex(text: string, cue: string): number {
  const pattern = new RegExp(`\\b${escapeRegExp(cue)}\\b`, "gi");
  for (;;) {
    const match = pattern.exec(text);
    if (!match) return -1;
    const before = text.slice(0, match.index);
    const precedingWord = /([A-Za-z']+)\s*$/.exec(before)?.[1]?.toLowerCase();
    if (!precedingWord || !LEADING_DETERMINERS.has(precedingWord)) {
      return match.index;
    }
    // Preceded by a determiner — this occurrence is a noun phrase, not a
    // correction. Keep scanning for a later, valid occurrence of the same cue.
  }
}

function collapseSelfCorrections(text: string): string {
  let result = text;
  // Loop until stable: each pass removes the earliest cue and its lead-in.
  for (;;) {
    let earliest = -1;
    let cueLength = 0;
    for (const cue of CORRECTION_CUES) {
      const index = findCueIndex(result, cue);
      if (index !== -1 && (earliest === -1 || index < earliest)) {
        earliest = index;
        cueLength = cue.length;
      }
    }
    if (earliest === -1) break;
    // Find the sentence boundary before the cue (start, terminator, or newline).
    const before = result.slice(0, earliest);
    const boundary = Math.max(
      before.lastIndexOf("."),
      before.lastIndexOf("!"),
      before.lastIndexOf("?"),
      before.lastIndexOf("\n"),
    );
    const head = boundary === -1 ? "" : result.slice(0, boundary + 1);
    const tail = result.slice(earliest + cueLength);
    result = `${head} ${tail}`.replace(/[ \t]+/g, " ");
  }
  return result.trim();
}

// --- Stage 3: filler-word strip --------------------------------------------

const FILLER_WORDS = [
  "um", "uh", "uhm", "erm", "ah", "hmm",
  "basically", "literally",
];
const FILLER_PHRASES = ["you know", "sort of", "kind of"];

function stripFillers(text: string): string {
  let result = text;
  for (const phrase of FILLER_PHRASES) {
    result = result.replace(
      new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "gi"),
      " ",
    );
  }
  const wordPattern = new RegExp(`\\b(?:${FILLER_WORDS.join("|")})\\b`, "gi");
  result = result.replace(wordPattern, " ");
  // "actually" only as a leading discourse marker, never mid-sentence content.
  result = result.replace(/^\s*actually\b[,]?\s*/i, "");
  return result.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}

// --- Stage 4: slash-command expansion --------------------------------------
// "slash plan" at the start of a line becomes "/plan" for agent REPLs.

function expandSlashCommands(text: string): string {
  return text.replace(/(^|\n)\s*slash\s+([a-z][a-z0-9-]*)/gi, (_m, lead, cmd) => {
    return `${lead}/${cmd.toLowerCase()}`;
  });
}

// --- Stage 5: identifier / path repair against the vocabulary --------------
// Whisper writes "app store" for `appStore` and "projects dot ts" for
// `projects.ts`. Match each vocabulary term's spoken word-sequence (camelCase /
// separators split away), tolerating spoken connectors ("dot", "underscore",
// "dash"), and restore the canonical identifier. Longest terms win.

const SPOKEN_CONNECTORS = new Set(["dot", "point", "underscore", "dash", "hyphen"]);

// Split a canonical identifier into its lowercase component words.
function identifierComponents(term: string): string[] {
  return term
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s._/\\-]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

type Token = { text: string; isWord: boolean };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[A-Za-z0-9]+|[^A-Za-z0-9]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0], isWord: /[A-Za-z0-9]/.test(match[0][0]) });
  }
  return tokens;
}

function repairIdentifiers(text: string, vocabulary: Vocabulary): string {
  const terms = vocabulary.terms
    .map((term) => ({ term, components: identifierComponents(term) }))
    // Multi-component identifiers only — replacing lone words is too eager.
    .filter((entry) => entry.components.length >= 2)
    // Longest first so "voxStartArgs" wins over "voxStart".
    .sort((a, b) => b.components.length - a.components.length);
  if (terms.length === 0) return text;

  const tokens = tokenize(text);
  // Index of word tokens for windowed matching.
  const wordIndices: number[] = [];
  tokens.forEach((token, index) => {
    if (token.isWord) wordIndices.push(index);
  });

  const replaced = new Array<boolean>(tokens.length).fill(false);
  const output: (string | null)[] = tokens.map((token) => token.text);

  for (let w = 0; w < wordIndices.length; w++) {
    const startToken = wordIndices[w];
    if (replaced[startToken]) continue;
    for (const { term, components } of terms) {
      const span = matchComponents(tokens, wordIndices, w, components);
      if (!span) continue;
      // Replace the matched token span with the canonical identifier.
      output[span.startToken] = term;
      for (let t = span.startToken + 1; t <= span.endToken; t++) output[t] = "";
      for (let t = span.startToken; t <= span.endToken; t++) replaced[t] = true;
      // Advance past the consumed words.
      w = span.endWordIndex;
      break;
    }
  }

  return output.filter((part) => part !== null).join("");
}

// Try to match a component sequence starting at word index `w`, allowing spoken
// connector words between components. Returns the token span consumed.
function matchComponents(
  tokens: Token[],
  wordIndices: number[],
  startWord: number,
  components: string[],
): { startToken: number; endToken: number; endWordIndex: number } | null {
  let ci = 0;
  let wi = startWord;
  let lastMatchedWordIndex = -1;
  while (ci < components.length && wi < wordIndices.length) {
    const tokenIndex = wordIndices[wi];
    const word = tokens[tokenIndex].text.toLowerCase();
    if (word === components[ci]) {
      ci++;
      lastMatchedWordIndex = wi;
      wi++;
    } else if (ci > 0 && SPOKEN_CONNECTORS.has(word)) {
      // A spoken separator between matched components — skip it.
      wi++;
    } else {
      return null;
    }
  }
  if (ci < components.length || lastMatchedWordIndex === -1) return null;
  return {
    startToken: wordIndices[startWord],
    endToken: wordIndices[lastMatchedWordIndex],
    endWordIndex: lastMatchedWordIndex,
  };
}

// --- Stage 6: spoken punctuation & symbols ---------------------------------
// Curated to unambiguous forms (mostly multi-word) so literal dictation of the
// same word is rare. Longest phrases first so "exclamation point" beats "point".

const DICTATION_MAP: [string, string][] = [
  ["new paragraph", "\n\n"],
  ["new line", "\n"],
  ["newline", "\n"],
  ["exclamation point", "!"],
  ["exclamation mark", "!"],
  ["question mark", "?"],
  ["full stop", "."],
  ["open parenthesis", "("],
  ["close parenthesis", ")"],
  ["left paren", "("],
  ["right paren", ")"],
  ["open paren", "("],
  ["close paren", ")"],
  ["open bracket", "["],
  ["close bracket", "]"],
  ["left bracket", "["],
  ["right bracket", "]"],
  ["open brace", "{"],
  ["close brace", "}"],
  ["open curly", "{"],
  ["close curly", "}"],
  ["open angle", "<"],
  ["close angle", ">"],
  ["double quote", '"'],
  ["single quote", "'"],
  ["at sign", "@"],
  ["hash sign", "#"],
  ["pound sign", "#"],
  ["dollar sign", "$"],
  ["percent sign", "%"],
  ["equals sign", "="],
  ["plus sign", "+"],
  ["vertical bar", "|"],
  ["backtick", "`"],
  ["ampersand", "&"],
  ["asterisk", "*"],
  ["backslash", "\\"],
  ["caret", "^"],
  ["period", "."],
  ["comma", ","],
];

function applyDictationCommands(text: string): string {
  let result = text;
  for (const [phrase, symbol] of DICTATION_MAP) {
    const boundary = /[a-z]$/i.test(phrase) ? "\\b" : "";
    result = result.replace(
      new RegExp(`\\b${escapeRegExp(phrase)}${boundary}`, "gi"),
      symbol,
    );
  }
  return result;
}

// --- Stage 7: punctuation spacing & sentence casing ------------------------

function tidyPunctuationAndCasing(text: string): string {
  let result = text
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.!?;:)\]}])/g, "$1") // no space before closing punctuation
    .replace(/([(\[{]) +/g, "$1") // no space after opening bracket (not backtick — it's both open/close)
    .replace(/ *\n */g, "\n")
    .trim();

  // Capitalize the first alphabetic character of each sentence, but never a
  // word that already carries an internal capital (identifiers/acronyms).
  result = result.replace(
    /(^|[.!?]\s+|\n\s*)([a-z][A-Za-z0-9]*)/g,
    (_match, lead: string, word: string) => {
      if (/[A-Z]/.test(word)) return `${lead}${word}`;
      return `${lead}${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    },
  );
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The composed pipeline. Order matters: corrections and fillers go first (so the
// text is what the user meant), then structural expansion, identifier repair,
// spoken symbols, and finally cosmetic spacing/casing.
export function cleanTranscript(raw: string, options: CleanupOptions = {}): string {
  const vocabulary = options.vocabulary ?? EMPTY_VOCABULARY;
  const preset = PROVIDER_PRESETS[options.provider ?? "generic"];

  let text = normalizeWhitespace(raw);
  if (!text) return "";
  text = collapseSelfCorrections(text);
  text = stripFillers(text);
  if (preset.slashCommands) text = expandSlashCommands(text);
  text = repairIdentifiers(text, vocabulary);
  text = applyDictationCommands(text);
  text = tidyPunctuationAndCasing(text);
  return text;
}
