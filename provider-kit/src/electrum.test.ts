import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@electrum-cash/network");
});

describe("electrumTransactionFetcher", () => {
  it("times out a connection that never completes", async () => {
    vi.doMock("@electrum-cash/network", () => ({
      ElectrumClient: class {
        status = 0;
        connect() {
          return new Promise<void>(() => {});
        }
      },
    }));
    const { electrumTransactionFetcher } = await import("./electrum");
    const fetcher = electrumTransactionFetcher("chipnet", "example.invalid", 20);
    await expect(fetcher("ab".repeat(32))).rejects.toThrow(/timed out/);
  });

  it("does not cache a client constructor that threw", async () => {
    let calls = 0;
    vi.doMock("@electrum-cash/network", () => ({
      ElectrumClient: class {
        status = 1;
        constructor() {
          if (++calls === 1) throw new Error("bad host");
        }
        request() {
          return Promise.resolve("00");
        }
      },
    }));
    const { electrumTransactionFetcher } = await import("./electrum");
    const fetcher = electrumTransactionFetcher("chipnet", "example.invalid", 1000);
    await expect(fetcher("ab".repeat(32))).rejects.toThrow("bad host");
    await expect(fetcher("ab".repeat(32))).resolves.toBe("00");
  });
});
