import { describe, it, expect } from "vitest";
import { MockNetworkProvider, SignatureTemplate, randomUtxo } from "cashscript";
import { binToHex, encodeCashAddress, hash160, secp256k1 } from "@bitauth/libauth";
import { buildGenesis, getVaultContract, type VaultParams } from "./vault";
import { decodeRecoveryMemo, encodeRecoveryMemo, findVaultsInTransactions } from "./recovery";

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
const apiC = keypair(5);
const stranger = keypair(6);
const KNOWN = [apiA.address, apiB.address, apiC.address];
const AGENT_INDEX = 1_234_567_890;

const params: VaultParams = {
  ownerPk: owner.pubHex,
  agentPk: agent.pubHex,
  capPerPeriod: 8_000n,
  periodBlocks: 144n,
  allowlist: [apiC.address, apiA.address], // a subset, not in catalog order
};

function genesisHex(p: VaultParams, memo: string[] | undefined, signer = owner) {
  const provider = new MockNetworkProvider();
  const contract = getVaultContract(p, provider);
  const utxo = provider.addUtxo(signer.address, randomUtxo({ satoshis: 100_000n, vout: 0 }));
  const { builder } = buildGenesis({
    contract,
    inputs: [{ utxo, unlocker: signer.signer.unlockP2PKH() }],
    deposit: 20_000n,
    startHeight: 1000,
    changeAddress: signer.address,
    opReturn: memo,
  });
  return builder.build();
}

describe("recovery memo", () => {
  it("round-trips agent index, agent key, cap, period and the allowlist order", () => {
    const chunks = encodeRecoveryMemo(params, AGENT_INDEX, KNOWN);
    const hex = genesisHex(params, chunks);
    const found = findVaultsInTransactions([{ txid: "aa".repeat(32), hex }], owner.pubHex, KNOWN, new MockNetworkProvider());
    expect(found).toHaveLength(1);
    expect(found[0].agentIndex).toBe(AGENT_INDEX);
    expect(found[0].params).toEqual(params);
    expect(found[0].genesisTxid).toBe("aa".repeat(32));
  });

  it("refuses to encode an allowlist entry that is not in the known payee list", () => {
    expect(() => encodeRecoveryMemo({ ...params, allowlist: [stranger.address] }, AGENT_INDEX, KNOWN)).toThrow(/not a known payee/);
  });

  it("ignores a memo that does not match the vault output (tampered agent key)", () => {
    // The vault is really for `agent`, but the memo claims `stranger` is the agent.
    const lying = encodeRecoveryMemo({ ...params, agentPk: stranger.pubHex }, AGENT_INDEX, KNOWN);
    const hex = genesisHex(params, lying);
    expect(findVaultsInTransactions([{ txid: "bb".repeat(32), hex }], owner.pubHex, KNOWN, new MockNetworkProvider())).toEqual([]);
  });

  it("ignores vaults that belong to another owner", () => {
    const theirs: VaultParams = { ...params, ownerPk: stranger.pubHex };
    const hex = genesisHex(theirs, encodeRecoveryMemo(theirs, AGENT_INDEX, KNOWN), stranger);
    expect(findVaultsInTransactions([{ txid: "cc".repeat(32), hex }], owner.pubHex, KNOWN, new MockNetworkProvider())).toEqual([]);
  });

  it("ignores ordinary transactions and genesis transactions without a memo", () => {
    const hex = genesisHex(params, undefined);
    expect(findVaultsInTransactions([{ txid: "dd".repeat(32), hex }, { txid: "ee".repeat(32), hex: "00" }], owner.pubHex, KNOWN, new MockNetworkProvider())).toEqual([]);
  });

  it("decodes only well-formed memos", () => {
    expect(decodeRecoveryMemo(new Uint8Array([0x6a, 0x04, 0x53, 0x54, 0x43, 0x48]), owner.pubHex, KNOWN)).toBeNull();
    expect(decodeRecoveryMemo(new Uint8Array([0x51]), owner.pubHex, KNOWN)).toBeNull();
  });
});
