/**
 * Shared platform utilities — deduplication, voice transcription, file helpers.
 */

/**
 * Generic message deduplicator with TTL expiry and size cap.
 * Each platform creates its own instance with appropriate TTL.
 */
export class MessageDeduplicator<K extends string | number = string> {
  private seen = new Map<K, number>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number, maxSize = 5_000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /** Returns true if this key was already seen (duplicate). Registers key if new. */
  isDuplicate(key: K): boolean {
    const now = Date.now();

    // Prune expired entries (skip full scan unless map is large)
    if (this.seen.size > 100) {
      for (const [id, ts] of this.seen) {
        if (now - ts > this.ttlMs) this.seen.delete(id);
      }
    }

    // Evict oldest if at capacity
    if (this.seen.size >= this.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    return false;
  }

  /** Full prune — call periodically for long-lived instances. */
  prune(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen) {
      if (now - ts > this.ttlMs) this.seen.delete(id);
    }
  }
}

/** Determine the final user text from sanitized input + voice transcription. */
export function determineFinalText(
  sanitized: string,
  voiceTranscription: string,
  isImageOnly: boolean,
): string {
  const text = sanitized || voiceTranscription;
  if (!text && isImageOnly) {
    return "Please describe or analyze the image(s) I just sent.";
  }
  return text;
}
