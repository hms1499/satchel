import { describe, expect, it } from "vitest";
import { allowRequest } from "./rate-limit";
import type { SharedCache } from "./runtime-cache";

function mapCache(): SharedCache {
  const m = new Map<string, unknown>();
  return { get: async <T,>(k: string) => m.get(k) as T | undefined, set: async (k, v) => void m.set(k, v) };
}

describe("allowRequest", () => {
  it("allows 60 requests in a window and refuses the 61st", async () => {
    const cache = mapCache();
    for (let i = 0; i < 60; i++) expect(await allowRequest("1.2.3.4", 60, 60, cache)).toBe(true);
    expect(await allowRequest("1.2.3.4", 60, 60, cache)).toBe(false);
    expect(await allowRequest("5.6.7.8", 60, 60, cache)).toBe(true); // another IP has its own counter
  });

  it("allows the request when there is no shared cache", async () => {
    expect(await allowRequest("1.2.3.4", 1, 60, null)).toBe(true);
  });

  it("allows the request when the cache fails (fail open)", async () => {
    const broken: SharedCache = { get: () => Promise.reject(new Error("cache down")), set: () => Promise.reject(new Error("cache down")) };
    expect(await allowRequest("1.2.3.4", 1, 60, broken)).toBe(true);
  });
});
