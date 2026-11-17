/**
 * End-to-end test of satchel-pay-mcp on BCH mainnet over real stdio:
 * spawn the built server → satchel_setup → the local test owner creates a vault for the MCP's agent key →
 * satchel_connect → satchel_pay_fetch until the covenant refuses → owner withdraw.
 *
 *   cd mcp && npm run build
 *   E2E_ALLOW_MAINNET=1 E2E_DEPOSIT=6000 E2E_CAP=2500 npx tsx scripts/mainnet-e2e.mts
 *
 * Needs the Satchel dev server on mainnet (SATCHEL_URL, default http://localhost:3000) and MAINNET_OWNER_SEED in
 * ../.env.local (see scripts/e2e.mts). Real money: keep amounts tiny.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElectrumNetworkProvider, SignatureTemplate, binToHex } from "../../src/lib/chain-deps";
import { publicKeyToP2pkhCashAddress } from "@bitauth/libauth";
import { buildGenesis, buildWithdraw, findVaultUtxo, getVaultContract, type VaultParams } from "../../src/lib/vault";
import { EXTERNAL_AGENT_INDEX, paramsToDescriptorParams } from "../../src/lib/descriptor";
import { encodeRecoveryMemo } from "../../src/lib/recovery";
import { encodeConnectCode } from "../../src/lib/connect-code";
import { explorerTxUrl } from "../../src/lib/config";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, "../../.env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (process.env.E2E_ALLOW_MAINNET !== "1") throw new Error("Mainnet uses real BCH. Set E2E_ALLOW_MAINNET=1 to confirm.");
const seed = process.env.MAINNET_OWNER_SEED;
if (!seed) throw new Error("MAINNET_OWNER_SEED missing in .env.local (run scripts/e2e.mts address on mainnet first)");

const SATCHEL_URL = process.env.SATCHEL_URL ?? "http://localhost:3000";
const DEPOSIT = BigInt(process.env.E2E_DEPOSIT ?? "6000");
const CAP = BigInt(process.env.E2E_CAP ?? "2500");
const log = (...a: unknown[]) => console.log(...a);
const link = (txid: string) => `${txid}  ${explorerTxUrl("mainnet", txid)}`;

const ownerSigner = new SignatureTemplate(new Uint8Array(createHash("sha256").update(`owner|${seed}`).digest()));
const ownerPk = binToHex(ownerSigner.publicKey);
const ownerAddress = publicKeyToP2pkhCashAddress({ publicKey: ownerSigner.publicKey, prefix: "bitcoincash" }).address;
const provider = new ElectrumNetworkProvider("mainnet");

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as TextResult;
  const text = r.content[0]?.text ?? "";
  log(`\n> ${name}${r.isError ? " (error)" : ""}\n${text.slice(0, 700)}`);
  return { text, isError: Boolean(r.isError) };
}

async function main() {
  const home = join(mkdtempSync(join(tmpdir(), "satchel-e2e-")), "home");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "../dist/index.js")],
    env: { ...(process.env as Record<string, string>), SATCHEL_HOME: home, SATCHEL_URL, SATCHEL_NETWORK: "mainnet" },
    stderr: "inherit",
  });
  const client = new Client({ name: "satchel-e2e", version: "0" });
  await client.connect(transport);
  log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

  const { agentPk } = JSON.parse((await call(client, "satchel_setup")).text) as { agentPk: string };
  const config = (await (await fetch(`${SATCHEL_URL}/api/config`)).json()) as { network: string; tools: { payTo: string }[] };
  if (config.network !== "mainnet") throw new Error(`Satchel server runs ${config.network}`);
  const allowlist = config.tools.map((t) => t.payTo);

  // The owner (stand-in for the user's wallet) creates the vault for the MCP's agent key.
  const params: VaultParams = { ownerPk, agentPk, capPerPeriod: CAP, periodBlocks: 144n, allowlist };
  const contract = getVaultContract(params, provider);
  const utxos = (await provider.getUtxos(ownerAddress)).filter((u) => !u.token);
  const first = utxos.find((u) => u.vout === 0);
  if (!first) throw new Error(`Owner ${ownerAddress} has no vout-0 UTXO; run scripts/e2e.mts run once to consolidate`);
  const inputs = [first, ...utxos.filter((u) => u !== first)].map((utxo) => ({ utxo, unlocker: ownerSigner.unlockP2PKH() }));
  const { builder } = buildGenesis({
    contract,
    inputs,
    deposit: DEPOSIT,
    startHeight: await provider.getBlockHeight(),
    changeAddress: ownerAddress,
    opReturn: encodeRecoveryMemo(params, EXTERNAL_AGENT_INDEX, allowlist),
  });
  const genesis = await builder.send();
  log("\ngenesis:", link(genesis.txid), "\nvault:", contract.address);
  await new Promise((r) => setTimeout(r, 2000));

  const code = encodeConnectCode({ v: 1, network: "mainnet", params: paramsToDescriptorParams(params), genesisTxid: genesis.txid });
  if ((await call(client, "satchel_connect", { code })).isError) throw new Error("connect failed");
  await call(client, "satchel_status");
  await call(client, "satchel_catalog");

  let paid = 0;
  let refused = false;
  for (const id of ["bitcoin-cash", "ethereum", "bitcoin", "litecoin"]) {
    const r = await call(client, "satchel_pay_fetch", { url: `${SATCHEL_URL}/api/tools/crypto-price`, body: { id } });
    if (!r.isError) {
      paid++;
      continue;
    }
    refused = /covenant refused/.test(r.text);
    break;
  }
  log(`\npaid calls: ${paid}, covenant refusal: ${refused}`);

  const vaultUtxo = await findVaultUtxo(contract);
  if (!vaultUtxo) throw new Error("vault UTXO not found before withdraw");
  const w = await buildWithdraw({ contract, vaultUtxo, to: ownerAddress, ownerSigner }).send();
  log("withdraw:", link(w.txid), `(${vaultUtxo.satoshis} sats before fee)`);
  await new Promise((r) => setTimeout(r, 2000));
  await call(client, "satchel_status");

  await client.close();
  await provider.disconnect().catch(() => undefined);
  if (paid < 1 || !refused) {
    console.error("E2E FAILED: expected at least one paid call and a covenant refusal");
    process.exit(1);
  }
  log("\nE2E OK");
}

main().catch(async (e) => {
  console.error(e);
  await provider.disconnect().catch(() => undefined);
  process.exit(1);
});
