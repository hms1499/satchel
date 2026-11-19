import { ResultCache, type PaidResultStore } from "../../../provider-kit/src/index";
import { sharedCache, type SharedCache } from "./runtime-cache";

export { ResultCache };

/**
 * Paid results by challenge nonce: Vercel Runtime Cache (shared across instances, key `paid:<nonce>`) in front of an
 * in-memory ResultCache. Reads try shared then memory; writes go to both. Shared-cache errors fall back to memory.
 */
export function createPaidResults(shared: () => SharedCache | null = sharedCache): PaidResultStore<unknown> {
  const memory = new ResultCache<unknown>();
  return {
    async get(key) {
      try {
        const hit = await shared()?.get<unknown>(`paid:${key}`);
        if (hit !== undefined) return hit;
      } catch {
        // fall through to memory
      }
      return memory.get(key);
    },
    async set(key, value, expires) {
      memory.set(key, value, expires);
      try {
        await shared()?.set(`paid:${key}`, value, (expires - Date.now()) / 1000);
      } catch {
        // memory still has it
      }
    },
  };
}

/** Shared with the paywall in `api/tools/[tool]`. */
export const paidResults = createPaidResults();
