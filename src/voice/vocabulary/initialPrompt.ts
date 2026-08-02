// Turn a Vocabulary into a whisper `initial_prompt` string. whisper.cpp treats
// the initial prompt as leading context that biases decoding toward the words
// it contains — the standard "hotword" trick. A comma-separated term list is the
// established form; we cap it so it never blows past whisper's prompt window.

import type { Vocabulary } from "./types";

// whisper's prompt is bounded (~224 tokens). Chars are a safe, deterministic
// proxy — ~600 keeps us comfortably inside the window with headroom for the
// lead-in below, without needing a tokenizer in the frontend.
export const DEFAULT_PROMPT_MAX_CHARS = 600;

// A short natural-language lead-in reads better to whisper than a bare list and
// frames the terms as vocabulary rather than content to transcribe verbatim.
const LEAD_IN = "Technical terms: ";

export function buildInitialPrompt(
  vocabulary: Vocabulary,
  maxChars: number = DEFAULT_PROMPT_MAX_CHARS,
): string | null {
  const terms = vocabulary.terms.map((term) => term.trim()).filter(Boolean);
  if (terms.length === 0) return null;

  const budget = Math.max(0, maxChars - LEAD_IN.length);
  const kept: string[] = [];
  let used = 0;
  for (const term of terms) {
    const addition = kept.length === 0 ? term.length : term.length + 2; // ", "
    if (used + addition > budget) break;
    kept.push(term);
    used += addition;
  }
  if (kept.length === 0) return null;

  return `${LEAD_IN}${kept.join(", ")}.`;
}
