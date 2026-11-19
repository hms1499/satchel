import type { NetworkProvider, SignatureTemplate, SpendableUtxo } from "cashscript";
import {
  buildAgentSpend,
  computeNextState,
  decodeState,
  encodeState,
  findVaultUtxo,
  remainingBudget,
  type VaultContract,
  type VaultParams,
} from "./vault";

/**
 * Paying from a vault with the agent key: shared by Satchel's hosted agent (server) and the satchel-pay-mcp server.
 * No server secrets or Next.js config here. We deliberately do NOT pre-check the budget: the covenant is the
 * enforcement layer, and an over-budget payment is rejected by the network itself.
 */

export type PaymentOutcome =
  | { ok: true; txid: string; amount: bigint; fee: bigint; spentInPeriod: bigint; remaining: bigint; balance: bigint }
  | { ok: false; reason: string; covenant: boolean; rule?: string; nodeError?: string; wouldSpend?: bigint };

export interface SpendTarget {
  contract: VaultContract;
  params: VaultParams;
  agentSigner: SignatureTemplate;
  provider: NetworkProvider;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Waits for Electrum to index our previous broadcast before retrying with a fresh vault UTXO.
const STALE_RETRY_DELAYS_MS = process.env.NODE_ENV === "test" ? [1, 1, 1] : [800, 1600, 2400];
/** Node errors that mean "this input is already spent / unknown", i.e. our view of the vault UTXO was stale. */
const STALE_INPUT_ERROR = /txn-mempool-conflict|missing-?inputs|missingorspent|inputs-missing|already spent|UTXO not found/i;
/** Node errors that mean the scripts (the covenant) failed; also matches "non-mandatory-script-verify-flag". */
const SCRIPT_ERROR = /mandatory-script-verify-flag-failed/i;
const BUSY = "The vault is busy: the previous payment is still propagating. Try again in a few seconds.";

/**
 * Why a broadcast failed. Only a failing script (a `require` that fails locally, or a script-verification error from
 * the node) is the covenant; spent/unknown inputs mean our view of the vault was stale; anything else is "other".
 */
export function classifyBroadcastError(nodeError: string, failingRequire: string | undefined): "covenant" | "stale" | "other" {
  if (failingRequire || SCRIPT_ERROR.test(nodeError)) return "covenant";
  if (STALE_INPUT_ERROR.test(nodeError)) return "stale";
  return "other";
}

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
 * Pays from vaults. Each instance keeps its own state, keyed by contract address: the vault UTXO its last broadcast
 * created (Electrum can lag behind our own broadcasts) and a lock that serializes payments per vault.
 */
export class VaultSpender {
  private successor = new Map<string, { spent: string; next: SpendableUtxo }>();
  private locks = new Map<string, Promise<unknown>>();

  /** The vault UTXO to spend next, ignoring outpoints we just learned are already spent (`skip`). */
  async currentVaultUtxo(t: Pick<SpendTarget, "contract">, skip: ReadonlySet<string> = new Set()): Promise<SpendableUtxo | undefined> {
    const fromNetwork = await findVaultUtxo(t.contract, skip);
    const cached = this.successor.get(t.contract.address);
    const outpoint = (u: SpendableUtxo) => `${u.txid}:${u.vout}`;
    if (cached && fromNetwork && outpoint(fromNetwork) === cached.spent && !skip.has(outpoint(cached.next))) return cached.next;
    // Electrum may lag more than one payment behind: once its view proved stale, trust our own last broadcast.
    if (!fromNetwork && skip.size > 0 && cached && !skip.has(outpoint(cached.next))) return cached.next;
    return fromNetwork;
  }

  /** Broadcasts a payment of `amount` to `to` from the vault (serialized per vault). */
  pay(t: SpendTarget, to: string, amount: bigint, memo?: string, tamper?: { overrideRecipientIndex?: number }): Promise<PaymentOutcome> {
    const key = t.contract.address;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.payOnce(t, to, amount, memo, tamper));
    this.locks.set(key, run.catch(() => undefined));
    return run;
  }

  private async payOnce(
    t: SpendTarget,
    to: string,
    amount: bigint,
    memo: string | undefined,
    tamper: { overrideRecipientIndex?: number } | undefined,
  ): Promise<PaymentOutcome> {
    const stale = new Set<string>(); // vault outpoints the node told us are already spent
    for (let attempt = 0; attempt <= STALE_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(STALE_RETRY_DELAYS_MS[attempt - 1]); // let Electrum index the last broadcast
      const vaultUtxo = await this.currentVaultUtxo(t, stale);
      if (!vaultUtxo) {
        if (stale.size > 0) continue;
        return { ok: false, covenant: false, reason: "Vault not found or already closed" };
      }
      const tipHeight = await t.provider.getBlockHeight();
      let built;
      try {
        built = buildAgentSpend({
          contract: t.contract,
          params: t.params,
          vaultUtxo,
          agentKey: t.agentSigner,
          to,
          amount,
          memo,
          tipHeight,
          coinHeight: 0, // wired in Task 2
          overrideRecipientIndex: tamper?.overrideRecipientIndex,
        });
      } catch (e) {
        return { ok: false, covenant: false, reason: e instanceof Error ? e.message : String(e) };
      }
      const { builder, outflow, newState, fee, newPeriod } = built;
      try {
        const txid = await t.provider.sendRawTransaction(builder.build());
        this.successor.set(t.contract.address, {
          spent: `${vaultUtxo.txid}:${vaultUtxo.vout}`,
          next: { ...vaultUtxo, txid, vout: 0, satoshis: vaultUtxo.satoshis - outflow, token: { ...vaultUtxo.token!, nft: { capability: "mutable", commitment: encodeState(newState) } } },
        });
        const budget = remainingBudget(newState, 0, tipHeight, t.params);
        return { ok: true, txid, amount, fee, spentInPeriod: newState.spent, remaining: budget.remaining, balance: vaultUtxo.satoshis - outflow };
      } catch (e) {
        const nodeError = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);
        const rule = failingRule(builder);
        const kind = classifyBroadcastError(nodeError, rule);
        if (kind === "covenant") {
          const { next } = computeNextState(decodeState(vaultUtxo.token!.nft!.commitment), outflow, newPeriod, tipHeight, t.params);
          return { ok: false, covenant: true, reason: "Rejected by the network: the vault covenant does not allow this payment", rule, nodeError, wouldSpend: next.spent };
        }
        if (kind === "other") return { ok: false, covenant: false, reason: `The network did not accept the payment: ${nodeError}`, nodeError };
        // Stale view of the vault (e.g. a fresh serverless instance and a lagging Electrum index): retry.
        stale.add(`${vaultUtxo.txid}:${vaultUtxo.vout}`);
      }
    }
    return { ok: false, covenant: false, reason: BUSY };
  }
}
