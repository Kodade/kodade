const MAX_TOOL_RESULT_CHARS = 16_000;
const MAX_TOOL_SHINGLES = 512;
const MAX_CHECKPOINT_CHARS = 12_000;
const SHINGLE_CHARS = 64;
const SOURCE_SHINGLE_STRIDE = 16;

const SECRET_PATTERNS = [
  /-----begin[^\r\n]*private key(?:-----)?/,
  /akia[0-9a-z]{16}/,
  /gh[pousr]_[a-z0-9]{36,}/,
  /xox[baprs]-/,
  /(api[_-]?key|secret|token|password)\s*[:=]\s*\S{12,}/,
];

function secretScanText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function shingleText(value: string): string {
  return secretScanText(value).replace(/\s+/g, " ").trim();
}

// FNV-1a is sufficient here: a collision only replaces a draft with the safe
// generic checkpoint. It also avoids retaining raw file-derived shingles.
function shingleHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function containsLikelySecret(value: string): boolean {
  const normalized = secretScanText(value);
  return SECRET_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Bounded session guard for model-authored durable checkpoint payloads. */
export class CheckpointContentGuard {
  private readonly toolShingleHashes = new Set<number>();
  private readonly insertionOrder: number[] = [];

  recordToolResult(value: string): void {
    const normalized = shingleText(value).slice(0, MAX_TOOL_RESULT_CHARS);
    if (normalized.length < SHINGLE_CHARS) return;
    for (
      let start = 0;
      start + SHINGLE_CHARS <= normalized.length;
      start += SOURCE_SHINGLE_STRIDE
    ) {
      this.rememberHash(
        shingleHash(normalized.slice(start, start + SHINGLE_CHARS)),
      );
    }
  }

  accepts(draft: { summary: string; nextActions: readonly string[] }): boolean {
    const payload = [draft.summary, ...draft.nextActions].join("\n");
    if (payload.length > MAX_CHECKPOINT_CHARS) return false;
    if (containsLikelySecret(payload)) return false;
    if (this.toolShingleHashes.size === 0) return true;

    const normalized = shingleText(payload);
    for (
      let start = 0;
      start + SHINGLE_CHARS <= normalized.length;
      start += 1
    ) {
      if (
        this.toolShingleHashes.has(
          shingleHash(normalized.slice(start, start + SHINGLE_CHARS)),
        )
      ) {
        return false;
      }
    }
    return true;
  }

  private rememberHash(hash: number): void {
    if (this.toolShingleHashes.has(hash)) return;
    this.toolShingleHashes.add(hash);
    this.insertionOrder.push(hash);
    if (this.insertionOrder.length <= MAX_TOOL_SHINGLES) return;
    const oldest = this.insertionOrder.shift();
    if (oldest !== undefined) this.toolShingleHashes.delete(oldest);
  }
}
