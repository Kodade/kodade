// Tolerant parsers for the `gh pr ...` output the KödPR review store consumes
// in PR scope (M12e). Kept out of src/review/** (that folder is the pure diff
// engine); this is store-adjacent glue for the two gh shapes whose output the
// diff parser doesn't already cover: `pr view --json` (header: title, state,
// url, and the CI rollup) and `pr checks` (a plain-text checks table). Both are
// best-effort — malformed or empty output yields a null/empty summary the
// header simply omits, never a throw.

// A minimal, provider-agnostic CI summary: how many checks passed / failed /
// are still pending. Drives the header's one-line "checks" badge.
export type PrChecksSummary = {
  total: number;
  passed: number;
  failed: number;
  pending: number;
};

// PR header data from `pr view --json number,title,author,state,url,statusCheckRollup`.
export type PrView = {
  title: string;
  state: string; // "OPEN" | "MERGED" | "CLOSED" (gh's raw value, upper-cased)
  url: string;
  checks: PrChecksSummary | null; // derived from statusCheckRollup when present
};

// Bucket one gh check "conclusion"/"state" token into pass/fail/pending. gh
// uses SCREAMING_SNAKE for the JSON rollup and lowercase words for the text
// table, so match case-insensitively on the substrings that matter.
function bucketOf(token: string): "passed" | "failed" | "pending" {
  const t = token.toLowerCase();
  if (t.includes("success") || t === "pass" || t.includes("neutral") || t.includes("skip")) {
    return "passed";
  }
  if (
    t.includes("fail") ||
    t.includes("error") ||
    t.includes("cancel") ||
    t.includes("timed") ||
    t.includes("action_required")
  ) {
    return "failed";
  }
  return "pending"; // pending, queued, in_progress, expected, …
}

function emptySummary(): PrChecksSummary {
  return { total: 0, passed: 0, failed: 0, pending: 0 };
}

function tally(summary: PrChecksSummary, token: string): void {
  summary.total++;
  summary[bucketOf(token)]++;
}

// Parse `statusCheckRollup` (an array of check-run/status-context objects) into
// a summary. Each entry may carry `conclusion` (check runs) or `state` (status
// contexts); prefer conclusion, fall back to state, skip entries with neither.
function rollupSummary(rollup: unknown): PrChecksSummary | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const summary = emptySummary();
  for (const entry of rollup) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const token =
      (typeof e.conclusion === "string" && e.conclusion) ||
      (typeof e.state === "string" && e.state) ||
      (typeof e.status === "string" && e.status) ||
      "";
    if (token) tally(summary, token);
  }
  return summary.total > 0 ? summary : null;
}

// Parse `gh pr view --json ...` stdout. Returns null on malformed/non-object
// JSON so the header falls back to the picker's title.
export function parsePrView(raw: string): PrView | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const title = typeof v.title === "string" ? v.title : "";
  const state = typeof v.state === "string" ? v.state.toUpperCase() : "";
  const url = typeof v.url === "string" ? v.url : "";
  if (!title && !state && !url) return null;
  return { title, state, url, checks: rollupSummary(v.statusCheckRollup) };
}

// Parse `gh pr checks <n>` plain-text output: one check per line, tab-separated
// "name<TAB>state<TAB>elapsed<TAB>url". We only need the state column, but scan
// every token on the line for a recognizable state word so minor format drift
// (extra columns, missing elapsed) doesn't lose the row. Blank lines skipped.
const STATE_WORDS = /^(pass|fail|pending|skipping|successful|cancelled|error|neutral|queued)$/i;

export function parsePrChecks(raw: string): PrChecksSummary {
  const summary = emptySummary();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\t+/).map((t) => t.trim());
    const stateToken = tokens.slice(1).find((t) => STATE_WORDS.test(t));
    if (stateToken) tally(summary, stateToken);
  }
  return summary;
}
