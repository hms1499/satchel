import { describe, it, expect, beforeEach } from "vitest";
import { MockNetworkProvider, SignatureTemplate, randomUtxo } from "cashscript";
import { binToHex, encodeCashAddress, hash160, secp256k1 } from "@bitauth/libauth";
import {
  buildAgentSpend,
  buildGenesis,
  buildWithdraw,
  decodeState,
  findVaultUtxo,
  getVaultContract,
  remainingBudget,
  type VaultParams,
} from "./vault";

function keypair(seed: number) {
  const priv = new Uint8Array(32).fill(seed);
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const address = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }).address;
  return { signer: new SignatureTemplate(priv), pubHex: binToHex(pub), address };
}

const owner = keypair(1);
const agent = keypair(2);
const apiA = keypair(3);
const apiB = keypair(4);
const attacker = keypair(5);

const START = 1000;

async function setup(cap = 10_000n, periodBlocks = 144n) {
  const provider = new MockNetworkProvider();
  provider.setBlockHeight(START);
  const params: VaultParams = {
    ownerPk: owner.pubHex,
    agentPk: agent.pubHex,
    capPerPeriod: cap,
    periodBlocks,
    allowlist: [apiA.address, apiB.address],
  };
  // network prefix used by the mock provider is chipnet (bchtest)
  const contract = getVaultContract(params, provider);
  const fundingUtxo = provider.addUtxo(owner.address, randomUtxo({ satoshis: 200_000n, vout: 0 }));
  const { builder, category } = buildGenesis({
    contract,
    inputs: [{ utxo: fundingUtxo, unlocker: owner.signer.unlockP2PKH() }],
    deposit: 50_000n,
    startHeight: START,
    changeAddress: owner.address,
  });
  await builder.send();
  const vaultUtxo = (await findVaultUtxo(contract))!;
  return { provider, params, contract, vaultUtxo, category };
}

describe("Satchel covenant", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  const spend = (overrides: Partial<Parameters<typeof buildAgentSpend>[0]> = {}) =>
    buildAgentSpend({
      contract: ctx.contract,
      params: ctx.params,
      vaultUtxo: ctx.vaultUtxo,
      agentKey: agent.signer,
      to: apiA.address,
      amount: 2_000n,
      tipHeight: START,
      ...overrides,
    });

  it("genesis creates a vault UTXO with a mutable state NFT", () => {
    expect(ctx.vaultUtxo.satoshis).toBe(50_000n);
    expect(ctx.vaultUtxo.token?.category).toBe(ctx.category);
    expect(decodeState(ctx.vaultUtxo.token!.nft!.commitment)).toEqual({ periodStart: START, spent: 0n });
  });

  it("lets the agent pay an allowlisted recipient and records the outflow", async () => {
    const { builder, outflow } = spend({ memo: "a1b2c3" });
    await builder.send();
    const next = (await findVaultUtxo(ctx.contract))!;
    expect(next.satoshis).toBe(50_000n - outflow);
    expect(decodeState(next.token!.nft!.commitment)).toEqual({ periodStart: START, spent: outflow });
  });

  it("rejects a spend that would exceed the period cap", async () => {
    await spend({ amount: 4_000n }).builder.send();
    ctx.vaultUtxo = (await findVaultUtxo(ctx.contract))!;
    await spend({ amount: 4_000n }).builder.send();
    ctx.vaultUtxo = (await findVaultUtxo(ctx.contract))!;
    // ~8.6k spent of 10k; another 2k must fail
    await expect(spend({ amount: 2_000n }).builder.send()).rejects.toThrow(/newSpent <= capPerPeriod/);
  });

  it("rejects payments to a non-allowlisted address", async () => {
    await expect(spend({ to: attacker.address, overrideRecipientIndex: 0 }).builder.send()).rejects.toThrow(/lockingBytecode\) == entry/);
  });

  it("blames the allowlist, not the cap, for a non-allowlisted payment when the budget is also used up", async () => {
    // The payee rule is checked before the budget rule, so the demo always shows why an attacker payment fails.
    await spend({ amount: 4_000n }).builder.send();
    ctx.vaultUtxo = (await findVaultUtxo(ctx.contract))!;
    await spend({ amount: 4_000n }).builder.send();
    ctx.vaultUtxo = (await findVaultUtxo(ctx.contract))!;
    await expect(spend({ to: attacker.address, amount: 2_000n, overrideRecipientIndex: 0 }).builder.send()).rejects.toThrow(
      /lockingBytecode\) == entry/,
    );
  });

  it("rejects an agent that lies about the spent counter", async () => {
    await expect(spend({ overrideNextState: { periodStart: START, spent: 0n } }).builder.send()).rejects.toThrow(/nftCommitment ==/);
  });

  it("rejects an agent that fakes a new period early", async () => {
    await expect(
      spend({ overrideNextState: { periodStart: START + 144, spent: 2_302n } }).builder.send(),
    ).rejects.toThrow(/nftCommitment ==/);
  });

  it("rejects extra outputs (e.g. siphoning change to the attacker)", async () => {
    await expect(spend({ extraOutputs: [{ to: attacker.address, amount: 1_000n }] }).builder.send()).rejects.toThrow(/outputs\[2\]\.value == 0/);
    await expect(
      spend({ memo: "00", extraOutputs: [{ to: attacker.address, amount: 1_000n }] }).builder.send(),
    ).rejects.toThrow(/outputs\.length == 2/);
  });

  it("resets the budget once the period has passed", async () => {
    await spend({ amount: 9_000n }).builder.send();
    ctx.vaultUtxo = (await findVaultUtxo(ctx.contract))!;
    await expect(spend({ amount: 2_000n }).builder.send()).rejects.toThrow(/newSpent <= capPerPeriod/);

    const later = START + 144;
    ctx.provider.setBlockHeight(later);
    const { builder, outflow } = spend({ amount: 2_000n, tipHeight: later });
    await builder.send();
    const next = (await findVaultUtxo(ctx.contract))!;
    expect(decodeState(next.token!.nft!.commitment)).toEqual({ periodStart: later, spent: outflow });
    expect(remainingBudget(decodeState(next.token!.nft!.commitment), later, ctx.params).remaining).toBe(10_000n - outflow);
  });

  it("lets the owner withdraw everything", async () => {
    await buildWithdraw({ contract: ctx.contract, vaultUtxo: ctx.vaultUtxo, to: owner.address, ownerSigner: owner.signer }).send();
    expect(await findVaultUtxo(ctx.contract)).toBeUndefined();
  });

  it("does not let the agent use the owner path", async () => {
    await expect(
      buildWithdraw({ contract: ctx.contract, vaultUtxo: ctx.vaultUtxo, to: attacker.address, ownerSigner: agent.signer }).send(),
    ).rejects.toThrow(/checkSig\(ownerSig, ownerPk\)/);
  });
});

describe("findVaultUtxo", () => {
  it("skips outpoints it is told are already spent", async () => {
    const ctx = await setup();
    const key = `${ctx.vaultUtxo.txid}:${ctx.vaultUtxo.vout}`;
    expect(await findVaultUtxo(ctx.contract, new Set([key]))).toBeUndefined();
    expect((await findVaultUtxo(ctx.contract))?.txid).toBe(ctx.vaultUtxo.txid);
  });
});
