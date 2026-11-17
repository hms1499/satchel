import { describe, it, expect } from "vitest";
import { MockNetworkProvider, placeholderP2PKHUnlocker, randomUtxo } from "cashscript";
import {
  binToHex,
  createVirtualMachineBch,
  decodeTransaction,
  encodeCashAddress,
  encodeDataPush,
  encodeTransaction,
  generateSigningSerializationBch,
  hash160,
  hash256,
  hexToBin,
  secp256k1,
  type Output,
} from "@bitauth/libauth";
import { parseExtendedJson } from "@wizardconnect/core";
import { buildGenesis, buildWithdraw, findVaultUtxo, getVaultContract, type VaultParams } from "./vault";
import { toRelaySignRequest } from "./wc-relay";

function keypair(seed: number) {
  const pub = secp256k1.derivePublicKeyCompressed(privateKeyOf(seed)) as Uint8Array;
  const address = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }).address;
  return { pubHex: binToHex(pub), address };
}

function privateKeyOf(seed: number) {
  return new Uint8Array(32).fill(seed);
}

/**
 * Mirrors Cashonize's WizardConnect signer (cashonize-quasar src/utils/dapp/wizSigning.ts + signInput.ts):
 * an input whose source output has `contract.artifact.contractName` gets the 65-byte signature placeholder in
 * its provided unlocking bytecode replaced; any other input listed in inputPaths is signed as plain P2PKH.
 * Signatures use SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID (0x61) over the redeem script / locking bytecode.
 */
function signLikeCashonize(relayJson: string, nativeSourceOutputs: Output[], privateKey: Uint8Array): Uint8Array {
  const relay = JSON.parse(relayJson) as { transaction: string; sourceOutputs: { unlockingBytecode: string; lockingBytecode: string; contract?: { artifact?: { contractName?: string }; redeemScript?: string } }[] };
  const transaction = decodeTransaction(hexToBin(relay.transaction));
  if (typeof transaction === "string") throw new Error(transaction);
  const pubkey = secp256k1.derivePublicKeyCompressed(privateKey) as Uint8Array;
  const hashType = 0x61;
  const sign = (inputIndex: number, coveredBytecode: Uint8Array) => {
    const preimage = generateSigningSerializationBch(
      { inputIndex, sourceOutputs: nativeSourceOutputs, transaction },
      { coveredBytecode, signingSerializationType: Uint8Array.of(hashType) },
    );
    const sig = secp256k1.signMessageHashSchnorr(privateKey, hash256(preimage));
    if (typeof sig === "string") throw new Error(sig);
    return Uint8Array.from([...sig, hashType]);
  };
  relay.sourceOutputs.forEach((so, i) => {
    if (so.contract?.artifact?.contractName) {
      const placeholder = "41" + "00".repeat(65);
      const signature = sign(i, hexToBin(so.contract.redeemScript!));
      transaction.inputs[i].unlockingBytecode = hexToBin(so.unlockingBytecode.replace(placeholder, "41" + binToHex(signature)));
    } else {
      const signature = sign(i, hexToBin(so.lockingBytecode));
      transaction.inputs[i].unlockingBytecode = Uint8Array.from([...encodeDataPush(signature), ...encodeDataPush(pubkey)]);
    }
  });
  return encodeTransaction(transaction);
}

const owner = keypair(1);
const params: VaultParams = {
  ownerPk: owner.pubHex,
  agentPk: keypair(2).pubHex,
  capPerPeriod: 8_000n,
  periodBlocks: 144n,
  allowlist: [keypair(3).address],
};

async function genesisRequest() {
  const provider = new MockNetworkProvider();
  const contract = getVaultContract(params, provider);
  const utxo = provider.addUtxo(owner.address, randomUtxo({ satoshis: 100_000n, vout: 0 }));
  const { builder } = buildGenesis({
    contract,
    inputs: [{ utxo, unlocker: placeholderP2PKHUnlocker(owner.address) }],
    deposit: 20_000n,
    startHeight: 1000,
    changeAddress: owner.address,
  });
  return { provider, contract, wc: builder.generateWcTransactionObject({ broadcast: false, userPrompt: "create" }) };
}

describe("toRelaySignRequest (WizardConnect transport)", () => {
  it("produces a request that survives JSON.stringify (the relay transport)", async () => {
    const { wc } = await genesisRequest();
    expect(() => JSON.stringify(wc)).toThrow(/BigInt/); // what Cashonize users hit before the fix
    expect(() => JSON.stringify(toRelaySignRequest(wc))).not.toThrow();
  });

  it("keeps the transaction and source outputs intact (hex tx, extended-JSON values)", async () => {
    const { wc } = await genesisRequest();
    const relay = toRelaySignRequest(wc);
    const tx = decodeTransaction(hexToBin(relay.transaction));
    if (typeof tx === "string") throw new Error(tx);
    expect(tx.outputs.map((o) => o.valueSatoshis)).toEqual(wc.transaction.outputs.map((o) => o.valueSatoshis));
    expect(tx.outputs[0].token?.nft?.capability).toBe("mutable");

    const parsed = parseExtendedJson(JSON.stringify(relay));
    expect(parsed.sourceOutputs).toHaveLength(1);
    expect(parsed.sourceOutputs[0].valueSatoshis).toBe(100_000n);
    expect(parsed.userPrompt).toBe("create");
    expect(parsed.broadcast).toBe(false);
  });

  it("carries token data of a contract input (owner withdraw spends the vault NFT)", async () => {
    const { provider, contract, wc: genesis } = await genesisRequest();
    // Put the genesis vault output into the mock chain, then build the owner withdraw from it.
    const g = decodeTransaction(hexToBin(toRelaySignRequest(genesis).transaction));
    if (typeof g === "string") throw new Error(g);
    const out = genesis.transaction.outputs[0];
    provider.addUtxo(contract.tokenAddress, {
      txid: "11".repeat(32),
      vout: 0,
      satoshis: out.valueSatoshis,
      token: { category: binToHex(out.token!.category), amount: 0n, nft: { capability: "mutable", commitment: binToHex(out.token!.nft!.commitment) } },
    });
    const vaultUtxo = (await findVaultUtxo(contract))!;
    const wc = buildWithdraw({ contract, vaultUtxo, to: owner.address }).generateWcTransactionObject({ broadcast: false });
    const parsed = parseExtendedJson(JSON.stringify(toRelaySignRequest(wc)));
    expect(parsed.sourceOutputs[0].token.amount).toBe(0n);
    expect(parsed.sourceOutputs[0].token.nft.capability).toBe("mutable");
    expect(parsed.sourceOutputs[0].token.category).toBe(binToHex(out.token!.category));
  });

  it("lets a Cashonize-style wallet sign a valid owner withdraw (contract input)", async () => {
    // Regression: without `contract` in the relay source outputs, Cashonize signed the vault input as P2PKH and
    // the node rejected the withdraw ("finished with a false/empty top stack element").
    const { provider, contract, wc: genesis } = await genesisRequest();
    const out = genesis.transaction.outputs[0];
    provider.addUtxo(contract.tokenAddress, {
      txid: "22".repeat(32),
      vout: 0,
      satoshis: out.valueSatoshis,
      token: { category: binToHex(out.token!.category), amount: 0n, nft: { capability: "mutable", commitment: binToHex(out.token!.nft!.commitment) } },
    });
    const vaultUtxo = (await findVaultUtxo(contract))!;
    const wc = buildWithdraw({ contract, vaultUtxo, to: owner.address }).generateWcTransactionObject({ broadcast: false });
    const relay = toRelaySignRequest(wc);

    const signed = signLikeCashonize(JSON.stringify(relay), wc.sourceOutputs, privateKeyOf(1));
    const tx = decodeTransaction(signed);
    if (typeof tx === "string") throw new Error(tx);
    expect(createVirtualMachineBch().verify({ sourceOutputs: wc.sourceOutputs, transaction: tx })).toBe(true);
  });

  it("still lets the wallet sign plain P2PKH inputs (genesis)", async () => {
    const { wc } = await genesisRequest();
    const signed = signLikeCashonize(JSON.stringify(toRelaySignRequest(wc)), wc.sourceOutputs, privateKeyOf(1));
    const tx = decodeTransaction(signed);
    if (typeof tx === "string") throw new Error(tx);
    expect(createVirtualMachineBch().verify({ sourceOutputs: wc.sourceOutputs, transaction: tx })).toBe(true);
  });
});
