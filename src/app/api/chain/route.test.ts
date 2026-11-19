import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/electrum", () => ({
  getProvider: () => ({
    getUtxos: async () => [],
    performRequest: async () => [],
    getRawTransaction: async () => "00",
    getBlockHeight: async () => 1,
  }),
}));
vi.mock("@/lib/server/rate-limit", () => ({ allowRequest: async () => true }));

import { POST } from "./route";

const ADDRESS = "bitcoincash:qqly88svdxfpvfxpfj7zr34tx0ssx0lw8smhswrc79";
const call = (body: unknown) => POST(new Request("http://x/api/chain", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": "1.2.3.4" } }));

describe("/api/chain request caps", () => {
  it("admits the wallet scan: 20 addresses for utxos and history", async () => {
    const addresses = Array.from({ length: 20 }, () => ADDRESS);
    expect((await call({ op: "utxos", addresses })).status).toBe(200);
    expect((await call({ op: "history", addresses })).status).toBe(200);
  });

  it("refuses 21 addresses instead of truncating", async () => {
    const addresses = Array.from({ length: 21 }, () => ADDRESS);
    for (const op of ["utxos", "history"]) {
      const res = await call({ op, addresses });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("too many addresses (max 20)");
    }
  });

  it("admits 60 txids and refuses 61", async () => {
    const txids = (n: number) => Array.from({ length: n }, () => "ab".repeat(32));
    expect((await call({ op: "txs", txids: txids(60) })).status).toBe(200);
    const res = await call({ op: "txs", txids: txids(61) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too many txids (max 60)");
  });
});

describe("/api/chain rate limit", () => {
  it("answers 429 when the caller is over the limit", async () => {
    vi.resetModules();
    vi.doMock("@/lib/server/rate-limit", () => ({ allowRequest: async () => false }));
    const { POST: limited } = await import("./route");
    const res = await limited(new Request("http://x/api/chain", { method: "POST", body: JSON.stringify({ op: "height" }), headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate limited, try again in a minute");
  });
});
