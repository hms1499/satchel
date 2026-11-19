import { getCache } from "@vercel/functions";

/** The parts of Vercel Runtime Cache Satchel uses (shared per region across instances; in memory outside Vercel). */
export type SharedCache = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
};

/** Vercel Runtime Cache, or null when it is unavailable. Callers must treat every error as a miss. */
export function sharedCache(): SharedCache | null {
  try {
    const cache = getCache({ namespace: "satchel" });
    return {
      get: async <T,>(key: string) => ((await cache.get(key)) ?? undefined) as T | undefined,
      set: (key, value, ttlSeconds) => cache.set(key, value, { ttl: Math.max(1, Math.ceil(ttlSeconds)), name: "" }),
    };
  } catch {
    return null;
  }
}
