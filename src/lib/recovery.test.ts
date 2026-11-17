import { describe, it, expect } from "vitest";
import { MockNetworkProvider, SignatureTemplate, randomUtxo } from "cashscript";
import { binToHex, encodeCashAddress, flattenBinArray, hash160, hexToBin, secp256k1, utf8ToBin } from "@bitauth/libauth";
import { buildGenesis, getVaultContract, type VaultParams } from "./vault";
import { decodeRecoveryMemo, encodeRecoveryMemo, findVaultsInTransactions, MAX_RECOVERY_PAYLOAD, recoveryPayloadSize } from "./recovery";

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

  it("refuses to encode an allowlist entry that is not a valid address", () => {
    expect(() => encodeRecoveryMemo({ ...params, allowlist: ["hello"] }, AGENT_INDEX, KNOWN)).toThrow(/not a valid BCH address/);
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
    expect(decodeRecoveryMemo(new Uint8Array([0x6a, 0x04, 0x53, 0x54, 0x43, 0x48]), owner.pubHex, KNOWN, "chipnet")).toBeNull();
    expect(decodeRecoveryMemo(new Uint8Array([0x51]), owner.pubHex, KNOWN, "chipnet")).toBeNull();
  });

  const p2pkh = (b: number) => encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: new Uint8Array(20).fill(b) }).address;
  const p2sh20 = (b: number) => encodeCashAddress({ prefix: "bchtest", type: "p2sh", payload: new Uint8Array(20).fill(b) }).address;
  const p2sh32 = (b: number) => encodeCashAddress({ prefix: "bchtest", type: "p2sh", payload: new Uint8Array(32).fill(b) }).address;
  const mixed: VaultParams = { ...params, allowlist: [apiB.address, p2pkh(0x11), p2sh20(0x22), p2sh32(0x33)] };

  it("v2 round-trips known indexes, P2PKH, P2SH20 and P2SH32 payees", () => {
    const chunks = encodeRecoveryMemo(mixed, AGENT_INDEX, KNOWN);
    const script = hexToBin("6a" + "04" + binToHex(utf8ToBin("STCH")) + "4c" + ((chunks[1].length - 2) / 2).toString(16).padStart(2, "0") + chunks[1].slice(2));
    const memo = decodeRecoveryMemo(script, owner.pubHex, KNOWN, "chipnet");
    expect(memo?.params.allowlist).toEqual(mixed.allowlist);
    expect(memo?.params.capPerPeriod).toBe(8_000n);
    expect(memo?.params.periodBlocks).toBe(144n);
    expect(memo?.agentIndex).toBe(AGENT_INDEX);
  });

  it("v1 memos still decode", () => {
    const le = (v: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (v >> (8 * i)) & 0xff);
    const payload = flattenBinArray([
      Uint8Array.of(1), le(AGENT_INDEX, 4), hexToBin(agent.pubHex), le(8000, 8), le(144, 4), Uint8Array.of(2, 2, 0),
    ]);
    const script = flattenBinArray([Uint8Array.of(0x6a, 4), utf8ToBin("STCH"), Uint8Array.of(payload.length), payload]);
    const memo = decodeRecoveryMemo(script, owner.pubHex, KNOWN, "chipnet");
    expect(memo?.params.allowlist).toEqual([apiC.address, apiA.address]);
    expect(memo?.agentIndex).toBe(AGENT_INDEX);
  });

  it("payload over 215 bytes throws", () => {
    const many = Array.from({ length: 8 }, (_, i) => p2sh32(i + 1));
    expect(recoveryPayloadSize(many, KNOWN)).toBeGreaterThan(MAX_RECOVERY_PAYLOAD);
    expect(() => encodeRecoveryMemo({ ...params, allowlist: many }, AGENT_INDEX, KNOWN)).toThrow(/too many custom payees/);
  });

  it("PUSHDATA1 payload is parsed", () => {
    const p = { ...mixed };
    const chunks = encodeRecoveryMemo(p, AGENT_INDEX, KNOWN);
    expect((chunks[1].length - 2) / 2).toBeGreaterThan(75);
    const hex = genesisHex(p, chunks);
    const found = findVaultsInTransactions([{ txid: "ab".repeat(32), hex }], owner.pubHex, KNOWN, new MockNetworkProvider());
    expect(found).toHaveLength(1);
    expect(found[0].params).toEqual(p);
  });

  it("a memo whose rebuilt contract does not match is ignored (v2)", () => {
    const lying = encodeRecoveryMemo({ ...mixed, agentPk: stranger.pubHex }, AGENT_INDEX, KNOWN);
    const hex = genesisHex(mixed, lying);
    expect(findVaultsInTransactions([{ txid: "cd".repeat(32), hex }], owner.pubHex, KNOWN, new MockNetworkProvider())).toEqual([]);
  });
});
