import { describe, it, expect, vi } from "vitest";
import { binToHex, cashAddressToLockingBytecode, encodeTransaction, hexToBin } from "@bitauth/libauth";
import { createPaywall, InputError, wellKnownResponse, type PaidRoute } from "./paywall.js";
import { memoForChallenge, type Challenge } from "./protocol.js";
import { electrumTransactionFetcher } from "./electrum.js";

// No network in unit tests: the default fetcher is only checked for being wired to the paywall's network.
vi.mock("./electrum.js", () => ({ electrumTransactionFetcher: vi.fn(() => async () => Promise.reject(new Error("offline"))) }));

const SECRET = "paywall-test-secret-0123456789abcdef0123456789";
const PAY_TO = "bchtest:qzhw4v5cag3h98392ktmmaean9wysfmdvuc0drgy7h";
const TXID = "ab".repeat(32);
// A fixed clock near real time: the result cache expires entries by the wall clock.
const NOW = Date.now();
const URL_BASE = "https://seller.example/api/price";

function payingTx(c: Challenge): string {
  const r = cashAddressToLockingBytecode(c.payTo);
  if (typeof r === "string") throw new Error(r);
  return binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(7), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
      outputs: [
        { lockingBytecode: r.bytecode, valueSatoshis: BigInt(c.amount) },
        { lockingBytecode: hexToBin("6a15" + memoForChallenge(c)), valueSatoshis: 0n },
      ],
    }),
  );
}

const header = (challenge: Challenge, txid = TXID) => Buffer.from(JSON.stringify({ challenge, txid })).toString("base64");

function setup(overrides: Partial<PaidRoute> = {}) {
  const txs = new Map<string, string>();
  const getTransaction = vi.fn(async (txid: string) => {
    const hex = txs.get(txid);
    if (!hex) throw new Error("not found");
    return hex;
  });
  const handler = vi.fn(async (p: URLSearchParams) => ({ price: 42, id: p.get("id") }));
  const route: PaidRoute = { resource: "/api/price", name: "price", price: 500n, payTo: PAY_TO, params: ["id"], handler, ...overrides };
  const paywall = createPaywall({ network: "chipnet", secret: SECRET, getTransaction, now: () => NOW });

  /** Asks for a 402, pays it with a real tx the stub can serve, and returns the X-Payment header. */
  async function pay(query = "id=bitcoin-cash"): Promise<{ header: string; challenge: Challenge }> {
    const res = await paywall.handle(new Request(`${URL_BASE}?${query}`), route);
    expect(res.status).toBe(402);
    const { accepts } = (await res.json()) as { accepts: (Challenge & { scheme: string })[] };
    txs.set(TXID, payingTx(accepts[0]));
    return { header: header(accepts[0]), challenge: accepts[0] };
  }
  const get = (query: string, xPayment?: string) =>
    paywall.handle(new Request(`${URL_BASE}?${query}`, { headers: xPayment ? { "x-payment": xPayment } : {} }), route);
  return { paywall, route, handler, getTransaction, pay, get };
}

describe("createPaywall().handle", () => {
  it("rejects an unknown parameter with 400 and issues no 402", async () => {
    const { get } = setup({ params: ["id", "vs"] });
    const res = await get("id=x&coin=y");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown parameter "coin"; expected: id, vs' });
  });

  it("answers a validate InputError with its status before any 402", async () => {
    const validate = vi.fn((p: URLSearchParams) => {
      throw new InputError(`no such coin ${p.get("id")}`, 404);
    });
    const { get } = setup({ validate });
    const res = await get("id=nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such coin nope" });
  });

  it("answers 500 when validate fails unexpectedly", async () => {
    const { get } = setup({ validate: () => Promise.reject(new Error("db down")) });
    expect((await get("id=x")).status).toBe(500);
  });

  it("answers 402 with a bch-sc402 challenge when there is no X-Payment header", async () => {
    const { get } = setup();
    const res = await get("id=bitcoin-cash");
    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toBe('BCH-SC402 realm="satchel"');
    const body = (await res.json()) as { error: string; accepts: Record<string, unknown>[] };
    expect(body.error).toBe("payment required");
    expect(body.accepts[0].scheme).toBe("bch-sc402");
    expect(body.accepts[0]).toMatchObject({ resource: "/api/price", payTo: PAY_TO, amount: "500", network: "chipnet", expires: NOW + 600_000 });
    expect(Object.keys(body.accepts[0]).sort()).toEqual(["amount", "expires", "network", "nonce", "payTo", "request", "resource", "scheme", "sig"]);
  });

  it("serves a valid payment once, and a replay of the same header from the cache", async () => {
    const { get, pay, handler } = setup();
    const { header } = await pay();
    const first = await get("id=bitcoin-cash", header);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ result: { price: 42, id: "bitcoin-cash" }, paidWith: TXID });
    expect(handler).toHaveBeenCalledTimes(1);

    const replay = await get("id=bitcoin-cash", header);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ result: { price: 42, id: "bitcoin-cash" }, paidWith: TXID });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reads POST parameters from the JSON body, bound to the same request digest as GET", async () => {
    const { paywall, route, pay, handler } = setup();
    const { header } = await pay("id=bitcoin-cash");
    const res = await paywall.handle(
      new Request(URL_BASE, { method: "POST", body: JSON.stringify({ id: "bitcoin-cash" }), headers: { "x-payment": header } }),
      route,
    );
    expect(res.status).toBe(200);
    expect(handler.mock.calls[0][0].get("id")).toBe("bitcoin-cash");
  });

  it("refuses a header paid for a different request", async () => {
    const { get, pay, handler } = setup();
    const { header } = await pay("id=bitcoin-cash");
    const res = await get("id=ethereum", header);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "payment is for a different request" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a malformed header, a bad txid and an unknown transaction", async () => {
    const { get, pay } = setup();
    expect(await (await get("id=x", "%%%")).json()).toEqual({ error: "malformed X-Payment header" });
    const { challenge } = await pay("id=x");
    expect(await (await get("id=x", header(challenge, "nothex"))).json()).toEqual({ error: "invalid txid" });
    const res = await get("id=x", header(challenge, "cd".repeat(32)));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "transaction not found on the network" });
  });

  it("answers 502 with paidWith when the handler fails, and runs it again on retry", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error("upstream 503")).mockResolvedValueOnce({ ok: true });
    const { get, pay } = setup({ handler });
    const { header } = await pay();
    const res = await get("id=bitcoin-cash", header);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream 503", paidWith: TXID });
    const retry = await get("id=bitcoin-cash", header);
    expect(await retry.json()).toEqual({ result: { ok: true }, paidWith: TXID });
  });

  it("answers a handler InputError with its status and paidWith", async () => {
    const { get, pay } = setup({ handler: () => Promise.reject(new InputError("address not found", 404)) });
    const { header } = await pay();
    const res = await get("id=bitcoin-cash", header);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "address not found", paidWith: TXID });
  });

  it("logs one event per paid call", async () => {
    const log = vi.fn();
    const route: PaidRoute = { resource: "/r", name: "r", price: 1n, payTo: PAY_TO, params: [], handler: async () => 1 };
    const paywall = createPaywall({ network: "chipnet", secret: SECRET, getTransaction: async () => "00", now: () => NOW, log });
    const res = await paywall.handle(new Request("https://x.example/r"), route);
    const { accepts } = (await res.json()) as { accepts: Challenge[] };
    await paywall.handle(new Request("https://x.example/r", { headers: { "x-payment": header(accepts[0]) } }), route);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ evt: "tool", tool: "r", status: 402, error: "could not decode transaction" }));
  });
});

describe("createPaywall secret", () => {
  it("refuses a missing or short secret", () => {
    expect(() => createPaywall({ network: "chipnet", secret: undefined as unknown as string, getTransaction: async () => "" })).toThrow(/at least 32 characters/);
    expect(() => createPaywall({ network: "chipnet", secret: "", getTransaction: async () => "" })).toThrow(/at least 32 characters/);
    expect(() => createPaywall({ network: "chipnet", secret: "x".repeat(31), getTransaction: async () => "" })).toThrow(/at least 32 characters/);
    expect(() => createPaywall({ network: "chipnet", secret: "x".repeat(32), getTransaction: async () => "" })).not.toThrow();
  });
});

describe("createPaywall defaults", () => {
  it("fetches transactions from Electrum for its network when no getTransaction is given", () => {
    createPaywall({ network: "mainnet", secret: SECRET });
    expect(electrumTransactionFetcher).toHaveBeenCalledWith("mainnet");
  });
});

describe("InputError", () => {
  it("defaults to 400", () => {
    expect(new InputError("bad").status).toBe(400);
    expect(new InputError("gone", 404).status).toBe(404);
    expect(new InputError("bad")).toBeInstanceOf(Error);
  });
});

describe("wellKnownResponse", () => {
  it("serves the catalog as JSON with CORS *", async () => {
    const info = {
      name: "Example seller",
      network: "chipnet" as const,
      tools: [{ name: "price", title: "Price", description: "A price", price: "500", params: { id: "coin id" }, payTo: PAY_TO, endpoint: "https://seller.example/api/price" }],
    };
    const res = wellKnownResponse(info);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual(info);
  });
});
