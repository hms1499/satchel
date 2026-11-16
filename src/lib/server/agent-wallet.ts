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
  type VaultState,
} from "../vault";
import { agentKey, attackerAddress, verifyAccess } from "./keys";
import { getProvider } from "./electrum";

export class AgentAuthError extends Error {}

/** Validates a client-supplied descriptor and checks it really belongs to one of our agents. */
export function openDescriptor(raw: unknown) {
  const parsed = DescriptorSchema.safeParse(raw);
  if (!parsed.success) throw new AgentAuthError("Invalid vault descriptor");
  const d: VaultDescriptor = parsed.data;
  if (d.network !== NETWORK) throw new AgentAuthError(`Descriptor is for ${d.network}, server runs ${NETWORK}`);
  if (!verifyAccess(d.agentIndex, d.token)) throw new AgentAuthError("Invalid agent access token");
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

export async function currentVaultUtxo(o: Opened): Promise<SpendableUtxo | undefined> {
  const fromNetwork = await findVaultUtxo(o.contract);
  const cached = successor.get(o.contract.address);
  if (cached && fromNetwork && `${fromNetwork.txid}:${fromNetwork.vout}` === cached.spent) return cached.next;
  return fromNetwork;
}

export interface VaultStatus {
  address: string;
  tokenAddress: string;
  balance: string;
  state: VaultState | null;
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
    state: state ? { periodStart: state.periodStart, spent: state.spent } : null,
    tipHeight,
    remaining: budget.remaining.toString(),
    resetsAtHeight: budget.resetsAtHeight,
    capPerPeriod: o.params.capPerPeriod.toString(),
    periodBlocks: o.params.periodBlocks.toString(),
  };
}

export type PaymentOutcome =
  | { ok: true; txid: string; amount: bigint; fee: bigint; spentInPeriod: bigint; remaining: bigint; balance: bigint }
  | { ok: false; reason: string; rule?: string; nodeError?: string; wouldSpend?: bigint };

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
  return withLock(o.contract.address, async () => {
    const vaultUtxo = await currentVaultUtxo(o);
    if (!vaultUtxo) return { ok: false, reason: "Vault not found or already closed" };
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
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    const { builder, outflow, newState, fee } = built;
    const hex = builder.build();
    try {
      const txid = await getProvider().sendRawTransaction(hex);
      successor.set(o.contract.address, {
        spent: `${vaultUtxo.txid}:${vaultUtxo.vout}`,
        next: { ...vaultUtxo, txid, vout: 0, satoshis: vaultUtxo.satoshis - outflow, token: { ...vaultUtxo.token!, nft: { capability: "mutable", commitment: encodeState(newState) } } },
      });
      const budget = remainingBudget(newState, tipHeight, o.params);
      return { ok: true, txid, amount, fee, spentInPeriod: newState.spent, remaining: budget.remaining, balance: vaultUtxo.satoshis - outflow };
    } catch (e) {
      const nodeError = e instanceof Error ? e.message : String(e);
      const state = decodeState(vaultUtxo.token!.nft!.commitment);
      const { next } = computeNextState(state, outflow, tipHeight, o.params);
      return {
        ok: false,
        reason: "Rejected by the network: the vault covenant does not allow this payment",
        rule: failingRule(builder),
        nodeError: nodeError.split("\n")[0].slice(0, 300),
        wouldSpend: next.spent,
      };
    }
  });
}

export function demoAttackerAddress() {
  return attackerAddress();
}

export type { VaultParams };
