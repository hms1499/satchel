import { sharedCache, type SharedCache } from "./runtime-cache";

/**
 * Fixed-window counter per key (an IP) in the shared cache: at most `limit` requests per `windowSeconds`.
 * Best effort (get-then-set is not atomic) and fail open: no cache, or a cache error, allows the request.
 */
export async function allowRequest(key: string, limit = 60, windowSeconds = 60, cache: SharedCache | null = sharedCache()): Promise<boolean> {
  if (!cache) return true;
  const slot = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  try {
    const count = ((await cache.get<number>(slot)) ?? 0) + 1;
    await cache.set(slot, count, windowSeconds);
    return count <= limit;
  } catch {
    return true;
  }
}
