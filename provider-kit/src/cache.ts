/**
 * Best-effort, per-instance cache of paid results, keyed by the payment challenge nonce.
 * A paid header may be replayed for the identical request until it expires (idempotent retries, see challenge.ts);
 * the cache makes such replays return the stored response instead of running the handler (and an LLM) again.
 */
export class ResultCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();
  constructor(private readonly maxEntries = 500) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, expires: number): void {
    if (Date.now() > expires) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expires });
    // Map keeps insertion order: drop the oldest entries beyond the bound.
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}
