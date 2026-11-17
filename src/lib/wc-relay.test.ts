import { describe, it, expect } from "vitest";
import { MockNetworkProvider, placeholderP2PKHUnlocker, randomUtxo } from "cashscript";
import { binToHex, decodeTransaction, encodeCashAddress, hash160, hexToBin, secp256k1 } from "@bitauth/libauth";
import { parseExtendedJson } from "@wizardconnect/core";
import { buildGenesis, buildWithdraw, findVaultUtxo, getVaultContract, type VaultParams } from "./vault";
import { toRelaySignRequest } from "./wc-relay";

function keypair(seed: number) {
  const pub = secp256k1.derivePublicKeyCompressed(new Uint8Array(32).fill(seed)) as Uint8Array;
  const address = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }).address;
  return { pubHex: binToHex(pub), address };
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
});
