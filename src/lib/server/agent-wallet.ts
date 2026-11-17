import type { SpendableUtxo } from "cashscript";
import { DescriptorSchema, descriptorParams, type VaultDescriptor } from "../descriptor";
import { NETWORK } from "../config";
import { decodeState, getVaultContract, remainingBudget, type VaultParams } from "../vault";
import { VaultSpender, type PaymentOutcome, type SpendTarget } from "../spend";
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
  if (requireToken && d.external) throw new AgentAuthError("This vault's agent runs in your own MCP client, not on Satchel.");
  if (requireToken && !verifyAccess(d.agentIndex, d.token)) {
    throw new AgentAuthError(
      d.token ? "Invalid agent access token" : "This vault was recovered from the blockchain, so the agent can't use it. Withdraw and create a new vault.",
    );
  }
  // Read-only use (status) also works for external agents, whose key Satchel does not have.
  const key = d.external ? null : agentKey(d.agentIndex);
  if (key && key.pubHex !== d.params.agentPk) throw new AgentAuthError("Descriptor agent key mismatch");
  const params = descriptorParams(d);
  const contract = getVaultContract(params, getProvider());
  return { descriptor: d, params, contract, key };
}

type Opened = ReturnType<typeof openDescriptor>;

// One spender for the hosted agent: it keeps the per-vault lock and the "last broadcast" cache (see spend.ts).
const spender = new VaultSpender();

/** The vault UTXO to spend next, ignoring outpoints we just learned are already spent (`skip`). */
export function currentVaultUtxo(o: Opened, skip: ReadonlySet<string> = new Set()): Promise<SpendableUtxo | undefined> {
  return spender.currentVaultUtxo(o, skip);
}

function target(o: Opened): SpendTarget {
  if (!o.key) throw new AgentAuthError("This vault's agent runs in your own MCP client, not on Satchel.");
  return { contract: o.contract, params: o.params, agentSigner: o.key.signer, provider: getProvider() };
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
  const outcome = await spender.pay(target(o), to, amount, memo, tamper);
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

export function demoAttackerAddress() {
  return attackerAddress();
}

export type { VaultParams, PaymentOutcome };
export { classifyBroadcastError } from "../spend";
