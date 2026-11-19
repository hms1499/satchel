import { describe, it, expect, beforeEach } from "vitest";
import { Contract, MockNetworkProvider, SignatureTemplate, randomUtxo } from "cashscript";
import { binToHex, decodeTransaction, encodeCashAddress, hash160, hexToBin, secp256k1 } from "@bitauth/libauth";
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
import { allowlistHash, canStartNewPeriod } from "./vault";
import artifact from "./contract/Satchel.artifact.json";

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
      coinHeight: START,
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

  it("starts a new period only with a cooldown sequence: newPeriod with sequence 0 fails CSV", async () => {
    await expect(spend({ overrideNewPeriod: true, overrideSequence: 0 }).builder.send()).rejects.toThrow(/this\.age >= periodBlocks/);
  });

  it("a new-period spend always carries sequence >= periodBlocks (BIP68 makes it unminable before the cooldown)", () => {
    const { builder, newPeriod } = spend({ coinHeight: START, tipHeight: START + 144 });
    expect(newPeriod).toBe(true);
    const tx = decodeTransaction(hexToBin(builder.build()));
    if (typeof tx === "string") throw new Error(tx);
    expect(tx.version).toBe(2);
    expect(tx.inputs[0].sequenceNumber).toBe(144);
  });

  it("regression 2026-11-19: an old locktime no longer rolls a period", async () => {
    // The audit's burst: the vault was idle for 5 periods and the agent chains spends with old locktimes.
    ctx.provider.setBlockHeight(START + 5 * 144);
    let accepted = 0n;
    for (let k = 1; k <= 5; k++) {
      const { builder, outflow } = spend({ tipHeight: START + k * 144, overrideNewPeriod: false });
      try {
        await builder.send();
      } catch (e) {
        expect(String(e)).toMatch(/newSpent <= capPerPeriod/);
        break;
      }
      accepted += outflow;
      ctx.vaultUtxo = (await findVaultUtxo(ctx.contract))!;
    }
    expect(accepted).toBeGreaterThan(0n);
    expect(accepted).toBeLessThanOrEqual(10_000n);
  });

  it("rejects extra outputs (e.g. siphoning change to the attacker)", async () => {
    await expect(spend({ extraOutputs: [{ to: attacker.address, amount: 1_000n }] }).builder.send()).rejects.toThrow(/outputs\[2\]\.value == 0/);
    await expect(
      spend({ memo: "00", extraOutputs: [{ to: attacker.address, amount: 1_000n }] }).builder.send(),
    ).rejects.toThrow(/outputs\.length == 2/);
  });

  it("resets the budget after the cooldown", async () => {
    await spend({ amount: 9_000n }).builder.send();
    ctx.vaultUtxo = (await findVaultUtxo(ctx.contract))!;
    await expect(spend({ amount: 2_000n }).builder.send()).rejects.toThrow(/newSpent <= capPerPeriod/);

    const tip = START + 143; // the next block is START + 144: the coin is 144 blocks old there
    ctx.provider.setBlockHeight(tip);
    const { builder, outflow, newPeriod } = spend({ amount: 2_000n, tipHeight: tip });
    expect(newPeriod).toBe(true);
    await builder.send();
    const next = (await findVaultUtxo(ctx.contract))!;
    expect(decodeState(next.token!.nft!.commitment)).toEqual({ periodStart: tip, spent: outflow });
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

describe("sliding-window budget math", () => {
  const params = { capPerPeriod: 10_000n, periodBlocks: 144n };
  const state = { periodStart: START, spent: 4_000n };

  it("canStartNewPeriod needs a confirmed coin that is periodBlocks old at the next block", () => {
    expect(canStartNewPeriod(0, START + 1_000, 144n)).toBe(false);
    expect(canStartNewPeriod(START, START + 142, 144n)).toBe(false);
    expect(canStartNewPeriod(START, START + 143, 144n)).toBe(true);
  });

  it("an unconfirmed coin: no reset known yet, budget = cap - spent", () => {
    expect(remainingBudget(state, 0, START + 500, params)).toEqual({ remaining: 6_000n, resetsAtHeight: null });
  });

  it("a confirmed coin before the cooldown ends", () => {
    expect(remainingBudget(state, START, START + 142, params)).toEqual({ remaining: 6_000n, resetsAtHeight: START + 143 });
  });

  it("a confirmed coin after the cooldown: the full cap", () => {
    expect(remainingBudget(state, START, START + 143, params).remaining).toBe(10_000n);
  });

  it("getVaultContract rejects periodBlocks outside 1..65535", () => {
    const base: VaultParams = { ownerPk: owner.pubHex, agentPk: agent.pubHex, capPerPeriod: 1n, periodBlocks: 0n, allowlist: [apiA.address] };
    const provider = new MockNetworkProvider();
    expect(() => getVaultContract(base, provider)).toThrow("periodBlocks must be between 1 and 65535");
    expect(() => getVaultContract({ ...base, periodBlocks: 65_536n }, provider)).toThrow("periodBlocks must be between 1 and 65535");
  });
});

describe("the covenant itself enforces the cooldown", () => {
  /** A vault built WITHOUT getVaultContract's off-chain range check, as an attacker-crafted descriptor could. */
  async function rawVault(periodBlocks: bigint) {
    const provider = new MockNetworkProvider();
    provider.setBlockHeight(START);
    const params: VaultParams = { ownerPk: owner.pubHex, agentPk: agent.pubHex, capPerPeriod: 10_000n, periodBlocks, allowlist: [apiA.address] };
    const contract = new Contract(
      artifact,
      [hexToBin(owner.pubHex), hexToBin(agent.pubHex), 10_000n, periodBlocks, allowlistHash(params.allowlist)],
      { provider, contractType: "p2sh32" },
    ) as unknown as ReturnType<typeof getVaultContract>;
    const funding = provider.addUtxo(owner.address, randomUtxo({ satoshis: 200_000n, vout: 0 }));
    await buildGenesis({ contract, inputs: [{ utxo: funding, unlocker: owner.signer.unlockP2PKH() }], deposit: 50_000n, startHeight: START, changeAddress: owner.address }).builder.send();
    return { contract, params, vaultUtxo: (await findVaultUtxo(contract))! };
  }
  const newPeriodSpend = (v: Awaited<ReturnType<typeof rawVault>>, sequence: number) =>
    buildAgentSpend({ ...v, agentKey: agent.signer, to: apiA.address, amount: 2_000n, tipHeight: START, coinHeight: START, overrideNewPeriod: true, overrideSequence: sequence });

  it("periodBlocks 0 would make every spend a new period: rejected on-chain", async () => {
    await expect(newPeriodSpend(await rawVault(0n), 0).builder.send()).rejects.toThrow(/periodBlocks >= 1/);
  });

  it("periodBlocks 65536 (masked to 0 by BIP68) is rejected on-chain", async () => {
    await expect(newPeriodSpend(await rawVault(65_536n), 0).builder.send()).rejects.toThrow(/periodBlocks <= 65535/);
  });

  it("periodBlocks with the disable flag (2^31 + 144) is rejected on-chain", async () => {
    await expect(newPeriodSpend(await rawVault(2n ** 31n + 144n), 0).builder.send()).rejects.toThrow(/periodBlocks <= 65535/);
  });
});

describe("crafted sequences cannot satisfy the cooldown early", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });
  const crafted = (sequence: number) =>
    buildAgentSpend({ contract: ctx.contract, params: ctx.params, vaultUtxo: ctx.vaultUtxo, agentKey: agent.signer, to: apiA.address, amount: 2_000n, tipHeight: START, coinHeight: START, overrideNewPeriod: true, overrideSequence: sequence });

  for (const [name, sequence] of [
    ["disable flag set (bit 31)", 0x80000090],
    ["time-based type flag (bit 22)", 0x00400090],
    ["one block short", 0x8f],
    ["high bits but short in the low 16 bits", 0x1008f],
  ] as const) {
    it(`sequence ${name} fails require(this.age >= periodBlocks)`, async () => {
      await expect(crafted(sequence).builder.send()).rejects.toThrow(/this\.age >= periodBlocks/);
    });
  }
});
