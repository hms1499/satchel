/**
 * End-to-end test of Satchel on-chain, with a local test key standing in for the owner's wallet.
 * The network comes from NEXT_PUBLIC_BCH_NETWORK (chipnet by default) and must match the running server.
 *
 *   npx tsx scripts/e2e.mts address          # print the test owner address + balance (fund it first)
 *   npx tsx scripts/e2e.mts run              # genesis → agent payments → attacks → withdraw (needs the dev server)
 *   npx tsx scripts/e2e.mts sweep            # move what the agent paid to the provider addresses back to the owner
 *   npx tsx scripts/e2e.mts refund <address> # send everything the test owner holds to <address>
 *
 *   npx tsx scripts/e2e.mts withdraw <file>  # owner-withdraw a vault saved in .e2e-vaults/ (recovery after a crash)
 *
 * E2E_DEPOSIT / E2E_CAP (sats) override the defaults of 20000 / 8000.
 * Mainnet needs NEXT_PUBLIC_BCH_NETWORK=mainnet and E2E_ALLOW_MAINNET=1 (real money; keep amounts tiny).
 * Owner keys are stored per network as CHIPNET_OWNER_SEED / MAINNET_OWNER_SEED in .env.local (gitignored).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder, type SpendableUtxo } from "cashscript";
import { binToHex, publicKeyToP2pkhCashAddress } from "@bitauth/libauth";
import { buildGenesis, buildWithdraw, findVaultUtxo, getVaultContract, type VaultParams } from "../src/lib/vault";
import { descriptorParams, paramsToDescriptorParams, type VaultDescriptor } from "../src/lib/descriptor";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const NETWORK = process.env.NEXT_PUBLIC_BCH_NETWORK === "mainnet" ? "mainnet" : "chipnet";
const PREFIX = NETWORK === "mainnet" ? "bitcoincash" : "bchtest";
const EXPLORER = NETWORK === "mainnet" ? "https://explorer.salemkode.com/tx/" : "https://chipnet.chaingraph.cash/tx/";
const DEPOSIT = BigInt(process.env.E2E_DEPOSIT ?? "20000");
const CAP = BigInt(process.env.E2E_CAP ?? "8000");
const VAULT_DIR = ".e2e-vaults"; // descriptors saved before broadcast, so a crashed run can still withdraw (gitignored)

if (NETWORK === "mainnet" && process.env.E2E_ALLOW_MAINNET !== "1") {
  throw new Error("Mainnet uses real BCH. Set E2E_ALLOW_MAINNET=1 to confirm.");
}

function ownerKey() {
  const seedVar = NETWORK === "mainnet" ? "MAINNET_OWNER_SEED" : "CHIPNET_OWNER_SEED";
  let seed = process.env[seedVar];
  if (!seed) {
    seed = randomBytes(32).toString("hex");
    appendFileSync(".env.local", `${seedVar}=${seed}\n`);
  }
  const priv = new Uint8Array(createHash("sha256").update(`owner|${seed}`).digest());
  const signer = new SignatureTemplate(priv);
  const { address } = publicKeyToP2pkhCashAddress({ publicKey: signer.publicKey, prefix: PREFIX });
  return { signer, address, pubHex: binToHex(signer.publicKey) };
}

const provider = new ElectrumNetworkProvider(NETWORK);
const owner = ownerKey();
const log = (...a: unknown[]) => console.log(...a);
const tx = (txid: string) => `${txid}  ${EXPLORER}${txid}`;

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/** Sends every plain-BCH UTXO in `utxos` (signed by `signer`) to `to`, paying 1 sat/byte. */
async function sweepTo(utxos: SpendableUtxo[], signer: SignatureTemplate, to: string) {
  const plain = utxos.filter((u) => !u.token);
  const total = plain.reduce((s, u) => s + u.satoshis, 0n);
  const build = (fee: bigint) => {
    const b = new TransactionBuilder({ provider });
    for (const u of plain) b.addInput(u, signer.unlockP2PKH());
    return b.addOutput({ to, amount: total - fee });
  };
  if (plain.length === 0 || total < 1_546n) return undefined;
  const fee = build(1_000n).getTransactionSize() + 2n;
  if (total - fee < 546n) return undefined;
  return { txid: (await build(fee).send()).txid, amount: total - fee };
}

async function ensureVoutZeroUtxo() {
  let utxos = (await provider.getUtxos(owner.address)).filter((u) => !u.token);
  const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
  const needed = DEPOSIT + 2_000n;
  if (total < needed) throw new Error(`Owner ${owner.address} has ${total} sats; fund it with >= ${needed} sats`);
  if (!utxos.some((u) => u.vout === 0)) {
    log("No vout-0 UTXO; consolidating to self first…");
    const r = await sweepTo(utxos, owner.signer, owner.address);
    log("  consolidation tx", tx(r!.txid));
    utxos = (await provider.getUtxos(owner.address)).filter((u) => !u.token);
  }
  const first = utxos.find((u) => u.vout === 0)!;
  return [first, ...utxos.filter((u) => u !== first)];
}

async function run() {
  const config = await (await fetch(`${BASE}/api/config`)).json();
  log("network:", NETWORK, "| server network:", config.network, "| llm:", config.llm);
  if (config.network !== NETWORK) throw new Error(`Server runs ${config.network}, script runs ${NETWORK}`);
  const agent = await post("/api/agent/register", {});
  const params: VaultParams = {
    ownerPk: owner.pubHex,
    agentPk: agent.agentPk,
    capPerPeriod: CAP,
    periodBlocks: 144n,
    allowlist: config.tools.map((t: { payTo: string }) => t.payTo),
  };
  const contract = getVaultContract(params, provider);
  log("vault address:", contract.address);

  const utxos = await ensureVoutZeroUtxo();
  const startHeight = await provider.getBlockHeight();
  const { builder, category } = buildGenesis({
    contract,
    inputs: utxos.map((utxo) => ({ utxo, unlocker: owner.signer.unlockP2PKH() })),
    deposit: DEPOSIT,
    startHeight,
    changeAddress: owner.address,
  });
  // Save the descriptor before broadcasting: withdrawing needs the params (agentPk), which the chain doesn't reveal.
  const descriptor: VaultDescriptor = {
    version: 1,
    network: NETWORK,
    agentIndex: agent.agentIndex,
    token: agent.token,
    params: paramsToDescriptorParams(params),
  };
  mkdirSync(VAULT_DIR, { recursive: true });
  const saved = `${VAULT_DIR}/${NETWORK}-${category.slice(0, 12)}.json`;
  writeFileSync(saved, JSON.stringify(descriptor, null, 2));
  log("descriptor saved:", saved);
  const genesis = await builder.send();
  descriptor.genesisTxid = genesis.txid;
  writeFileSync(saved, JSON.stringify(descriptor, null, 2));
  log("genesis tx:", tx(genesis.txid), "\ncategory:", category);

  await new Promise((r) => setTimeout(r, 1500));
  log("status:", await post("/api/vault/status", { descriptor }));

  log("\n--- agent run ---");
  const res = await fetch(`${BASE}/api/agent/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ descriptor, prompt: "Is BCH cheaper to use than ETH right now? Give me a short brief." }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) if (line.trim()) log(" ", line.slice(0, 300));
  }

  log("\n--- attacks ---");
  for (const kind of ["overspend", "attacker"]) {
    const r = await fetch(`${BASE}/api/agent/attack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ descriptor, kind }) });
    log(kind, r.status, JSON.stringify(await r.json()));
  }

  log("\n--- owner withdraw ---");
  const vaultUtxo = await findVaultUtxo(contract);
  if (!vaultUtxo) throw new Error("vault UTXO not found before withdraw");
  const w = await buildWithdraw({ contract, vaultUtxo, to: owner.address, ownerSigner: owner.signer }).send();
  log("withdraw tx:", tx(w.txid), "\nreturned:", vaultUtxo.satoshis.toString(), "sats (minus fee)");
  log("final status:", await post("/api/vault/status", { descriptor }));
}

async function sweepProviders() {
  // Imported after .env.local is loaded: keys.ts reads the network and PROVIDER_SEED at import time.
  const { providerKeys } = await import("../src/lib/server/keys");
  for (const p of providerKeys()) {
    const utxos = await provider.getUtxos(p.address);
    const r = await sweepTo(utxos, p.signer, owner.address);
    log(p.address, r ? `swept ${r.amount} sats: ${tx(r.txid)}` : "nothing to sweep");
  }
}

async function main() {
  const cmd = process.argv[2] ?? "address";
  if (cmd === "address") {
    const utxos = await provider.getUtxos(owner.address);
    log(`owner (${NETWORK}):`, owner.address);
    log("balance:", utxos.reduce((s, u) => s + u.satoshis, 0n).toString(), "sats in", utxos.length, "utxos");
  } else if (cmd === "run") {
    await run();
  } else if (cmd === "withdraw") {
    const file = process.argv[3];
    if (!file) throw new Error("Usage: withdraw .e2e-vaults/<file>.json");
    const d = JSON.parse(readFileSync(file, "utf8")) as VaultDescriptor;
    const contract = getVaultContract(descriptorParams(d), provider);
    const vaultUtxo = await findVaultUtxo(contract);
    if (!vaultUtxo) throw new Error(`No vault UTXO at ${contract.address}`);
    const w = await buildWithdraw({ contract, vaultUtxo, to: owner.address, ownerSigner: owner.signer }).send();
    log("withdraw tx:", tx(w.txid));
  } else if (cmd === "sweep") {
    await sweepProviders();
  } else if (cmd === "refund") {
    const to = process.argv[3];
    if (!to?.startsWith(`${PREFIX}:`)) throw new Error(`Usage: refund ${PREFIX}:<address>`);
    const r = await sweepTo(await provider.getUtxos(owner.address), owner.signer, to);
    log(r ? `refunded ${r.amount} sats to ${to}: ${tx(r.txid)}` : "nothing to refund");
  } else {
    throw new Error(`Unknown command ${cmd}`);
  }
  await provider.disconnect().catch(() => undefined);
}

main().catch(async (e) => {
  console.error(e);
  await provider.disconnect().catch(() => undefined);
  process.exit(1);
});
