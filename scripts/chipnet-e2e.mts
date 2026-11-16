/**
 * End-to-end test of Satchel on chipnet, with a local test key standing in for the owner's wallet.
 *
 *   npx tsx scripts/chipnet-e2e.mts address   # print the test owner address + balance (fund it from a chipnet faucet)
 *   npx tsx scripts/chipnet-e2e.mts run       # needs `npm run dev` running on :3000
 *
 * The owner key is stored as CHIPNET_OWNER_SEED in .env.local (gitignored). Chipnet only.
 */
import { appendFileSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from "cashscript";
import { binToHex, publicKeyToP2pkhCashAddress } from "@bitauth/libauth";
import { buildGenesis, buildWithdraw, findVaultUtxo, getVaultContract, type VaultParams } from "../src/lib/vault";
import { paramsToDescriptorParams, type VaultDescriptor } from "../src/lib/descriptor";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

if (process.env.NEXT_PUBLIC_BCH_NETWORK === "mainnet") throw new Error("This script is chipnet-only");

function ownerKey() {
  let seed = process.env.CHIPNET_OWNER_SEED;
  if (!seed) {
    seed = randomBytes(32).toString("hex");
    appendFileSync(".env.local", `CHIPNET_OWNER_SEED=${seed}\n`);
  }
  const priv = new Uint8Array(createHash("sha256").update(`owner|${seed}`).digest());
  const signer = new SignatureTemplate(priv);
  const { address } = publicKeyToP2pkhCashAddress({ publicKey: signer.publicKey, prefix: "bchtest" });
  return { signer, address, pubHex: binToHex(signer.publicKey) };
}

const provider = new ElectrumNetworkProvider("chipnet");
const owner = ownerKey();
const log = (...a: unknown[]) => console.log(...a);

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function ensureVoutZeroUtxo() {
  let utxos = (await provider.getUtxos(owner.address)).filter((u) => !u.token);
  const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
  if (total < 30_000n) throw new Error(`Owner ${owner.address} has ${total} sats; fund it with >= 30,000 chipnet sats`);
  if (!utxos.some((u) => u.vout === 0)) {
    log("No vout-0 UTXO; consolidating to self first…");
    const b = new TransactionBuilder({ provider });
    for (const u of utxos) b.addInput(u, owner.signer.unlockP2PKH());
    b.addOutput({ to: owner.address, amount: total - 1_000n });
    const tx = await b.send();
    log("  consolidation tx", tx.txid);
    utxos = (await provider.getUtxos(owner.address)).filter((u) => !u.token);
  }
  const first = utxos.find((u) => u.vout === 0)!;
  return [first, ...utxos.filter((u) => u !== first)];
}

async function run() {
  const config = await (await fetch(`${BASE}/api/config`)).json();
  log("server network:", config.network, "| llm:", config.llm);
  const agent = await post("/api/agent/register", {});
  const params: VaultParams = {
    ownerPk: owner.pubHex,
    agentPk: agent.agentPk,
    capPerPeriod: 8_000n,
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
    deposit: 20_000n,
    startHeight,
    changeAddress: owner.address,
  });
  const genesis = await builder.send();
  log("genesis tx:", genesis.txid, "category:", category);

  const descriptor: VaultDescriptor = {
    version: 1,
    network: "chipnet",
    agentIndex: agent.agentIndex,
    token: agent.token,
    params: paramsToDescriptorParams(params),
    genesisTxid: genesis.txid,
  };

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
  log("withdraw tx:", w.txid, "returned:", vaultUtxo.satoshis.toString(), "sats (minus fee)");
  log("final status:", await post("/api/vault/status", { descriptor }));
}

async function main() {
  const cmd = process.argv[2] ?? "address";
  if (cmd === "address") {
    const utxos = await provider.getUtxos(owner.address);
    log("owner (chipnet):", owner.address);
    log("balance:", utxos.reduce((s, u) => s + u.satoshis, 0n).toString(), "sats in", utxos.length, "utxos");
  } else if (cmd === "run") {
    await run();
  }
  await provider.disconnect().catch(() => undefined);
}

main().catch(async (e) => {
  console.error(e);
  await provider.disconnect().catch(() => undefined);
  process.exit(1);
});
