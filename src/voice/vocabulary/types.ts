// Per-project vocabulary for KödWhisper Pro. Two jobs: bias the whisper decode
// (as an initial_prompt) toward the identifiers a user actually dictates, and
// feed the cleanup pipeline's identifier/path repair. Kept as plain data so
// harvesting is a pure function over a file listing (the public TDD seam).

export type Vocabulary = {
  // Canonical identifiers / symbols / filenames the user is likely to dictate,
  // ordered most-relevant first (user-defined terms lead, harvested symbols
  // follow). Deduped case-insensitively; the first-seen casing is canonical.
  terms: string[];
};

export const EMPTY_VOCABULARY: Vocabulary = { terms: [] };
