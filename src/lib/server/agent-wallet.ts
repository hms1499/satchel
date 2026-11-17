import type { SpendableUtxo } from "cashscript";
import { DescriptorSchema, descriptorParams, type VaultDescriptor } from "../descriptor";
import { NETWORK } from "../config";
import {
  buildAgentSpend,
  computeNextState,
  decodeState,
  encodeState,
  findVaultUtxo,
  getVaultContract,
  remainingBudget,
  type VaultParams,
} from "../vault";
import { agentKey, attackerAddress, verifyAccess } from "./keys";
import { getProvider } from "./electrum";
import { logEvent } from "./log";

export class AgentAuthError extends Error {}

/**
 * Validates a client-supplied descriptor and checks it really belongs to one of our agents.
 * `requireToken: false` is for read-only use (status), which needs no proof of ownership: it is public chain data.
 */
export function openDescriptor(raw: unknown, { requireToken = true }: { requireToken?: boolean } = {}) {
  const parsed = DescriptorSchema.safeParse(raw);
  if (!parsed.success) throw new AgentAuthError("Invalid vault descriptor");
  const d: VaultDescriptor = parsed.data;
  if (d.network !== NETWORK) throw new AgentAuthError(`Descriptor is for ${d.network}, server runs ${NETWORK}`);
  if (requireToken && !verifyAccess(d.agentIndex, d.token)) {
    throw new AgentAuthError(
      d.token ? "Invalid agent access token" : "This vault was recovered from the blockchain, so the agent can't use it. Withdraw and create a new vault.",
    );
  }
  const key = agentKey(d.agentIndex);
  if (key.pubHex !== d.params.agentPk) throw new AgentAuthError("Descriptor agent key mismatch");
  const params = descriptorParams(d);
  const contract = getVaultContract(params, getProvider());
  return { descriptor: d, params, contract, key };
}

type Opened = ReturnType<typeof openDescriptor>;

// Electrum can lag behind our own broadcasts by a moment. Remember the vault UTXO we just created so the
// next payment in the same run spends it instead of the (already spent) one Electrum still reports.
const successor = new Map<string, { spent: string; next: SpendableUtxo }>();
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run.catch(() => undefined));
  return run;
}

/** The vault UTXO to spend next, ignoring outpoints we just learned are already spent (`skip`). */
export async function currentVaultUtxo(o: Opened, skip: ReadonlySet<string> = new Set()): Promise<SpendableUtxo | undefined> {
  const fromNetwork = await findVaultUtxo(o.contract, skip);
  const cached = successor.get(o.contract.address);
  const outpoint = (u: SpendableUtxo) => `${u.txid}:${u.vout}`;
  if (cached && fromNetwork && outpoint(fromNetwork) === cached.spent) return cached.next;
  // Electrum may lag more than one payment behind: once its view proved stale, trust our own last broadcast.
  if (!fromNetwork && skip.size > 0 && cached && !skip.has(outpoint(cached.next))) return cached.next;
  return fromNetwork;
}

export interface VaultStatus {
  address: string;
  tokenAddress: string;
  balance: string;
  state: { periodStart: number; spent: string } | null; // sats as a string (JSON has no bigint)
  tipHeight: number;
  remaining: string;
  resetsAtHeight: number;
  capPerPeriod: string;
  periodBlocks: string;
}

export async function vaultStatus(o: Opened): Promise<VaultStatus> {
  const [utxo, tipHeight] = await Promise.all([currentVaultUtxo(o), getProvider().getBlockHeight()]);
  const state = utxo ? decodeState(utxo.token!.nft!.commitment) : null;
  const budget = state ? remainingBudget(state, tipHeight, o.params) : { remaining: 0n, resetsAtHeight: 0 };
  return {
    address: o.contract.address,
    tokenAddress: o.contract.tokenAddress,
    balance: (utxo?.satoshis ?? 0n).toString(),
    state: state ? { periodStart: state.periodStart, spent: state.spent.toString() } : null,
    tipHeight,
    remaining: budget.remaining.toString(),
    resetsAtHeight: budget.resetsAtHeight,
    capPerPeriod: o.params.capPerPeriod.toString(),
    periodBlocks: o.params.periodBlocks.toString(),
  };
}

export type PaymentOutcome =
  | { ok: true; txid: string; amount: bigint; fee: bigint; spentInPeriod: bigint; remaining: bigint; balance: bigint }
  | { ok: false; reason: string; covenant: boolean; rule?: string; nodeError?: string; wouldSpend?: bigint };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Waits for Electrum to index our previous broadcast before retrying with a fresh vault UTXO (D2).
const STALE_RETRY_DELAYS_MS = process.env.NODE_ENV === "test" ? [1, 1, 1] : [800, 1600, 2400];
/** Node errors that mean "this input is already spent / unknown", i.e. our view of the vault UTXO was stale. */
const STALE_INPUT_ERROR = /txn-mempool-conflict|missing-?inputs|missingorspent|inputs-missing|already spent|UTXO not found/i;
/** Node errors that mean the scripts (the covenant) failed; also matches "non-mandatory-script-verify-flag". */
const SCRIPT_ERROR = /mandatory-script-verify-flag-failed/i;

/**
 * Why a broadcast failed. Only a failing script (a `require` that fails locally, or a script-verification error from
 * the node) is the covenant; spent/unknown inputs mean our view of the vault was stale; anything else is "other".
 */
export function classifyBroadcastError(nodeError: string, failingRequire: string | undefined): "covenant" | "stale" | "other" {
  if (failingRequire || SCRIPT_ERROR.test(nodeError)) return "covenant";
  if (STALE_INPUT_ERROR.test(nodeError)) return "stale";
  return "other";
}

const BUSY = "The vault is busy: the previous payment is still propagating. Try again in a few seconds.";

/** Extracts the failing CashScript `require` statement from a local debug evaluation. */
function failingRule(builder: { debug: () => unknown }): string | undefined {
  try {
    builder.debug();
    return undefined;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.match(/Failing statement: (.+)/)?.[1]?.trim();
  }
}

/**
 * Broadcasts a payment from the vault. We deliberately do NOT pre-check the budget: the covenant is the
 * enforcement layer, and an over-budget payment is rejected by the network itself.
 */
export async function payFromVault(
  o: Opened,
  to: string,
  amount: bigint,
  memo?: string,
  tamper?: { overrideRecipientIndex?: number },
): Promise<PaymentOutcome> {
  const started = Date.now();
  const outcome = await withLock(o.contract.address, () => payOnce(o, to, amount, memo, tamper));
  logEvent("payment", {
    vault: o.contract.address.slice(-12),
    to: to.slice(-12),
    amount,
    ok: outcome.ok,
    ...(outcome.ok
      ? { txid: outcome.txid, fee: outcome.fee, spentInPeriod: outcome.spentInPeriod }
      : { covenant: outcome.covenant, reason: outcome.reason, rule: outcome.rule, nodeError: outcome.nodeError }),
    ms: Date.now() - started,
  });
  return outcome;
}

async function payOnce(
  o: Opened,
  to: string,
  amount: bigint,
  memo: string | undefined,
  tamper: { overrideRecipientIndex?: number } | undefined,
): Promise<PaymentOutcome> {
  const stale = new Set<string>(); // vault outpoints the node told us are already spent
  for (let attempt = 0; attempt <= STALE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(STALE_RETRY_DELAYS_MS[attempt - 1]); // let Electrum index the last broadcast
    const vaultUtxo = await currentVaultUtxo(o, stale);
    if (!vaultUtxo) {
      if (stale.size > 0) continue;
      return { ok: false, covenant: false, reason: "Vault not found or already closed" };
    }
    const tipHeight = await getProvider().getBlockHeight();
    let built;
    try {
      built = buildAgentSpend({
        contract: o.contract,
        params: o.params,
        vaultUtxo,
        agentKey: o.key.signer,
        to,
        amount,
        memo,
        tipHeight,
        overrideRecipientIndex: tamper?.overrideRecipientIndex,
      });
    } catch (e) {
      return { ok: false, covenant: false, reason: e instanceof Error ? e.message : String(e) };
    }
    const { builder, outflow, newState, fee } = built;
    try {
      const txid = await getProvider().sendRawTransaction(builder.build());
      successor.set(o.contract.address, {
        spent: `${vaultUtxo.txid}:${vaultUtxo.vout}`,
        next: { ...vaultUtxo, txid, vout: 0, satoshis: vaultUtxo.satoshis - outflow, token: { ...vaultUtxo.token!, nft: { capability: "mutable", commitment: encodeState(newState) } } },
      });
      const budget = remainingBudget(newState, tipHeight, o.params);
      return { ok: true, txid, amount, fee, spentInPeriod: newState.spent, remaining: budget.remaining, balance: vaultUtxo.satoshis - outflow };
    } catch (e) {
      const nodeError = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);
      const rule = failingRule(builder);
      const kind = classifyBroadcastError(nodeError, rule);
      if (kind === "covenant") {
        const { next } = computeNextState(decodeState(vaultUtxo.token!.nft!.commitment), outflow, tipHeight, o.params);
        return { ok: false, covenant: true, reason: "Rejected by the network: the vault covenant does not allow this payment", rule, nodeError, wouldSpend: next.spent };
      }
      if (kind === "other") return { ok: false, covenant: false, reason: `The network did not accept the payment: ${nodeError}`, nodeError };
      // Stale view of the vault (e.g. a fresh serverless instance and a lagging Electrum index): retry.
      stale.add(`${vaultUtxo.txid}:${vaultUtxo.vout}`);
    }
  }
  return { ok: false, covenant: false, reason: BUSY };
}

export function demoAttackerAddress() {
  return attackerAddress();
}

export type { VaultParams };
