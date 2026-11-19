// Pre-deploy hardening (docs/superpowers/specs/2026-11-17-predeploy-hardening.md).
// vi.resetModules() simulates a fresh serverless instance (empty in-memory state).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SignatureTemplate, randomUtxo, type SpendableUtxo } from "cashscript";
import { NodeLikeProvider } from "../test-utils/node-like-provider";
import { binToHex, encodeCashAddress, encodeTransaction, hash160, hexToBin, secp256k1 } from "@bitauth/libauth";

process.env.AGENT_MASTER_SEED ??= "hardening-agent-seed-0123456789abcdef0123456789ab";
process.env.PROVIDER_SEED ??= "hardening-provider-seed-0123456789abcdef0123456789";

const net = { provider: new NodeLikeProvider() };
vi.mock("./electrum", () => ({ getProvider: () => net.provider }));

beforeEach(() => {
  vi.resetModules();
  net.provider = new NodeLikeProvider();
  net.provider.setBlockHeight(1000);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAY_TO = "bchtest:qzhw4v5cag3h98392ktmmaean9wysfmdvuc0drgy7h";
const RESOURCE = "/api/tools/crypto-price";

describe("D1 x402: payments are bound to one request and idempotent", () => {
  async function paidHeaderFor(params: Record<string, string>) {
    const x402 = await import("./x402");
    const { lockingBytecodeOf } = await import("../vault");
    const request = x402.requestDigest("crypto-price", params);
    const challenge = x402.createChallenge(RESOURCE, PAY_TO, 1000n, request);
    const tx = encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(7), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
      outputs: [
        { lockingBytecode: lockingBytecodeOf(PAY_TO), valueSatoshis: 1000n },
        { lockingBytecode: hexToBin("6a15" + x402.memoForChallenge(challenge)), valueSatoshis: 0n },
      ],
    });
    vi.spyOn(net.provider, "getRawTransaction").mockResolvedValue(binToHex(tx));
    return { header: x402.encodePaymentHeader(challenge, "ab".repeat(32)), x402 };
  }

  it("canonicalizes the request (parameter order does not matter)", async () => {
    const { requestDigest } = await import("./x402");
    expect(requestDigest("web-reader", { a: "1", b: "2" })).toBe(requestDigest("web-reader", new URLSearchParams("b=2&a=1")));
    expect(requestDigest("web-reader", { a: "1" })).not.toBe(requestDigest("crypto-price", { a: "1" }));
  });

  it("refuses a paid header for a different request", async () => {
    const { header, x402 } = await paidHeaderFor({ id: "bitcoin-cash" });
    const other = x402.requestDigest("crypto-price", { id: "ethereum" });
    expect(await x402.verifyPayment(header, RESOURCE, other)).toEqual({ ok: false, error: "payment is for a different request" });
  });

  it("accepts the same paid header again for the identical request, also on a fresh instance (retry after a tool failure)", async () => {
    const { header, x402 } = await paidHeaderFor({ id: "bitcoin-cash" });
    const same = x402.requestDigest("crypto-price", { id: "bitcoin-cash" });
    expect((await x402.verifyPayment(header, RESOURCE, same)).ok).toBe(true);
    expect((await x402.verifyPayment(header, RESOURCE, same)).ok).toBe(true);
    vi.resetModules();
    const fresh = await import("./x402");
    expect((await fresh.verifyPayment(header, RESOURCE, same)).ok).toBe(true);
  });
});

describe("D1 replays of a paid request are served from a cache, not recomputed", () => {
  it("stores and returns a successful result by challenge nonce", async () => {
    const { paidResults } = await import("./result-cache");
    expect(await paidResults.get("n1")).toBeUndefined();
    await paidResults.set("n1", { result: { a: 1 }, paidWith: "tx" }, Date.now() + 60_000);
    expect(await paidResults.get("n1")).toEqual({ result: { a: 1 }, paidWith: "tx" });
  });

  it("forgets expired entries and stays bounded", async () => {
    const { ResultCache } = await import("./result-cache");
    const cache = new ResultCache<number>(2);
    cache.set("old", 1, Date.now() - 1);
    expect(cache.get("old")).toBeUndefined();
    cache.set("a", 1, Date.now() + 60_000);
    cache.set("b", 2, Date.now() + 60_000);
    cache.set("c", 3, Date.now() + 60_000);
    expect(cache.size).toBeLessThanOrEqual(2);
    expect(cache.get("c")).toBe(3);
  });

  it("verifyPayment returns the challenge nonce to key the cache", async () => {
    const x402 = await import("./x402");
    const { lockingBytecodeOf } = await import("../vault");
    const request = x402.requestDigest("crypto-price", { id: "x" });
    const challenge = x402.createChallenge(RESOURCE, PAY_TO, 1000n, request);
    const tx = encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(7), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
      outputs: [
        { lockingBytecode: lockingBytecodeOf(PAY_TO), valueSatoshis: 1000n },
        { lockingBytecode: hexToBin("6a15" + x402.memoForChallenge(challenge)), valueSatoshis: 0n },
      ],
    });
    vi.spyOn(net.provider, "getRawTransaction").mockResolvedValue(binToHex(tx));
    expect(await x402.verifyPayment(x402.encodePaymentHeader(challenge, "ab".repeat(32)), RESOURCE, request)).toEqual({ ok: true, txid: "ab".repeat(32), nonce: challenge.nonce, expires: challenge.expires });
  });
});

describe("D1 paid client: retries a paid request on server errors", () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("retries after a 502 and returns the result", async () => {
    const { retryPaidRequest } = await import("./paid-client");
    const calls = [res(502, { error: "price source returned 503" }), res(200, { result: { ok: 1 } })];
    const doFetch = vi.fn(async () => calls.shift()!);
    expect(await retryPaidRequest(doFetch)).toEqual({ ok: true, result: { ok: 1 } });
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("retries while the provider has not seen the payment yet", async () => {
    const { retryPaidRequest } = await import("./paid-client");
    const calls = [res(402, { error: "transaction not found on the network" }), res(200, { result: "x" })];
    expect(await retryPaidRequest(async () => calls.shift()!)).toEqual({ ok: true, result: "x" });
  });

  it("retries after a network error", async () => {
    const { retryPaidRequest } = await import("./paid-client");
    let n = 0;
    const doFetch = async () => {
      if (n++ === 0) throw new TypeError("fetch failed");
      return res(200, { result: 1 });
    };
    expect(await retryPaidRequest(doFetch)).toEqual({ ok: true, result: 1 });
  });

  it("does not retry a client error", async () => {
    const { retryPaidRequest } = await import("./paid-client");
    const doFetch = vi.fn(async () => res(400, { error: "id must be a CoinGecko coin id" }));
    expect(await retryPaidRequest(doFetch)).toEqual({ ok: false, error: "id must be a CoinGecko coin id" });
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after a few attempts", async () => {
    const { retryPaidRequest } = await import("./paid-client");
    const doFetch = vi.fn(async () => res(502, { error: "down" }));
    expect(await retryPaidRequest(doFetch)).toEqual({ ok: false, error: "down" });
    expect(doFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("D2 payFromVault on a fresh instance with a lagging Electrum view", () => {
  async function vault(cap = 8_000n) {
    const { agentKey, accessToken } = await import("./keys");
    const { getVaultContract, buildGenesis } = await import("../vault");
    const { paramsToDescriptorParams } = await import("../descriptor");
    const ownerPriv = new Uint8Array(32).fill(1);
    const ownerPub = secp256k1.derivePublicKeyCompressed(ownerPriv) as Uint8Array;
    const owner = { signer: new SignatureTemplate(ownerPriv), pubHex: binToHex(ownerPub), address: encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(ownerPub) }).address };
    const params = { ownerPk: owner.pubHex, agentPk: agentKey(5).pubHex, capPerPeriod: cap, periodBlocks: 144n, allowlist: [PAY_TO] };
    const contract = getVaultContract(params, net.provider);
    const u = net.provider.addUtxo(owner.address, randomUtxo({ satoshis: 100_000n, vout: 0 }));
    await buildGenesis({ contract, inputs: [{ utxo: u, unlocker: owner.signer.unlockP2PKH() }], deposit: 20_000n, startHeight: 1000, changeAddress: owner.address }).builder.send();
    const descriptor = { version: 1 as const, network: "chipnet" as const, agentIndex: 5, token: accessToken(5), params: paramsToDescriptorParams(params) };
    return { contract, descriptor };
  }

  async function payOnceThenGoStale(lagCalls: number) {
    const { contract, descriptor } = await vault();
    const stale = new Map<string, SpendableUtxo[]>();
    for (const a of [contract.address, contract.tokenAddress]) stale.set(a, await net.provider.getUtxos(a));
    const first = await import("./agent-wallet");
    expect((await first.payFromVault(first.openDescriptor(descriptor), PAY_TO, 1000n)).ok).toBe(true);
    vi.resetModules();
    net.provider.stale = stale;
    net.provider.lagCalls = lagCalls;
    const fresh = await import("./agent-wallet");
    return fresh.payFromVault(fresh.openDescriptor(descriptor), PAY_TO, 1000n);
  }

  it("retries once Electrum catches up, and the payment goes through", async () => {
    const second = await payOnceThenGoStale(1);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.spentInPeriod).toBeGreaterThan(2_000n); // both payments counted
  });

  it("reports a busy vault, not a covenant violation, when Electrum keeps lagging", async () => {
    const second = await payOnceThenGoStale(100);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toMatch(/busy/i);
      expect(second.reason).not.toMatch(/covenant/i);
    }
  });

  it("uses its own last payment when Electrum lags two payments behind on the same instance", async () => {
    const { contract, descriptor } = await vault();
    const genesisView = new Map<string, SpendableUtxo[]>();
    for (const a of [contract.address, contract.tokenAddress]) genesisView.set(a, await net.provider.getUtxos(a));
    const w = await import("./agent-wallet");
    const opened = w.openDescriptor(descriptor);
    expect((await w.payFromVault(opened, PAY_TO, 1000n)).ok).toBe(true);
    net.provider.stale = genesisView; // Electrum keeps reporting the genesis vault UTXO
    net.provider.lagCalls = 1000;
    expect((await w.payFromVault(opened, PAY_TO, 1000n)).ok).toBe(true);
    const third = await w.payFromVault(opened, PAY_TO, 1000n);
    expect(third.ok).toBe(true);
  });

  it("still reports a real covenant refusal as one", async () => {
    const { descriptor } = await vault(1_500n);
    const w = await import("./agent-wallet");
    const out = await w.payFromVault(w.openDescriptor(descriptor), PAY_TO, 2_000n);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/covenant/i);
      expect(out.covenant).toBe(true);
      expect(out.rule).toMatch(/newSpent <= capPerPeriod/);
    }
  });

  it("classifies node errors: only script-verification failures blame the covenant", async () => {
    const { classifyBroadcastError } = await import("./agent-wallet");
    expect(classifyBroadcastError("the transaction was rejected by network rules. mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation)", undefined)).toBe("covenant");
    expect(classifyBroadcastError("the transaction was rejected by network rules. scriptpubkey", undefined)).toBe("other");
    expect(classifyBroadcastError("the transaction was rejected by network rules. scriptsig-size", undefined)).toBe("other");
    expect(classifyBroadcastError("the transaction was rejected by network rules. txn-mempool-conflict (code 18)", undefined)).toBe("stale");
    expect(classifyBroadcastError("anything", "require(newSpent <= capPerPeriod);")).toBe("covenant");
    // Real BCHN text for a failed CSV cooldown (v2 e2e, 2026-11-19): policy flags report it as "non-mandatory".
    expect(classifyBroadcastError("the transaction was rejected by network rules. non-mandatory-script-verify-flag (Locktime requirement not satisfied) (code 64)", undefined)).toBe("covenant");
  });

  it("logs one structured line per payment", async () => {
    const { descriptor } = await vault();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const w = await import("./agent-wallet");
    await w.payFromVault(w.openDescriptor(descriptor), PAY_TO, 1000n);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("{"));
    const evt = lines.map((l) => JSON.parse(l)).find((e) => e.evt === "payment");
    expect(evt).toMatchObject({ evt: "payment", ok: true, amount: "1000" });
    expect(typeof evt.ms).toBe("number");
  });
});

describe("D3 agent mode is explicit", () => {
  it("does not use the LLM just because Vercel provides an OIDC token", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "x");
    vi.stubEnv("AGENT_MODE", "");
    const { agentUsesLlm } = await import("./llm");
    expect(agentUsesLlm()).toBe(false);
  });

  it("uses the LLM only with AGENT_MODE=llm and gateway credentials", async () => {
    vi.stubEnv("AGENT_MODE", "llm");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    expect((await import("./llm")).agentUsesLlm()).toBe(false);
    vi.resetModules();
    vi.stubEnv("VERCEL_OIDC_TOKEN", "x");
    expect((await import("./llm")).agentUsesLlm()).toBe(true);
  });

  it("falls back to the scripted plan when the LLM call fails", async () => {
    vi.stubEnv("AGENT_MODE", "llm");
    vi.stubEnv("AI_GATEWAY_API_KEY", "test");
    vi.doMock("ai", async (orig) => ({
      ...(await orig<typeof import("ai")>()),
      ToolLoopAgent: class {
        async generate() {
          throw new Error("Insufficient funds: add credits to use AI Gateway");
        }
      },
    }));
    vi.doMock("./paid-client", () => ({
      paidCall: vi.fn(async (_o: string, _d: unknown, tool: string) => ({
        ok: true,
        result: tool === "crypto-price" ? { id: "x", priceUsd: 1, change24hPct: 0 } : { text: "t", analysis: "a" },
      })),
    }));
    const { runAgent } = await import("./agent-runner");
    const events: { type: string; text?: string }[] = [];
    await runAgent("http://x", {} as never, "hi", (e) => events.push(e));
    expect(events.some((e) => e.type === "status" && /falling back/i.test(e.text ?? ""))).toBe(true);
    expect(events.at(-1)?.type).toBe("final");
  });
});

describe("D3 no double spending on LLM failure", () => {
  it("does not rerun the scripted plan once the LLM run already paid for tools", async () => {
    vi.stubEnv("AGENT_MODE", "llm");
    vi.stubEnv("AI_GATEWAY_API_KEY", "test");
    vi.doMock("ai", async (orig) => ({
      ...(await orig<typeof import("ai")>()),
      ToolLoopAgent: class {
        tools: Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
        constructor(opts: { tools: Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }> }) {
          this.tools = opts.tools;
        }
        async generate() {
          await this.tools.crypto_price.execute({ id: "bitcoin-cash" }, {});
          throw new Error("rate limited");
        }
      },
    }));
    const paidCall = vi.fn(async (_o: string, _d: unknown, tool: string, _b: unknown, emit: (e: unknown) => void) => {
      emit({ type: "paid", tool, txid: "t", url: "u", amount: "1000", fee: "700", spentInPeriod: "1700", remaining: "0", balance: "0" });
      return { ok: true, result: { id: "bitcoin-cash", priceUsd: 1, change24hPct: 0 } };
    });
    vi.doMock("./paid-client", () => ({ paidCall }));
    const { runAgent } = await import("./agent-runner");
    const events: { type: string; text?: string }[] = [];
    await runAgent("http://x", {} as never, "hi", (e) => events.push(e));
    expect(paidCall).toHaveBeenCalledTimes(1); // no second, scripted round of payments
    expect(events.at(-1)?.type).toBe("final");
    expect(events.at(-1)?.text).toMatch(/stopped/i);
  });
});

describe("D6 web reader follows redirects only to public https URLs", () => {
  it("refuses a redirect to a private address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })));
    const { runTool, ToolInputError } = await import("./tool-impl");
    await expect(runTool("web-reader", new URLSearchParams({ url: "https://example.org/a" }))).rejects.toBeInstanceOf(ToolInputError);
  });

  it("follows a redirect to another public https page and releases the redirect body", async () => {
    const hop = new Response("moved", { status: 301, headers: { location: "https://example.org/b" } });
    const pages = [
      hop,
      new Response("<title>B</title><p>hello</p>", { status: 200 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => pages.shift()!));
    const { runTool } = await import("./tool-impl");
    expect(await runTool("web-reader", new URLSearchParams({ url: "https://example.org/a" }))).toMatchObject({ title: "B", url: "https://example.org/b" });
    expect(hop.bodyUsed || hop.body?.locked).toBeTruthy();
  });
});
