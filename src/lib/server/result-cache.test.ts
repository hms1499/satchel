import { describe, expect, it } from "vitest";
import { createPaidResults } from "./result-cache";
import type { SharedCache } from "./runtime-cache";

function mapCache(): SharedCache {
  const m = new Map<string, unknown>();
  return { get: async <T,>(k: string) => m.get(k) as T | undefined, set: async (k, v) => void m.set(k, v) };
}
const later = () => Date.now() + 60_000;

describe("paidResults (two-level store)", () => {
  it("a result stored by one instance is found by another through the shared cache", async () => {
    const shared = mapCache();
    const a = createPaidResults(() => shared);
    const b = createPaidResults(() => shared);
    await a.set("n1", { result: 1 }, later());
    expect(await b.get("n1")).toEqual({ result: 1 });
  });

  it("works from memory when there is no shared cache", async () => {
    const s = createPaidResults(() => null);
    await s.set("n1", { result: 1 }, later());
    expect(await s.get("n1")).toEqual({ result: 1 });
  });

  it("falls back to memory when the shared cache fails", async () => {
    const broken: SharedCache = { get: () => Promise.reject(new Error("down")), set: () => Promise.reject(new Error("down")) };
    const s = createPaidResults(() => broken);
    await s.set("n1", { result: 1 }, later());
    expect(await s.get("n1")).toEqual({ result: 1 });
  });
});
