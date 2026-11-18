/**
 * End-to-end test of satchel-pay-mcp over real stdio, on BCH mainnet (default) or chipnet (E2E_NETWORK=chipnet):
 *
 *   1. the local test owner creates a vault for the MCP's agent key, with the allowlist
 *      [bch-tx payTo, seller payTo (from its /.well-known/satchel.json), custom payee], labels and a v2 recovery memo;
 *   2. satchel_connect (+ status and catalog);
 *   3. satchel_send 1000 sats with memo "e2e" to the custom payee;
 *   4. satchel_pay_fetch Satchel's bch-tx with the genesis txid;
 *   5. satchel_pay_fetch the seller's /api/address;
 *   6. keep paying bch-tx until the covenant refuses (cap);
 *   7. findVaultsInTransactions over the owner's history (which holds the genesis tx) recovers the vault from the v2 memo;
 *   8. the owner withdraws the rest (always attempted once the vault exists, even after a failed step).
 *
 *   cd mcp && npm run build
 *   E2E_ALLOW_MAINNET=1 E2E_SELLER_ORIGIN=https://<seller> npx tsx scripts/mainnet-e2e.mts
 *   E2E_NETWORK=chipnet E2E_SELLER_ORIGIN=http://localhost:8787 npx tsx scripts/mainnet-e2e.mts
 *
 * Env: SATCHEL_URL (default http://localhost:3000; a Satchel server on the same network), E2E_SELLER_ORIGIN (required;
 * a satchel-pay-server seller such as examples/provider), E2E_CUSTOM_PAYEE (default: the test owner's own address, so the
 * send comes back), E2E_DEPOSIT (default 8000), E2E_CAP (default 5000). The owner key comes from MAINNET_OWNER_SEED or
 * CHIPNET_OWNER_SEED in ../.env.local (see scripts/e2e.mts `address`); the owner needs one vout-0 UTXO and about
 * DEPOSIT + 500 sats.
 *
 * Expected cost with the defaults (fees ~700-800 sats per vault payment with a 3-payee allowlist):
 *   send 1000 + fee, bch-tx 600 + fee, seller 600 + fee  =>  spent ~4,300-4,600 of the 5,000 cap; the next bch-tx
 *   (~1,300-1,400) is refused by the covenant (a rejected tx costs nothing). Then the owner withdraws ~3,600.
 *   The deposit leaves room above the cap so the refusal is always the cap, never "vault balance too low".
 *   Lost to miners: genesis (~400) + 3 payments (~2,100-2,400) + withdraw (~400-500)  =>  about 3,000-3,500 sats.
 *   The 1000-sat send returns to the owner (default custom payee); 600 goes to the seller's payTo and 600 to
 *   Satchel's bch-tx provider address (recoverable with `scripts/e2e.mts sweep` by whoever holds PROVIDER_SEED).
 *
 * If the run dies after genesis, the vault descriptor is in ../.e2e-vaults/; withdraw it with
 * `npx tsx scripts/e2e.mts withdraw .e2e-vaults/<file>` from the repo root (same network env as scripts/e2e.mts).
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElectrumNetworkProvider, SignatureTemplate, binToHex } from "../../src/lib/chain-deps";
import { publicKeyToP2pkhCashAddress, sha256 } from "@bitauth/libauth";
import {
  buildGenesis,
  buildWithdraw,
  findVaultUtxo,
  getVaultContract,
  lockingBytecodeOf,
  type VaultContract,
  type VaultParams,
} from "../../src/lib/vault";
import { EXTERNAL_AGENT_INDEX, paramsToDescriptorParams, type VaultDescriptor } from "../../src/lib/descriptor";
import { encodeRecoveryMemo, findVaultsInTransactions } from "../../src/lib/recovery";
import { encodeConnectCode } from "../../src/lib/connect-code";
import { explorerTxUrl, type BchNetwork } from "../../src/lib/config";
import { normalizePayee, prefixFor } from "../../src/lib/payees";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, "../../.env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const networkEnv = process.env.E2E_NETWORK ?? "mainnet";
if (networkEnv !== "mainnet" && networkEnv !== "chipnet") throw new Error(`E2E_NETWORK must be "mainnet" or "chipnet", got "${networkEnv}"`);
const NETWORK: BchNetwork = networkEnv;
if (NETWORK === "mainnet" && process.env.E2E_ALLOW_MAINNET !== "1") throw new Error("Mainnet uses real BCH. Set E2E_ALLOW_MAINNET=1 to confirm.");
const seedVar = NETWORK === "mainnet" ? "MAINNET_OWNER_SEED" : "CHIPNET_OWNER_SEED";
const seed = process.env[seedVar];
if (!seed) throw new Error(`${seedVar} missing in .env.local (run scripts/e2e.mts address on ${NETWORK} first)`);

const SATCHEL_URL = (process.env.SATCHEL_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const sellerEnv = process.env.E2E_SELLER_ORIGIN;
if (!sellerEnv) throw new Error("E2E_SELLER_ORIGIN missing: the origin of a satchel-pay-server seller (e.g. examples/provider)");
const SELLER_ORIGIN = new URL(sellerEnv).origin;
const DEPOSIT = BigInt(process.env.E2E_DEPOSIT ?? "8000");
const CAP = BigInt(process.env.E2E_CAP ?? "5000");
const SEND_SATS = 1000;
const MAX_EXTRA_CALLS = 4;
const log = (...a: unknown[]) => console.log(...a);
const link = (txid: string) => `${txid}  ${explorerTxUrl(NETWORK, txid)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ownerSigner = new SignatureTemplate(new Uint8Array(createHash("sha256").update(`owner|${seed}`).digest()));
const ownerPk = binToHex(ownerSigner.publicKey);
const ownerAddress = publicKeyToP2pkhCashAddress({ publicKey: ownerSigner.publicKey, prefix: prefixFor(NETWORK) }).address;
const provider = new ElectrumNetworkProvider(NETWORK);

const customEnv = process.env.E2E_CUSTOM_PAYEE ?? ownerAddress;
const custom = normalizePayee(customEnv, NETWORK);
if (!custom.ok) throw new Error(`E2E_CUSTOM_PAYEE "${customEnv}": ${custom.error}`);
const CUSTOM_PAYEE = custom.address;

const failures: string[] = [];
const check = (cond: unknown, what: string) => {
  log(`${cond ? "ok  " : "FAIL"}  ${what}`);
  if (!cond) failures.push(what);
};

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as TextResult;
  const text = r.content[0]?.text ?? "";
  log(`\n> ${name} ${JSON.stringify(args)}${r.isError ? " (error)" : ""}\n${text.slice(0, 900)}`);
  return { text, isError: Boolean(r.isError) };
}

/** The txid of a successful satchel_send / satchel_pay_fetch result (or of a paid call whose endpoint then failed). */
function txidOf(r: { text: string; isError: boolean }): string | null {
  if (!r.isError) {
    const data = JSON.parse(r.text) as { txid?: string; payment?: { txid?: string } | null };
    return data.txid ?? data.payment?.txid ?? null;
  }
  return /\(txid ([0-9a-f]{64})\)/.exec(r.text)?.[1] ?? null;
}

const txids: { step: string; txid: string }[] = [];
function record(step: string, txid: string | null) {
  if (!txid) return;
  txids.push({ step, txid });
  log(`tx  ${step}: ${link(txid)}`);
}

type WellKnown = { network: string; tools: { name: string; payTo: string; endpoint: string; price: string }[] };

async function main() {
  // Satchel's catalog and the seller's catalog decide the allowlist.
  const config = (await (await fetch(`${SATCHEL_URL}/api/config`)).json()) as { network: string; tools: { name: string; payTo: string }[] };
  if (config.network !== NETWORK) throw new Error(`Satchel server ${SATCHEL_URL} runs ${config.network}, this run is ${NETWORK}`);
  const knownPayees = config.tools.map((t) => t.payTo);
  const bchTx = config.tools.find((t) => t.name === "bch-tx");
  if (!bchTx) throw new Error(`${SATCHEL_URL} has no bch-tx tool`);
  const seller = (await (await fetch(`${SELLER_ORIGIN}/.well-known/satchel.json`)).json()) as WellKnown;
  if (seller.network !== NETWORK) throw new Error(`Seller ${SELLER_ORIGIN} runs ${seller.network}, this run is ${NETWORK}`);
  const sellerTool = seller.tools.find((t) => new URL(t.endpoint).pathname === "/api/address");
  if (!sellerTool) throw new Error(`Seller ${SELLER_ORIGIN} lists no /api/address tool`);
  const sellerPayTo = normalizePayee(sellerTool.payTo, NETWORK);
  if (!sellerPayTo.ok) throw new Error(`Seller payTo ${sellerTool.payTo}: ${sellerPayTo.error}`);

  const allowlist = [...new Set([bchTx.payTo, sellerPayTo.address, CUSTOM_PAYEE])];
  const labels: Record<string, string> = {
    [CUSTOM_PAYEE]: "E2E custom payee",
    [sellerPayTo.address]: "E2E seller",
    [bchTx.payTo]: "bch-tx",
  };
  log("network:", NETWORK, "| satchel:", SATCHEL_URL, "| seller:", SELLER_ORIGIN, "| owner:", ownerAddress);
  log("allowlist:", allowlist);

  const home = join(mkdtempSync(join(tmpdir(), "satchel-e2e-")), "home");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "../dist/index.js")],
    env: {
      ...(process.env as Record<string, string>),
      SATCHEL_HOME: home,
      SATCHEL_URL,
      SATCHEL_NETWORK: NETWORK,
      SATCHEL_PAY_ORIGINS: SELLER_ORIGIN,
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "satchel-e2e", version: "0" });
  await client.connect(transport);
  log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

  const { agentPk } = JSON.parse((await call(client, "satchel_setup")).text) as { agentPk: string };

  // 1. The owner (stand-in for the user's wallet) creates the vault for the MCP's agent key, with a v2 recovery memo.
  const params: VaultParams = { ownerPk, agentPk, capPerPeriod: CAP, periodBlocks: 144n, allowlist };
  const contract = getVaultContract(params, provider);
  const memo = encodeRecoveryMemo(params, EXTERNAL_AGENT_INDEX, knownPayees);
  check(memo[1].startsWith("0x02"), "recovery memo is v2 (custom payee and seller stored as hashes)");
  const utxos = (await provider.getUtxos(ownerAddress)).filter((u) => !u.token);
  const first = utxos.find((u) => u.vout === 0);
  if (!first) throw new Error(`Owner ${ownerAddress} has no vout-0 UTXO; run scripts/e2e.mts run once to consolidate`);
  const inputs = [first, ...utxos.filter((u) => u !== first)].map((utxo) => ({ utxo, unlocker: ownerSigner.unlockP2PKH() }));
  const { builder, category } = buildGenesis({
    contract,
    inputs,
    deposit: DEPOSIT,
    startHeight: await provider.getBlockHeight(),
    changeAddress: ownerAddress,
    opReturn: memo,
  });
  // Saved before broadcast so a crashed run can still be withdrawn with scripts/e2e.mts withdraw.
  const descriptor: VaultDescriptor = {
    version: 1,
    network: NETWORK,
    agentIndex: EXTERNAL_AGENT_INDEX,
    token: "",
    params: paramsToDescriptorParams(params),
    external: true,
  };
  const vaultDir = join(here, "../../.e2e-vaults");
  mkdirSync(vaultDir, { recursive: true });
  const saved = join(vaultDir, `${NETWORK}-mcp-${category.slice(0, 12)}.json`);
  writeFileSync(saved, JSON.stringify(descriptor, null, 2));
  const genesis = await builder.send();
  writeFileSync(saved, JSON.stringify({ ...descriptor, genesisTxid: genesis.txid }, null, 2));
  record("genesis", genesis.txid);
  log("vault:", contract.address, "| descriptor saved:", saved);
  await sleep(2000);

  try {
    await steps(client, { params, contract, genesisTxid: genesis.txid, labels, sellerPayTo: sellerPayTo.address, knownPayees });
  } catch (e) {
    failures.push(`step threw: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  } finally {
    // 8. Withdraw, whatever happened above.
    const vaultUtxo = await findVaultUtxo(contract);
    if (!vaultUtxo) {
      check(false, "vault UTXO found for the withdraw");
    } else {
      const w = await buildWithdraw({ contract, vaultUtxo, to: ownerAddress, ownerSigner }).send();
      record("withdraw", w.txid);
      log(`withdrew ${vaultUtxo.satoshis} sats before fee to ${ownerAddress}`);
      await sleep(2000);
      await call(client, "satchel_status"); // expected: "The vault is closed" (once Electrum has seen the withdraw)
    }
    await client.close();
  }
}

async function steps(
  client: Client,
  v: { params: VaultParams; contract: VaultContract; genesisTxid: string; labels: Record<string, string>; sellerPayTo: string; knownPayees: string[] },
) {
  // 2. Connect.
  const code = encodeConnectCode({
    v: 1,
    network: NETWORK,
    params: paramsToDescriptorParams(v.params),
    genesisTxid: v.genesisTxid,
    labels: v.labels,
    sellers: [SELLER_ORIGIN],
  });
  const connected = await call(client, "satchel_connect", { code });
  if (connected.isError) throw new Error("satchel_connect failed");
  const conn = JSON.parse(connected.text) as { sellerOrigins: string[]; addToPayOrigins?: string[] };
  check(conn.sellerOrigins.includes(SELLER_ORIGIN) && !conn.addToPayOrigins, "connect: seller origin suggested and already allowed");
  const status = JSON.parse((await call(client, "satchel_status")).text) as { payees: { address: string; label: string | null }[] };
  check(status.payees.find((p) => p.address === CUSTOM_PAYEE)?.label === "E2E custom payee", "status: custom payee carries its label");
  const catalog = JSON.parse((await call(client, "satchel_catalog")).text) as {
    tools: { name: string; allowed: boolean }[];
    sellers: { origin: string; ok: boolean; tools?: { endpoint: string; allowed: boolean }[] }[];
  };
  check(catalog.tools.find((t) => t.name === "bch-tx")?.allowed, "catalog: bch-tx is payable");
  const sellerEntry = catalog.sellers.find((s) => s.origin === SELLER_ORIGIN);
  check(sellerEntry?.ok && sellerEntry.tools?.some((t) => t.allowed && new URL(t.endpoint).pathname === "/api/address"), "catalog: seller /api/address is payable");

  // 3. Direct send to the custom payee.
  const sent = await call(client, "satchel_send", { to: CUSTOM_PAYEE, amountSats: SEND_SATS, memo: "e2e" });
  record("satchel_send", txidOf(sent));
  check(!sent.isError, `satchel_send ${SEND_SATS} sats with memo "e2e" to the custom payee`);

  // 4. Satchel's bch-tx, about the genesis tx.
  const bchTxUrl = `${SATCHEL_URL}/api/tools/bch-tx`;
  const decoded = await call(client, "satchel_pay_fetch", { url: bchTxUrl, body: { txid: v.genesisTxid } });
  record("bch-tx", txidOf(decoded));
  check(!decoded.isError, "satchel_pay_fetch bch-tx");

  // 5. The seller's /api/address.
  const address = await call(client, "satchel_pay_fetch", { url: `${SELLER_ORIGIN}/api/address`, body: { address: CUSTOM_PAYEE } });
  record("seller /api/address", txidOf(address));
  check(!address.isError, "satchel_pay_fetch seller /api/address");

  // 6. Keep paying until the covenant refuses.
  let refused = false;
  for (let i = 1; i <= MAX_EXTRA_CALLS && !refused; i++) {
    const r = await call(client, "satchel_pay_fetch", { url: bchTxUrl, body: { txid: v.genesisTxid } });
    record(`bch-tx extra #${i}`, txidOf(r));
    if (r.isError) {
      refused = /covenant refused/.test(r.text);
      if (!refused) break;
    }
  }
  check(refused, `covenant refused a payment over the ${v.params.capPerPeriod}-sat cap within ${MAX_EXTRA_CALLS} extra calls`);

  // 7. Recover the vault from chain alone: the owner's history holds the genesis tx and its v2 memo.
  const scriptHash = binToHex(sha256.hash(lockingBytecodeOf(ownerAddress)).reverse());
  const history = (await provider.performRequest("blockchain.scripthash.get_history", scriptHash)) as { tx_hash: string }[];
  const recent = history.slice(-60).map((h) => h.tx_hash);
  check(recent.includes(v.genesisTxid), "owner history contains the genesis tx");
  const txs = await Promise.all(recent.map(async (txid) => ({ txid, hex: await provider.getRawTransaction(txid) })));
  const recovered = findVaultsInTransactions(txs, ownerPk, v.knownPayees, provider).find((r) => r.genesisTxid === v.genesisTxid);
  check(
    recovered &&
      recovered.agentIndex === EXTERNAL_AGENT_INDEX &&
      getVaultContract(recovered.params, provider).address === v.contract.address &&
      JSON.stringify(recovered.params.allowlist) === JSON.stringify(v.params.allowlist),
    "findVaultsInTransactions recovers the vault (same contract, allowlist incl. custom payee and seller)",
  );
  check(recovered?.params.allowlist.includes(v.sellerPayTo) && recovered.params.allowlist.includes(CUSTOM_PAYEE), "recovered allowlist decodes the hashed payees");
}

main()
  .catch((e) => {
    console.error(e);
    failures.push(`run threw: ${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(async () => {
    await provider.disconnect().catch(() => undefined);
    log("\ntxids:");
    for (const t of txids) log(`  ${t.step}: ${link(t.txid)}`);
    if (failures.length) {
      console.error(`\nE2E FAILED:\n- ${failures.join("\n- ")}`);
      process.exit(1);
    }
    log("\nE2E OK");
    process.exit(0);
  });
