/**
 * Mainnet (or chipnet) proof of covenant v2's sliding-window cap, with no server involved:
 * a vault with periodBlocks = 1, so the cooldown is one confirmation.
 *
 *   1. genesis (cap 3,000, deposit 8,000; the only payee is the owner's own address, so nothing is lost)
 *   2. pay 1,200 sats: same period (the vault coin is unconfirmed)
 *   3. pay 1,200 again: over the cap → rejected by the covenant
 *   4. start a new period with sequence 0 → rejected in script (require(this.age >= periodBlocks))
 *   5. start a new period with sequence 1 on the unconfirmed coin → rejected by the node (non-BIP68-final)
 *   6. wait until the vault coin confirms (≤ 40 min), then pay 1,200: a new period, accepted, spent = this outflow
 *   7. owner withdraw
 *
 *   NEXT_PUBLIC_BCH_NETWORK=mainnet E2E_ALLOW_MAINNET=1 npx tsx scripts/v2-cooldown-e2e.mts
 *
 * Owner key: MAINNET_OWNER_SEED / CHIPNET_OWNER_SEED in .env.local (same derivation as scripts/e2e.mts). The vault
 * descriptor is saved to .e2e-vaults/ before broadcast; `npx tsx scripts/e2e.mts withdraw <file>` recovers a crashed run.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { SignatureTemplate, type SpendableUtxo } from "cashscript";
import { binToHex, publicKeyToP2pkhCashAddress } from "@bitauth/libauth";
import { buildAgentSpend, buildGenesis, buildWithdraw, encodeState, findVaultUtxo, getVaultContract, type VaultParams } from "../src/lib/vault";
import { EXTERNAL_AGENT_INDEX, paramsToDescriptorParams, type VaultDescriptor } from "../src/lib/descriptor";
import { FailoverElectrumProvider } from "../src/lib/electrum-failover";
import { coinHeight } from "../src/lib/coin-height";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const NETWORK = process.env.NEXT_PUBLIC_BCH_NETWORK === "mainnet" ? "mainnet" : "chipnet";
if (NETWORK === "mainnet" && process.env.E2E_ALLOW_MAINNET !== "1") throw new Error("Mainnet uses real BCH. Set E2E_ALLOW_MAINNET=1 to confirm.");
const PREFIX = NETWORK === "mainnet" ? "bitcoincash" : "bchtest";
const EXPLORER = NETWORK === "mainnet" ? "https://explorer.salemkode.com/tx/" : "https://chipnet.chaingraph.cash/tx/";
const DEPOSIT = 8_000n;
const CAP = 3_000n;
const PAY = 1_200n;
const WAIT_MS = 40 * 60 * 1000;

const provider = new FailoverElectrumProvider(NETWORK);
const log = (...a: unknown[]) => console.log(...a);
const link = (txid: string) => `${txid}  ${EXPLORER}${txid}`;
let failed = false;
const check = (cond: boolean, what: string) => {
  log(`${cond ? "ok  " : "FAIL"}  ${what}`);
  if (!cond) failed = true;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ownerKey() {
  const seed = process.env[NETWORK === "mainnet" ? "MAINNET_OWNER_SEED" : "CHIPNET_OWNER_SEED"];
  if (!seed) throw new Error("Owner seed missing: run scripts/e2e.mts address first");
  const signer = new SignatureTemplate(new Uint8Array(createHash("sha256").update(`owner|${seed}`).digest()));
  const { address } = publicKeyToP2pkhCashAddress({ publicKey: signer.publicKey, prefix: PREFIX });
  return { signer, address, pubHex: binToHex(signer.publicKey) };
}

async function broadcast(hex: string): Promise<{ txid?: string; error?: string }> {
  try {
    return { txid: await provider.sendRawTransaction(hex) };
  } catch (e) {
    return { error: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ") };
  }
}

async function main() {
  const owner = ownerKey();
  const agentPriv = randomBytes(32);
  const agent = new SignatureTemplate(new Uint8Array(agentPriv));
  const params: VaultParams = { ownerPk: owner.pubHex, agentPk: binToHex(agent.publicKey), capPerPeriod: CAP, periodBlocks: 1n, allowlist: [owner.address] };
  const contract = getVaultContract(params, provider);
  log("network:", NETWORK, "| owner:", owner.address, "| vault:", contract.address);

  const utxos = (await provider.getUtxos(owner.address)).filter((u) => !u.token);
  const first = utxos.find((u) => u.vout === 0);
  if (!first) throw new Error(`Owner has no vout-0 coin; run scripts/e2e.mts run once, or consolidate`);
  const inputs = [first, ...utxos.filter((u) => u !== first)].map((utxo) => ({ utxo, unlocker: owner.signer.unlockP2PKH() }));

  // Save the descriptor before broadcasting so a crashed run can still be withdrawn.
  mkdirSync(".e2e-vaults", { recursive: true });
  const file = `.e2e-vaults/${NETWORK}-v2cd-${contract.address.slice(-12)}.json`;
  const descriptor: VaultDescriptor = { version: 1, network: NETWORK, agentIndex: EXTERNAL_AGENT_INDEX, token: "", params: paramsToDescriptorParams(params), external: true, createdAt: Date.now() };
  writeFileSync(file, JSON.stringify(descriptor, null, 2));

  const tip0 = await provider.getBlockHeight();
  const genesis = buildGenesis({ contract, inputs, deposit: DEPOSIT, startHeight: tip0, changeAddress: owner.address });
  const g = await broadcast(genesis.builder.build());
  if (!g.txid) throw new Error(`genesis failed: ${g.error}`);
  log("tx  genesis:", link(g.txid));

  const vaultCoin = async () => {
    for (let i = 0; i < 20; i++) {
      const u = await findVaultUtxo(contract);
      if (u) return u;
      await sleep(1500);
    }
    throw new Error("vault coin not visible on Electrum");
  };
  const spend = async (u: SpendableUtxo, extra: Partial<Parameters<typeof buildAgentSpend>[0]> = {}) => {
    const tipHeight = await provider.getBlockHeight();
    const height = await coinHeight(provider, contract.address, u);
    return buildAgentSpend({ contract, params, vaultUtxo: u, agentKey: agent, to: owner.address, amount: PAY, tipHeight, coinHeight: height, ...extra });
  };

  // 2. Same period.
  let coin = await vaultCoin();
  const p1 = await spend(coin);
  check(!p1.newPeriod, "payment 1 stays in the period (vault coin unconfirmed)");
  const r1 = await broadcast(p1.builder.build());
  check(Boolean(r1.txid), `payment 1 accepted (${p1.outflow} sats outflow)`);
  if (r1.txid) log("tx  payment 1:", link(r1.txid));
  if (!r1.txid) throw new Error(`payment 1 failed: ${r1.error}`);
  // Continue from the vault coin payment 1 created (Electrum may still lag behind it).
  coin = { ...coin, txid: r1.txid, vout: 0, satoshis: coin.satoshis - p1.outflow, token: { ...coin.token!, nft: { capability: "mutable", commitment: encodeState(p1.newState) } } };

  // 3. Over the cap in the same period.
  const over = await spend(coin, { overrideNewPeriod: false });
  const r2 = await broadcast(over.builder.build());
  check(Boolean(r2.error && /mandatory-script-verify-flag-failed/i.test(r2.error)), `payment 2 over the ${CAP}-sat cap rejected by the covenant: ${r2.error?.slice(0, 120)}`);

  // 4. New period with sequence 0: fails require(this.age >= periodBlocks) in script.
  const seq0 = await spend(coin, { overrideNewPeriod: true, overrideSequence: 0 });
  const r3 = await broadcast(seq0.builder.build());
  check(Boolean(r3.error && /script-verify-flag.*Locktime requirement not satisfied/i.test(r3.error)), `new period with sequence 0 rejected in script (CSV): ${r3.error?.slice(0, 120)}`);

  // 5. New period with sequence 1 on an unconfirmed coin: BIP68 makes it non-final. If a block confirmed the coin in
  // the meantime this step would be accepted (and spend the coin), so it only runs while the coin is unconfirmed.
  if ((await coinHeight(provider, contract.address, coin)) > 0) {
    check(false, "the vault coin confirmed before step 5 could run; rerun to prove the BIP68 rejection");
  } else {
    const seq1 = await spend(coin, { overrideNewPeriod: true });
    const r4 = await broadcast(seq1.builder.build());
    check(Boolean(r4.error && /non-BIP68-final/i.test(r4.error)), `new period before the cooldown rejected by the node: ${r4.error?.slice(0, 120)}`);
    if (r4.txid) throw new Error(`step 5 was accepted (${r4.txid}): the vault coin moved; withdraw with scripts/e2e.mts withdraw ${file}`);
  }

  // 6. Wait for the cooldown (one confirmation), then a new period is accepted.
  const started = Date.now();
  let confirmedAt = 0;
  while (Date.now() - started < WAIT_MS) {
    confirmedAt = await coinHeight(provider, contract.address, coin);
    if (confirmedAt > 0) break;
    log(`… waiting for the vault coin to confirm (${Math.round((Date.now() - started) / 1000)} s)`);
    await sleep(30_000);
  }
  check(confirmedAt > 0, `vault coin confirmed at height ${confirmedAt}`);
  const p5 = await spend(coin);
  check(p5.newPeriod, "after the cooldown the builder starts a new period");
  const r5 = await broadcast(p5.builder.build());
  check(Boolean(r5.txid), `payment in the new period accepted: ${r5.error ?? ""}`);
  if (r5.txid) log("tx  new period:", link(r5.txid));
  check(p5.newState.spent === p5.outflow, `new period's spent = this payment's outflow (${p5.outflow})`);

  // 7. Withdraw, from the coin the new-period payment created (built locally: Electrum may lag behind it).
  if (r5.txid) {
    coin = { ...coin, txid: r5.txid, vout: 0, satoshis: coin.satoshis - p5.outflow, token: { ...coin.token!, nft: { capability: "mutable", commitment: encodeState(p5.newState) } } };
  }
  const w = await broadcast(buildWithdraw({ contract, vaultUtxo: coin, to: owner.address, ownerSigner: owner.signer }).build());
  check(Boolean(w.txid), `owner withdraw: ${w.error ?? ""}`);
  if (w.txid) log("tx  withdraw:", link(w.txid));

  log(failed ? "\nE2E FAILED" : "\nE2E OK");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
