import { describe, it, expect, beforeEach } from "vitest";
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
const SATCHEL_URL = "https://satchel.test";
const TOOL_URL = `${SATCHEL_URL}/api/tools/crypto-price`;

const text = (r: ToolResult) => r.content[0].text;
const json = (r: ToolResult) => JSON.parse(text(r));

/** A bch-sc402 provider that checks the payment on the mock chain, like Satchel's /api/tools route. */
function fakeNetwork(provider: NodeLikeProvider, opts: { payTo?: string; price?: number; network?: string; scheme?: string; failAfterPayment?: boolean } = {}) {
  const payTo = opts.payTo ?? provider3.address;
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === `${SATCHEL_URL}/api/config`) {
      return Response.json({ network: "mainnet", tools: [{ name: "crypto-price", title: "Crypto price feed", description: "d", price: "1000", payTo }] });
    }
    const header = new Headers(init?.headers).get("x-payment");
    if (!header) {
      const challenge: Challenge = { resource: "/api/tools/crypto-price", payTo, amount: String(opts.price ?? 1000), nonce: binToHex(crypto.getRandomValues(new Uint8Array(16))), expires: Date.now() + 600_000, network: opts.network ?? "mainnet", request: "aa".repeat(32), sig: "bb".repeat(32) };
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
async function createVault(opts: { cap?: bigint; agentPk?: string; network?: "mainnet" | "chipnet" } = {}) {
  const agentPk = opts.agentPk ?? loadOrCreateAgentKey(cfg).pubHex;
  const params: VaultParams = { ownerPk: owner.pubHex, agentPk, capPerPeriod: opts.cap ?? 8_000n, periodBlocks: 144n, allowlist: [provider3.address] };
  const contract = getVaultContract(params, provider);
  const u = provider.addUtxo(owner.address, { txid: binToHex(crypto.getRandomValues(new Uint8Array(32))), vout: 0, satoshis: 100_000n });
  await buildGenesis({ contract, inputs: [{ utxo: u, unlocker: owner.signer.unlockP2PKH() }], deposit: 20_000n, startHeight: 1000, changeAddress: owner.address }).builder.send();
  const info: ConnectInfo = { v: 1, network: opts.network ?? "mainnet", params: paramsToDescriptorParams(params) };
  return { code: encodeConnectCode(info), contract };
}

function handlers(fetchFn: typeof fetch) {
  return createHandlers({ cfg, provider, fetch: fetchFn, spender: new VaultSpender() });
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
    expect(out.tools[0]).toMatchObject({ name: "crypto-price", endpoint: TOOL_URL, price: "1000", allowed: true });
  });
});
