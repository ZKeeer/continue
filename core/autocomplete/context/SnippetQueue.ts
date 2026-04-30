/**
 * SnippetQueue — Bounded token-capacity queue with FIFO eviction and push-time dedup.
 *
 * Part of the shared context layer (Phase 1).
 * Serves both autocomplete and NextEdit consumers.
 *
 * Design constraints (from README §四):
 * - Bounded by token capacity (not entry count)
 * - 120% over-provisioning to ensure takeUpTo always has enough
 * - Push-time dedup: filepath + lineRange overlap >50% → replace, not append
 * - FIFO: oldest entries evicted first when capacity exceeded
 * - takeUpTo: newest-first selection up to a token budget
 * - tokenCount uses rough estimation: Math.ceil(content.length / 3.5)
 */

export interface QueueEntry {
  filepath: string;
  content: string;
  startLine: number;
  endLine: number;
  /** Rough token estimate: Math.ceil(content.length / 3.5). Not model-specific. */
  tokenCount: number;
  timestamp: number;
  snippetType: "code" | "comment" | "definition" | "diff";
}

/** Estimate tokens from raw content. O(1), model-independent. */
export function estimateTokenCount(content: string): number {
  return Math.ceil(content.length / 3.5);
}

/**
 * Check if two line ranges overlap by more than a given ratio.
 * Returns true if overlap / min(rangeA, rangeB) > threshold.
 */
function lineRangeOverlapExceeds(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  threshold: number,
): boolean {
  const overlapStart = Math.max(aStart, aEnd < bStart ? aStart : bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  if (overlapEnd < overlapStart) {
    return false;
  }
  const overlapLines = overlapEnd - overlapStart + 1;
  const aLines = aEnd - aStart + 1;
  const bLines = bEnd - bStart + 1;
  const minLines = Math.min(aLines, bLines);
  return minLines > 0 && overlapLines / minLines > threshold;
}

export class SnippetQueue {
  /** Entries stored oldest-first (index 0 = oldest). */
  private entries: QueueEntry[] = [];
  private totalTokens = 0;

  /**
   * @param maxTokenCapacity The over-provisioned capacity (e.g. budget * 1.2).
   * @param overlapThreshold Fraction overlap for dedup (default 0.5 = 50%).
   */
  constructor(
    public readonly maxTokenCapacity: number,
    private readonly overlapThreshold: number = 0.5,
  ) {}

  /** Current number of entries. */
  get size(): number {
    return this.entries.length;
  }

  /** Current total rough token count. */
  get currentTokens(): number {
    return this.totalTokens;
  }

  /**
   * Push a new entry. Dedup by filepath + line overlap, then evict oldest if over capacity.
   */
  push(entry: QueueEntry): void {
    // Dedup: check for overlapping entry in same file → replace it
    for (let i = 0; i < this.entries.length; i++) {
      const existing = this.entries[i];
      if (
        existing.filepath === entry.filepath &&
        lineRangeOverlapExceeds(
          existing.startLine,
          existing.endLine,
          entry.startLine,
          entry.endLine,
          this.overlapThreshold,
        )
      ) {
        // Replace: remove old, will push new at end
        this.totalTokens -= existing.tokenCount;
        this.entries.splice(i, 1);
        break; // At most one overlap replacement per push
      }
    }

    // Append as newest (end of array)
    this.entries.push(entry);
    this.totalTokens += entry.tokenCount;

    // Evict oldest until within capacity
    while (
      this.totalTokens > this.maxTokenCapacity &&
      this.entries.length > 1
    ) {
      const evicted = this.entries.shift()!;
      this.totalTokens -= evicted.tokenCount;
    }
  }

  /**
   * Take entries newest-first until budget is exhausted.
   * Does NOT remove entries from the queue (non-destructive read).
   */
  takeUpTo(budget: number): QueueEntry[] {
    const result: QueueEntry[] = [];
    let remaining = budget;

    // Iterate from newest (end) to oldest (start)
    for (let i = this.entries.length - 1; i >= 0 && remaining > 0; i--) {
      const entry = this.entries[i];
      if (entry.tokenCount <= remaining) {
        result.push(entry);
        remaining -= entry.tokenCount;
      }
      // Skip entries that don't fit (greedy packing)
    }

    return result;
  }

  /**
   * Remove all entries for a given filepath.
   */
  removeByFilepath(filepath: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (e.filepath === filepath) {
        this.totalTokens -= e.tokenCount;
        return false;
      }
      return true;
    });
  }

  /**
   * Remove entries older than maxAge (ms).
   */
  removeStale(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    this.entries = this.entries.filter((e) => {
      if (e.timestamp < cutoff) {
        this.totalTokens -= e.tokenCount;
        return false;
      }
      return true;
    });
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
    this.totalTokens = 0;
  }

  /** Get a readonly snapshot of all entries (oldest first). */
  snapshot(): readonly QueueEntry[] {
    return this.entries;
  }
}
