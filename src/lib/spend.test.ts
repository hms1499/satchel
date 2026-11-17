import { describe, it, expect } from "vitest";
import { SignatureTemplate, randomUtxo } from "cashscript";
import { binToHex, encodeCashAddress, hash160, secp256k1 } from "@bitauth/libauth";
import { NodeLikeProvider } from "./test-utils/node-like-provider";
import { buildGenesis, findVaultUtxo, getVaultContract, type VaultParams } from "./vault";
import { VaultSpender, type SpendTarget } from "./spend";
import { parseChallenge } from "./x402-client";

function keypair(seed: number) {
  const priv = new Uint8Array(32).fill(seed);
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { signer: new SignatureTemplate(priv), pubHex: binToHex(pub), address: encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }).address };
}
const owner = keypair(1);
const agent = keypair(2);
const payee = keypair(3);

async function vault(): Promise<SpendTarget & { provider: NodeLikeProvider }> {
  const provider = new NodeLikeProvider();
  provider.setBlockHeight(1000);
  const params: VaultParams = { ownerPk: owner.pubHex, agentPk: agent.pubHex, capPerPeriod: 8_000n, periodBlocks: 144n, allowlist: [payee.address] };
  const contract = getVaultContract(params, provider);
  const u = provider.addUtxo(owner.address, randomUtxo({ satoshis: 100_000n, vout: 0 }));
  await buildGenesis({ contract, inputs: [{ utxo: u, unlocker: owner.signer.unlockP2PKH() }], deposit: 20_000n, startHeight: 1000, changeAddress: owner.address }).builder.send();
  return { contract, params, agentSigner: agent.signer, provider };
}

describe("VaultSpender", () => {
  it("two VaultSpender instances do not share their successor cache", async () => {
    const t = await vault();
    const a = new VaultSpender();
    const b = new VaultSpender();
    const genesisView = [t.contract.address, t.contract.tokenAddress];
    // Freeze Electrum's view at the genesis vault UTXO, then A pays (A caches its successor).
    await t.provider.freeze(genesisView, 0);
    expect((await a.pay(t, payee.address, 1000n)).ok).toBe(true);
    t.provider.lagCalls = 1000;
    // B has no cache: its stale spend conflicts and it ends up "busy"; A still knows its successor and pays.
    const fromB = await b.pay(t, payee.address, 1000n);
    expect(fromB.ok).toBe(false);
    if (!fromB.ok) expect(fromB.reason).toMatch(/busy/i);
    expect((await a.pay(t, payee.address, 1000n)).ok).toBe(true);
  });

  it("falls back to the network's vault UTXO when its own last broadcast was dropped", async () => {
    const t = await vault();
    const genesis = (await findVaultUtxo(t.contract))!;
    const spender = new VaultSpender();
    const first = await spender.pay(t, payee.address, 1000n);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The broadcast never propagated: the network forgets it and still has the genesis vault UTXO.
    t.provider.dropped.add(`${first.txid}:0`);
    t.provider.spent.delete(`${genesis.txid}:${genesis.vout}`);
    t.provider.addUtxo(t.contract.tokenAddress, genesis);
    await t.provider.freeze([t.contract.address, t.contract.tokenAddress], 0);
    t.provider.stale.set(t.contract.address, [genesis]);
    t.provider.lagCalls = 1000;
    expect((await spender.pay(t, payee.address, 1000n)).ok).toBe(true);
  });
});

describe("parseChallenge", () => {
  const challenge = { resource: "/api/tools/crypto-price", payTo: payee.address, amount: "1000", nonce: "ab".repeat(16), expires: Date.now() + 60_000, network: "mainnet", request: "cd".repeat(32), sig: "ef".repeat(32) };

  it("parseChallenge accepts a bch-sc402 challenge for the network", () => {
    const r = parseChallenge({ error: "payment required", accepts: [{ scheme: "bch-sc402", ...challenge }] }, "mainnet");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.challenge.payTo).toBe(payee.address);
  });

  it("parseChallenge refuses another scheme", () => {
    expect(parseChallenge({ accepts: [{ scheme: "exact", ...challenge }] }, "mainnet")).toEqual({ ok: false, error: "unsupported payment scheme" });
  });

  it("parseChallenge refuses another network", () => {
    expect(parseChallenge({ accepts: [{ scheme: "bch-sc402", ...challenge, network: "chipnet" }] }, "mainnet")).toEqual({ ok: false, error: "challenge is for chipnet, expected mainnet" });
  });

  it("parseChallenge refuses a body without a challenge", () => {
    expect(parseChallenge({ error: "nope" }, "mainnet")).toEqual({ ok: false, error: "no payment challenge in the 402 response" });
  });
});
