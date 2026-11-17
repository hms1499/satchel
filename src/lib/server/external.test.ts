// Vaults whose agent key is external (held by the user's own agent, e.g. satchel-pay-mcp).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockNetworkProvider, SignatureTemplate, randomUtxo } from "cashscript";
import { binToHex, encodeCashAddress, hash160, secp256k1 } from "@bitauth/libauth";

process.env.AGENT_MASTER_SEED ??= "external-agent-seed-0123456789abcdef0123456789abc";
process.env.PROVIDER_SEED ??= "external-provider-seed-0123456789abcdef0123456789";

const net = { provider: new MockNetworkProvider() };
vi.mock("./electrum", () => ({ getProvider: () => net.provider }));

function keypair(seed: number) {
  const priv = new Uint8Array(32).fill(seed);
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { signer: new SignatureTemplate(priv), pubHex: binToHex(pub), address: encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }).address };
}
const owner = keypair(1);
const externalAgent = keypair(9);
const PAY_TO = keypair(3).address;

beforeEach(() => {
  vi.resetModules();
  net.provider = new MockNetworkProvider();
  net.provider.setBlockHeight(1000);
});

async function externalVault() {
  const { getVaultContract, buildGenesis } = await import("../vault");
  const { paramsToDescriptorParams, EXTERNAL_AGENT_INDEX } = await import("../descriptor");
  const params = { ownerPk: owner.pubHex, agentPk: externalAgent.pubHex, capPerPeriod: 8_000n, periodBlocks: 144n, allowlist: [PAY_TO] };
  const contract = getVaultContract(params, net.provider);
  const u = net.provider.addUtxo(owner.address, randomUtxo({ satoshis: 100_000n, vout: 0 }));
  await buildGenesis({ contract, inputs: [{ utxo: u, unlocker: owner.signer.unlockP2PKH() }], deposit: 20_000n, startHeight: 1000, changeAddress: owner.address }).builder.send();
  return { version: 1 as const, network: "chipnet" as const, agentIndex: EXTERNAL_AGENT_INDEX, token: "", external: true, params: paramsToDescriptorParams(params) };
}

describe("external-agent vaults", () => {
  it("status opens an external-agent descriptor without a token", async () => {
    const descriptor = await externalVault();
    const { openDescriptor, vaultStatus } = await import("./agent-wallet");
    const opened = openDescriptor(descriptor, { requireToken: false });
    expect((await vaultStatus(opened)).balance).toBe("20000");
  });

  it("hosted endpoints refuse an external-agent descriptor", async () => {
    const descriptor = await externalVault();
    const { openDescriptor } = await import("./agent-wallet");
    expect(() => openDescriptor(descriptor)).toThrow(/own MCP client/);
  });

  it("recovered memo with the external index becomes an external descriptor", async () => {
    const { descriptorFromRecovered } = await import("../recovery");
    const { EXTERNAL_AGENT_INDEX } = await import("../descriptor");
    const params = { ownerPk: owner.pubHex, agentPk: externalAgent.pubHex, capPerPeriod: 8_000n, periodBlocks: 144n, allowlist: [PAY_TO] };
    const d = descriptorFromRecovered({ agentIndex: EXTERNAL_AGENT_INDEX, params, genesisTxid: "aa".repeat(32) }, "chipnet");
    expect(d).toMatchObject({ external: true, recovered: true, token: "", agentIndex: 0xffffffff, genesisTxid: "aa".repeat(32) });
    const hosted = descriptorFromRecovered({ agentIndex: 7, params, genesisTxid: "bb".repeat(32) }, "chipnet");
    expect(hosted.external).toBe(false);
  });

  it("the recovery memo round-trips the external agent index", async () => {
    const { encodeRecoveryMemo, decodeRecoveryMemo } = await import("../recovery");
    const { EXTERNAL_AGENT_INDEX } = await import("../descriptor");
    const { hexToBin, utf8ToBin, encodeDataPush, flattenBinArray } = await import("@bitauth/libauth");
    const params = { ownerPk: owner.pubHex, agentPk: externalAgent.pubHex, capPerPeriod: 8_000n, periodBlocks: 144n, allowlist: [PAY_TO] };
    const [prefix, payload] = encodeRecoveryMemo(params, EXTERNAL_AGENT_INDEX, [PAY_TO]);
    const script = flattenBinArray([Uint8Array.of(0x6a), encodeDataPush(utf8ToBin(prefix)), encodeDataPush(hexToBin(payload.slice(2)))]);
    expect(decodeRecoveryMemo(script, owner.pubHex, [PAY_TO], "chipnet")?.agentIndex).toBe(0xffffffff);
  });
});
