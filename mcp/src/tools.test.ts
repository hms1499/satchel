import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignatureTemplate, binToHex, hexToBin, secp256k1 } from "../../src/lib/chain-deps";
import { decodeTransaction, encodeCashAddress, hash160 } from "@bitauth/libauth";
import { NodeLikeProvider } from "../../src/lib/test-utils/node-like-provider";
import { buildGenesis, buildWithdraw, findVaultUtxo, getVaultContract, lockingBytecodeOf, type VaultParams } from "../../src/lib/vault";
import { encodeConnectCode, type ConnectInfo } from "../../src/lib/connect-code";
import { paramsToDescriptorParams } from "../../src/lib/descriptor";
import { memoForChallenge, type Challenge } from "../../src/lib/x402-client";
import { VaultSpender } from "../../src/lib/spend";
import { loadConfig, type McpConfig } from "./config";
import { loadOrCreateAgentKey } from "./keystore";
import { createHandlers, type ToolResult } from "./tools";

function keypair(seed: number) {
  const priv = new Uint8Array(32).fill(seed);
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { signer: new SignatureTemplate(priv), pubHex: binToHex(pub), address: encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }).address };
}
const owner = keypair(1);
const provider3 = keypair(3);
const stranger = keypair(8);
/** A custom payee (not one of Satchel's tools). */
const alice = keypair(5).address;
const SATCHEL_URL = "https://satchel.test";
const TOOL_URL = `${SATCHEL_URL}/api/tools/crypto-price`;

const text = (r: ToolResult) => r.content[0].text;
const json = (r: ToolResult) => JSON.parse(text(r));

/** A bch-sc402 provider that checks the payment on the mock chain, like Satchel's /api/tools route. */
function fakeNetwork(provider: NodeLikeProvider, opts: { payTo?: string; price?: number; network?: string; scheme?: string; failAfterPayment?: boolean; resource?: string; expiresInMs?: number } = {}) {
  const payTo = opts.payTo ?? provider3.address;
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === `${SATCHEL_URL}/api/config`) {
      return Response.json({ network: "mainnet", tools: [{ name: "crypto-price", title: "Crypto price feed", description: "d", price: "1000", payTo, params: { id: "CoinGecko coin id" } }] });
    }
    const header = new Headers(init?.headers).get("x-payment");
    if (!header) {
      const challenge: Challenge = { resource: opts.resource ?? new URL(url).pathname, payTo, amount: String(opts.price ?? 1000), nonce: binToHex(crypto.getRandomValues(new Uint8Array(16))), expires: Date.now() + (opts.expiresInMs ?? 600_000), network: opts.network ?? "mainnet", request: "aa".repeat(32), sig: "bb".repeat(32) };
      return Response.json({ error: "payment required", accepts: [{ scheme: opts.scheme ?? "bch-sc402", ...challenge }] }, { status: 402 });
    }
    const { challenge, txid } = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { challenge: Challenge; txid: string };
    const tx = decodeTransaction(hexToBin(await provider.getRawTransaction(txid)));
    if (typeof tx === "string") return Response.json({ error: "bad tx" }, { status: 402 });
    const pays = tx.outputs.some((o) => binToHex(o.lockingBytecode) === binToHex(lockingBytecodeOf(challenge.payTo)) && o.valueSatoshis >= BigInt(challenge.amount));
    const memo = tx.outputs.some((o) => binToHex(o.lockingBytecode).includes(memoForChallenge(challenge)));
    if (!pays || !memo) return Response.json({ error: "transaction does not pay" }, { status: 402 });
    if (opts.failAfterPayment) return Response.json({ error: "price source returned 503" }, { status: 502 });
    return Response.json({ result: { id: "bitcoin-cash", priceUsd: 208, body: init?.body ? JSON.parse(String(init.body)) : null } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

let cfg: McpConfig;
let provider: NodeLikeProvider;
beforeEach(() => {
  cfg = loadConfig({ SATCHEL_HOME: join(mkdtempSync(join(tmpdir(), "satchel-tools-")), "home"), SATCHEL_URL });
  provider = new NodeLikeProvider();
  provider.setBlockHeight(1000);
});

/** Owner creates a vault for this MCP's agent key; returns its connect code. */
async function createVault(
  opts: { cap?: bigint; agentPk?: string; network?: "mainnet" | "chipnet"; allowlist?: string[]; labels?: Record<string, string>; sellers?: string[] } = {},
) {
  const agentPk = opts.agentPk ?? loadOrCreateAgentKey(cfg).pubHex;
  const params: VaultParams = { ownerPk: owner.pubHex, agentPk, capPerPeriod: opts.cap ?? 8_000n, periodBlocks: 144n, allowlist: opts.allowlist ?? [provider3.address] };
  const contract = getVaultContract(params, provider);
  const u = provider.addUtxo(owner.address, { txid: binToHex(crypto.getRandomValues(new Uint8Array(32))), vout: 0, satoshis: 100_000n });
  await buildGenesis({ contract, inputs: [{ utxo: u, unlocker: owner.signer.unlockP2PKH() }], deposit: 20_000n, startHeight: 1000, changeAddress: owner.address }).builder.send();
  const info: ConnectInfo = {
    v: 1,
    network: opts.network ?? "mainnet",
    params: paramsToDescriptorParams(params),
    ...(opts.labels ? { labels: opts.labels } : {}),
    ...(opts.sellers ? { sellers: opts.sellers } : {}),
  };
  return { code: encodeConnectCode(info), contract };
}

function handlers(fetchFn: typeof fetch, spender = new VaultSpender()) {
  return createHandlers({ cfg, provider, fetch: fetchFn, spender });
}

describe("satchel_setup", () => {
  it("returns the agent key and a link to create the vault, never the private key", async () => {
    const h = handlers(fakeNetwork(provider).fetchFn);
    const r = await h.setup();
    const out = json(r);
    expect(out.agentPk).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(out.createVaultUrl).toBe(`${SATCHEL_URL}/?agent=${out.agentPk}`);
    expect(out.network).toBe("mainnet");
    const priv = JSON.parse((await import("node:fs")).readFileSync(join(cfg.home, "agent.json"), "utf8")).privateKey;
    expect(text(r)).not.toContain(priv);
  });
});

describe("satchel_connect", () => {
  it("connects a vault made for this agent and reports its balance", async () => {
    const { code } = await createVault();
    const r = await handlers(fakeNetwork(provider).fetchFn).connect(code);
    expect(r.isError).toBeFalsy();
    expect(json(r)).toMatchObject({ balance: "20000", capPerPeriod: "8000" });
  });

  it("rejects a code made for another agent key and stores nothing", async () => {
    const { code } = await createVault({ agentPk: stranger.pubHex });
    const r = await handlers(fakeNetwork(provider).fetchFn).connect(code);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/another agent key/);
    expect(existsSync(join(cfg.home, "vault-mainnet.json"))).toBe(false);
  });

  it("rejects a code for another network", async () => {
    const { code } = await createVault({ network: "chipnet" });
    const r = await handlers(fakeNetwork(provider).fetchFn).connect(code);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/chipnet/);
  });

  it("replaces a previously connected vault on the same network and names it", async () => {
    const first = await createVault();
    const second = await createVault({ cap: 9_000n }); // different settings, so a different contract address
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(first.code);
    const r = await h.connect(second.code);
    expect(r.isError).toBeFalsy();
    expect(json(r).replaced).toBe(first.contract.address);
  });
});

describe("satchel_pay_fetch", () => {
  it("pays the endpoint from the vault and returns its result with the txid", async () => {
    const { code, contract } = await createVault();
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(code);
    const r = await h.payFetch({ url: TOOL_URL, body: { id: "bitcoin-cash" } });
    expect(r.isError).toBeFalsy();
    const out = json(r);
    expect(out.result).toMatchObject({ priceUsd: 208, body: { id: "bitcoin-cash" } });
    expect(out.payment.txid).toMatch(/^[0-9a-f]{64}$/);
    const after = await findVaultUtxo(contract);
    expect(after!.satoshis).toBe(20_000n - 1_000n - BigInt(out.payment.fee));
  });

  it("does not pay a payee outside the vault allowlist", async () => {
    const { code } = await createVault();
    const h = handlers(fakeNetwork(provider, { payTo: stranger.address }).fetchFn);
    await h.connect(code);
    const before = provider.spent.size;
    const r = await h.payFetch({ url: TOOL_URL });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not in this vault's allowlist/);
    expect(provider.spent.size).toBe(before);
  });

  it("pays a challenge whose payTo is the token-aware (z…) form of an allowlisted payee", async () => {
    const { code } = await createVault();
    const zForm = encodeCashAddress({ prefix: "bchtest", type: "p2pkhWithTokens", payload: hash160(hexToBin(provider3.pubHex)) }).address;
    const h = handlers(fakeNetwork(provider, { payTo: zForm }).fetchFn);
    await h.connect(code);
    const r = await h.payFetch({ url: TOOL_URL });
    expect(r.isError).toBeFalsy();
  });

  it("does not pay more than SATCHEL_MAX_PRICE_SATS", async () => {
    const { code } = await createVault();
    const h = handlers(fakeNetwork(provider, { price: 6000 }).fetchFn);
    await h.connect(code);
    const before = provider.spent.size;
    const r = await h.payFetch({ url: TOOL_URL });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/exceeds SATCHEL_MAX_PRICE_SATS/);
    expect(provider.spent.size).toBe(before);
  });

  it("refuses a challenge for another network or scheme without paying", async () => {
    const { code } = await createVault();
    for (const opts of [{ network: "chipnet" }, { scheme: "exact" }]) {
      const h = handlers(fakeNetwork(provider, opts).fetchFn);
      await h.connect(code);
      const before = provider.spent.size;
      const r = await h.payFetch({ url: TOOL_URL });
      expect(r.isError).toBe(true);
      expect(provider.spent.size).toBe(before);
    }
  });

  it("reports the covenant's refusal when the period cap is reached", async () => {
    const { code } = await createVault({ cap: 2_000n });
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(code);
    expect((await h.payFetch({ url: TOOL_URL })).isError).toBeFalsy();
    const r = await h.payFetch({ url: TOOL_URL });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^The vault's covenant refused this payment/);
  });

  it("includes the txid when the endpoint keeps failing after the payment", async () => {
    const { code } = await createVault();
    const h = handlers(fakeNetwork(provider, { failAfterPayment: true }).fetchFn);
    await h.connect(code);
    const r = await h.payFetch({ url: TOOL_URL });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/[0-9a-f]{64}/);
    expect(text(r)).toMatch(/price source returned 503/);
  });

  it("does not pay an endpoint outside Satchel's origin (prompt-injected URL)", async () => {
    const { code } = await createVault();
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(code);
    const before = provider.spent.size;
    const r = await h.payFetch({ url: "https://evil.example/api/tools/crypto-price" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not an allowed payment origin/);
    expect(provider.spent.size).toBe(before);
  });

  it("pays an extra origin the user listed in SATCHEL_PAY_ORIGINS", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_PAY_ORIGINS: "https://other.test, https://more.test" });
    const { code } = await createVault();
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(code);
    expect((await h.payFetch({ url: "https://other.test/api/tools/crypto-price" })).isError).toBeFalsy();
  });

  it("does not pay a challenge issued for another resource (relayed challenge)", async () => {
    const { code } = await createVault();
    const h = handlers(fakeNetwork(provider, { resource: "/api/tools/deep-analysis" }).fetchFn);
    await h.connect(code);
    const before = provider.spent.size;
    const r = await h.payFetch({ url: TOOL_URL });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/another resource/);
    expect(provider.spent.size).toBe(before);
  });

  it("does not pay a challenge that is about to expire", async () => {
    const { code } = await createVault();
    const h = handlers(fakeNetwork(provider, { expiresInMs: 5_000 }).fetchFn);
    await h.connect(code);
    const r = await h.payFetch({ url: TOOL_URL });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/expire/);
  });

  it("serializes payments made in parallel", async () => {
    const { code } = await createVault();
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(code);
    const [a, b] = await Promise.all([h.payFetch({ url: TOOL_URL }), h.payFetch({ url: TOOL_URL })]);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
  });
});

describe("closed vault and status", () => {
  it("status reports budget, and both tools say the vault is closed after the owner withdrew", async () => {
    const { code, contract } = await createVault();
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(code);
    expect(json(await h.status())).toMatchObject({ balance: "20000", remaining: "8000" });
    const vaultUtxo = (await findVaultUtxo(contract))!;
    await buildWithdraw({ contract, vaultUtxo, to: owner.address, ownerSigner: owner.signer }).send();
    for (const r of [await h.status(), await h.payFetch({ url: TOOL_URL })]) {
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/vault is closed/);
    }
  });

  it("status and pay_fetch ask to connect first when no vault is connected", async () => {
    const h = handlers(fakeNetwork(provider).fetchFn);
    expect(text(await h.status())).toMatch(/satchel_setup/);
    expect((await h.payFetch({ url: TOOL_URL })).isError).toBe(true);
  });
});

describe("satchel_catalog", () => {
  it("lists Satchel's paid tools with their endpoint and whether the vault may pay them", async () => {
    const { code } = await createVault();
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(code);
    const out = json(await h.catalog());
    expect(out.tools[0]).toMatchObject({ name: "crypto-price", endpoint: TOOL_URL, price: "1000", allowed: true, params: { id: "CoinGecko coin id" } });
  });
});

describe("config", () => {
  it("reads SATCHEL_MAX_SEND_SATS (default 10000) and rejects a value that is not a whole number", () => {
    expect(loadConfig({ SATCHEL_HOME: cfg.home }).maxSendSats).toBe(10_000n);
    expect(loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_MAX_SEND_SATS: "2500" }).maxSendSats).toBe(2_500n);
    expect(() => loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_MAX_SEND_SATS: "1e4" })).toThrow(/SATCHEL_MAX_SEND_SATS/);
  });
});

describe("satchel_send", () => {
  // The mock chain uses chipnet (bchtest:) addresses, so sends that reach the chain run on chipnet.
  beforeEach(() => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_NETWORK: "chipnet" });
  });

  /** A vault whose allowlist has Satchel's tool payee plus a labelled custom payee (alice). */
  async function connectedWithAlice(fetchFn = fakeNetwork(provider).fetchFn) {
    const network = cfg.network;
    const { code, contract } = await createVault({ network, allowlist: [provider3.address, alice], labels: { [alice]: "Alice" } });
    const spender = new VaultSpender();
    const pay = vi.spyOn(spender, "pay");
    const h = handlers(fetchFn, spender);
    await h.connect(code);
    return { h, pay, contract };
  }

  it("pays an allowlisted custom payee and writes SATM + the memo in the tx", async () => {
    const { h, contract } = await connectedWithAlice();
    const r = await h.send({ to: alice, amountSats: 2_000, memo: "thanks" });
    expect(r.isError).toBeFalsy();
    const out = json(r);
    expect(out).toMatchObject({ to: alice, label: "Alice", amount: "2000", spentThisPeriod: expect.any(String), remaining: expect.any(String) });
    expect(out.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(out.explorer).toContain(out.txid);
    const tx = decodeTransaction(hexToBin(await provider.getRawTransaction(out.txid)));
    if (typeof tx === "string") throw new Error(tx);
    expect(binToHex(tx.outputs[1].lockingBytecode)).toBe(binToHex(lockingBytecodeOf(alice)));
    expect(tx.outputs[1].valueSatoshis).toBe(2_000n);
    const memoHex = binToHex(new TextEncoder().encode("SATMthanks"));
    expect(binToHex(tx.outputs[2].lockingBytecode)).toContain(memoHex);
    expect(tx.outputs[2].valueSatoshis).toBe(0n);
    const after = await findVaultUtxo(contract);
    expect(after!.satoshis).toBe(20_000n - 2_000n - BigInt(out.fee));
    expect(out.balance).toBe(after!.satoshis.toString());
  });

  it("accepts the token-aware (z…) form of an allowlisted payee and pays the allowlisted address", async () => {
    const { h } = await connectedWithAlice();
    const zForm = encodeCashAddress({ prefix: "bchtest", type: "p2pkhWithTokens", payload: hash160(hexToBin(keypair(5).pubHex)) }).address;
    const r = await h.send({ to: zForm, amountSats: 1_000 });
    expect(r.isError).toBeFalsy();
    expect(json(r)).toMatchObject({ to: alice, label: "Alice", amount: "1000" });
  });

  it("refuses an address outside the allowlist and never calls the spender", async () => {
    const { h, pay } = await connectedWithAlice();
    const r = await h.send({ to: stranger.address, amountSats: 1_000 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not in this vault's allowlist/);
    expect(pay).not.toHaveBeenCalled();
  });

  it("refuses an amount above SATCHEL_MAX_SEND_SATS", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_NETWORK: "chipnet", SATCHEL_MAX_SEND_SATS: "3000" });
    const { h, pay } = await connectedWithAlice();
    const r = await h.send({ to: alice, amountSats: 3_001 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/SATCHEL_MAX_SEND_SATS/);
    expect(pay).not.toHaveBeenCalled();
  });

  it("refuses a memo over 100 UTF-8 bytes even when its JS length is shorter (34 emoji = 136 bytes)", async () => {
    const { h, pay } = await connectedWithAlice();
    const memo = "😀".repeat(34);
    expect(memo.length).toBeLessThan(100);
    const r = await h.send({ to: alice, amountSats: 1_000, memo });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/100 bytes/);
    expect(pay).not.toHaveBeenCalled();
  });

  it("refuses a bchtest: address on mainnet, even one whose script is in the allowlist", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL });
    const { h, pay } = await connectedWithAlice();
    const r = await h.send({ to: alice, amountSats: 1_000 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/chipnet/);
    expect(pay).not.toHaveBeenCalled();
  });

  it("asks to connect first when no vault is connected", async () => {
    const r = await handlers(fakeNetwork(provider).fetchFn).send({ to: alice, amountSats: 1_000 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/satchel_setup/);
  });

  it("reports the covenant's refusal like satchel_pay_fetch", async () => {
    const { code } = await createVault({ network: "chipnet", cap: 2_000n, allowlist: [alice] });
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(code);
    const r = await h.send({ to: alice, amountSats: 2_500 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^The vault's covenant refused this payment/);
  });
});

describe("labels and sellers", () => {
  it("status lists the payees with the labels from the connect code", async () => {
    const { code } = await createVault({ allowlist: [provider3.address, alice], labels: { [alice]: "Alice" } });
    const h = handlers(fakeNetwork(provider).fetchFn);
    await h.connect(code);
    expect(json(await h.status()).payees).toEqual([
      { address: provider3.address, label: null },
      { address: alice, label: "Alice" },
    ]);
  });

  it("connect suggests the code's http(s) seller origins that SATCHEL_PAY_ORIGINS does not list yet", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_PAY_ORIGINS: "https://known.test" });
    const { code } = await createVault({ sellers: ["https://seller.test/shop", "https://known.test/x", "ftp://files.test/"] });
    const out = json(await handlers(fakeNetwork(provider).fetchFn).connect(code));
    expect(out.sellerOrigins).toEqual(["https://seller.test", "https://known.test"]);
    expect(out.addToPayOrigins).toEqual(["https://seller.test"]);
  });

  it("catalog lists Satchel's tools and reports a seller with invalid JSON or one that is down", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_PAY_ORIGINS: "https://broken.test,https://down.test" });
    const { code } = await createVault();
    const base = fakeNetwork(provider).fetchFn;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://broken.test/.well-known/satchel.json") return new Response("<html>not json", { status: 200 });
      if (url === "https://down.test/.well-known/satchel.json") throw new TypeError("fetch failed");
      return base(input, init);
    }) as typeof fetch;
    const h = handlers(fetchFn);
    await h.connect(code);
    const r = await h.catalog();
    expect(r.isError).toBeFalsy();
    const out = json(r);
    expect(out.tools[0]).toMatchObject({ name: "crypto-price", allowed: true });
    expect(out.sellers).toHaveLength(2);
    for (const [i, origin] of ["https://broken.test", "https://down.test"].entries()) {
      expect(out.sellers[i]).toMatchObject({ origin, ok: false, error: expect.any(String) });
      expect(out.sellers[i].tools).toBeUndefined();
    }
  });

  it("catalog lists a seller's tools; allowed only for payees in the vault allowlist", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_PAY_ORIGINS: "https://seller.test" });
    const { code } = await createVault({ allowlist: [provider3.address, alice] });
    const base = fakeNetwork(provider).fetchFn;
    const tool = (name: string, payTo: string) => ({ name, title: name, description: "d", price: "700", params: {}, payTo, endpoint: `https://seller.test/api/${name}` });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://seller.test/.well-known/satchel.json") {
        return Response.json({ name: "Seller", network: "mainnet", tools: [tool("weather", alice), tool("news", stranger.address)] });
      }
      return base(input, init);
    }) as typeof fetch;
    const h = handlers(fetchFn);
    await h.connect(code);
    const out = json(await h.catalog());
    expect(out.sellers[0]).toMatchObject({ origin: "https://seller.test", ok: true });
    expect(out.sellers[0].tools).toEqual([
      expect.objectContaining({ name: "weather", endpoint: "https://seller.test/api/weather", price: "700", allowed: true }),
      expect.objectContaining({ name: "news", allowed: false }),
    ]);
  });
});

describe("satchel_catalog hardening", () => {
  const sellerTool = (name: string, payTo: string, extra: Record<string, unknown> = {}) => ({ name, title: name, description: "d", price: "700", params: {}, payTo, endpoint: `https://seller.test/api/${name}`, ...extra });
  const withSeller = (base: typeof fetch, serve: () => Response | Promise<Response>) =>
    (async (input: string | URL | Request, init?: RequestInit) => (String(input) === "https://seller.test/.well-known/satchel.json" ? serve() : base(input, init))) as typeof fetch;

  it("still returns the seller results when Satchel's /api/config is down", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_PAY_ORIGINS: "https://seller.test" });
    const { code } = await createVault({ allowlist: [provider3.address, alice] });
    const base = fakeNetwork(provider).fetchFn;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === `${SATCHEL_URL}/api/config`) throw new TypeError("fetch failed");
      if (String(input) === "https://seller.test/.well-known/satchel.json") return Response.json({ name: "S", network: "mainnet", tools: [sellerTool("weather", alice)] });
      return base(input, init);
    }) as typeof fetch;
    const h = handlers(fetchFn);
    await h.connect(code);
    const r = await h.catalog();
    expect(r.isError).toBeFalsy();
    const out = json(r);
    expect(out.tools).toEqual([]);
    expect(out.satchelError).toEqual(expect.any(String));
    expect(out.sellers[0]).toMatchObject({ origin: "https://seller.test", ok: true });
  });

  it("reports a non-OK /api/config as satchelError", async () => {
    const { code } = await createVault();
    const fetchFn = (async (input: string | URL | Request) =>
      String(input) === `${SATCHEL_URL}/api/config` ? new Response("boom", { status: 500 }) : new Response("", { status: 404 })) as typeof fetch;
    const h = handlers(fetchFn);
    await h.connect(code).catch(() => undefined);
    const out = json(await h.catalog());
    expect(out.tools).toEqual([]);
    expect(out.satchelError).toMatch(/500/);
  });

  it("turns an oversize seller body into that seller's error", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_PAY_ORIGINS: "https://seller.test" });
    const { code } = await createVault();
    const big = JSON.stringify({ name: "S", network: "mainnet", tools: [], pad: "x".repeat(300_000) });
    const h = handlers(withSeller(fakeNetwork(provider).fetchFn, () => new Response(big)));
    await h.connect(code);
    const out = json(await h.catalog());
    expect(out.sellers[0]).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) });
  });

  it("rejects a seller catalog with too many tools or an overlong description", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_PAY_ORIGINS: "https://seller.test" });
    const { code } = await createVault({ allowlist: [provider3.address, alice] });
    const many = Array.from({ length: 51 }, (_, i) => sellerTool(`t${i}`, alice));
    let h = handlers(withSeller(fakeNetwork(provider).fetchFn, () => Response.json({ name: "S", network: "mainnet", tools: many })));
    await h.connect(code);
    expect(json(await h.catalog()).sellers[0]).toMatchObject({ ok: false, error: expect.stringMatching(/not a valid/) });
    h = handlers(withSeller(fakeNetwork(provider).fetchFn, () => Response.json({ name: "S", network: "mainnet", tools: [sellerTool("w", alice, { description: "y".repeat(501) })] })));
    expect(json(await h.catalog()).sellers[0]).toMatchObject({ ok: false });
  });

  it("carries payeeLabel for a seller tool whose payTo has a label in the connect code", async () => {
    cfg = loadConfig({ SATCHEL_HOME: cfg.home, SATCHEL_URL, SATCHEL_PAY_ORIGINS: "https://seller.test" });
    const { code } = await createVault({ allowlist: [provider3.address, alice], labels: { [alice]: "Alice" } });
    const h = handlers(withSeller(fakeNetwork(provider).fetchFn, () => Response.json({ name: "S", network: "mainnet", tools: [sellerTool("weather", alice), sellerTool("news", stranger.address)] })));
    await h.connect(code);
    const tools = json(await h.catalog()).sellers[0].tools;
    expect(tools[0]).toMatchObject({ name: "weather", payeeLabel: "Alice" });
    expect(tools[1].payeeLabel).toBeUndefined();
  });
});
