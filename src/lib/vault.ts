import {
  Contract,
  TransactionBuilder,
  SignatureTemplate,
  placeholderSignature,
  type NetworkProvider,
  type SpendableUtxo,
  type Unlocker,
} from "cashscript";
import {
  binToHex,
  cashAddressToLockingBytecode,
  hexToBin,
  sha256,
  hash256,
  flattenBinArray,
} from "@bitauth/libauth";
import artifact from "./contract/Satchel.artifact.json";

export const DUST = 1000n; // vault output keeps at least this many sats (token output)
export const MIN_PAYMENT = 546n;

export interface VaultParams {
  ownerPk: string; // hex, compressed pubkey
  agentPk: string; // hex, compressed pubkey
  capPerPeriod: bigint; // sats, fees included
  periodBlocks: bigint;
  allowlist: string[]; // cashaddresses the agent may pay
}

export interface VaultState {
  periodStart: number; // block height
  spent: bigint; // sats spent in the current period
}

export function lockingBytecodeOf(address: string): Uint8Array {
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === "string") throw new Error(`Invalid address ${address}: ${result}`);
  return result.bytecode;
}

/** concat(sha256(lockingBytecode_i)) — passed to `spend` as the `allowlist` argument. */
export function allowlistBytes(allowlist: string[]): Uint8Array {
  if (allowlist.length === 0) throw new Error("Allowlist must not be empty");
  return flattenBinArray(allowlist.map((a) => sha256.hash(lockingBytecodeOf(a))));
}

export function allowlistHash(allowlist: string[]): Uint8Array {
  return hash256(allowlistBytes(allowlist));
}

export function getVaultContract(params: VaultParams, provider: NetworkProvider) {
  return new Contract(
    artifact,
    [
      hexToBin(params.ownerPk),
      hexToBin(params.agentPk),
      params.capPerPeriod,
      params.periodBlocks,
      allowlistHash(params.allowlist),
    ],
    { provider, contractType: "p2sh32" },
  );
}

export type VaultContract = ReturnType<typeof getVaultContract>;

function writeLE(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n || (out[bytes - 1] & 0x80) !== 0) throw new Error(`Value ${value} does not fit in ${bytes} bytes`);
  return out;
}

function readLE(bin: Uint8Array): bigint {
  let v = 0n;
  for (let i = bin.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bin[i]);
  return v;
}

export function encodeState(state: VaultState): string {
  return binToHex(flattenBinArray([writeLE(BigInt(state.periodStart), 4), writeLE(state.spent, 8)]));
}

export function decodeState(commitmentHex: string): VaultState {
  const bin = hexToBin(commitmentHex);
  if (bin.length !== 12) throw new Error("Invalid vault commitment");
  return { periodStart: Number(readLE(bin.slice(0, 4))), spent: readLE(bin.slice(4)) };
}

/** Mirrors the covenant's budget logic so the UI/agent can predict the outcome of a spend. */
export function computeNextState(
  state: VaultState,
  outflow: bigint,
  locktime: number,
  params: Pick<VaultParams, "periodBlocks" | "capPerPeriod">,
) {
  const nextPeriod = state.periodStart + Number(params.periodBlocks);
  const rolled = locktime >= nextPeriod;
  const next: VaultState = rolled
    ? { periodStart: locktime, spent: outflow }
    : { periodStart: state.periodStart, spent: state.spent + outflow };
  return { next, rolled, withinCap: next.spent <= params.capPerPeriod };
}

/** Remaining budget for the period the next block would be in. */
export function remainingBudget(state: VaultState, tipHeight: number, params: Pick<VaultParams, "periodBlocks" | "capPerPeriod">) {
  const rolled = tipHeight >= state.periodStart + Number(params.periodBlocks);
  const spent = rolled ? 0n : state.spent;
  const left = params.capPerPeriod - spent;
  return {
    remaining: left > 0n ? left : 0n,
    resetsAtHeight: rolled ? tipHeight + Number(params.periodBlocks) : state.periodStart + Number(params.periodBlocks),
  };
}

export function isVaultUtxo(utxo: SpendableUtxo): boolean {
  return utxo.token?.nft?.capability === "mutable" && utxo.token.nft.commitment.length === 24 && utxo.token.amount === 0n;
}

export async function findVaultUtxo(contract: VaultContract): Promise<SpendableUtxo | undefined> {
  const utxos = await contract.getUtxos();
  // There should only be one; pick the largest if someone sent extra state NFTs.
  return utxos.filter(isVaultUtxo).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
}

const FEE_RATE = 1n; // sats/byte

export interface AgentSpendRequest {
  contract: VaultContract;
  params: VaultParams;
  vaultUtxo: SpendableUtxo;
  agentKey: SignatureTemplate;
  to: string;
  amount: bigint;
  memo?: string; // hex payload for an OP_RETURN output
  tipHeight: number;
  /** Testing/demo only: lie about the new state instead of computing it honestly. */
  overrideNextState?: VaultState;
  /** Testing/demo only: force the allowlist index used (to pay a non-allowlisted address). */
  overrideRecipientIndex?: number;
  extraOutputs?: { to: string; amount: bigint }[];
}

export function buildAgentSpend(req: AgentSpendRequest) {
  const { contract, params, vaultUtxo, agentKey, to, amount, memo, tipHeight } = req;
  if (amount < MIN_PAYMENT) throw new Error(`Payment must be at least ${MIN_PAYMENT} sats`);
  const state = decodeState(vaultUtxo.token!.nft!.commitment);
  const list = allowlistBytes(params.allowlist);
  const index = req.overrideRecipientIndex ?? params.allowlist.indexOf(to);
  if (index < 0) throw new Error(`${to} is not in the vault allowlist`);

  const extraTotal = (req.extraOutputs ?? []).reduce((s, o) => s + o.amount, 0n);
  const build = (fee: bigint) => {
    const outflow = amount + fee + extraTotal;
    const { next } = computeNextState(state, outflow, tipHeight, params);
    const newState = req.overrideNextState ?? next;
    const builder = new TransactionBuilder({ provider: contract.provider })
      .addInput(vaultUtxo, contract.unlock.spend(agentKey, list, BigInt(index)))
      .addOutput({
        to: contract.tokenAddress,
        amount: vaultUtxo.satoshis - outflow,
        token: {
          category: vaultUtxo.token!.category,
          amount: 0n,
          nft: { capability: "mutable", commitment: encodeState(newState) },
        },
      })
      .addOutput({ to, amount });
    if (memo) builder.addOpReturnOutput([`0x${memo}`]);
    for (const extra of req.extraOutputs ?? []) builder.addOutput(extra);
    builder.setLocktime(tipHeight);
    return { builder, outflow, newState };
  };

  // Two-pass fee estimation: build with a provisional fee, then use the real size.
  const provisional = build(500n);
  const size = provisional.builder.getTransactionSize();
  const fee = size * FEE_RATE + 2n;
  const final = build(fee);
  if (vaultUtxo.satoshis - final.outflow < DUST) throw new Error("Vault balance too low for this payment");
  return { ...final, fee };
}

/** Owner withdraws everything (closing the vault and burning its state NFT). */
export function buildWithdraw(opts: {
  contract: VaultContract;
  vaultUtxo: SpendableUtxo;
  to: string;
  ownerSigner?: SignatureTemplate; // omit to build a WizardConnect placeholder signature
}) {
  const { contract, vaultUtxo, to } = opts;
  const unlocker: Unlocker = contract.unlock.withdraw(opts.ownerSigner ?? placeholderSignature());
  const draft = new TransactionBuilder({ provider: contract.provider })
    .addInput(vaultUtxo, unlocker)
    .addOutput({ to, amount: vaultUtxo.satoshis - 500n });
  const fee = draft.getTransactionSize() * FEE_RATE + 2n;
  return new TransactionBuilder({ provider: contract.provider })
    .addInput(vaultUtxo, unlocker)
    .addOutput({ to, amount: vaultUtxo.satoshis - fee });
}

/**
 * Owner creates (genesis) a vault: the first input must spend an outpoint with index 0, whose txid
 * becomes the state NFT's token category.
 */
export function buildGenesis(opts: {
  contract: VaultContract;
  inputs: { utxo: SpendableUtxo; unlocker: Unlocker }[];
  deposit: bigint;
  startHeight: number;
  changeAddress: string;
  /** OP_RETURN chunks (see recovery.ts) so the owner can rebuild the vault from chain alone. */
  opReturn?: string[];
}) {
  const { contract, inputs, deposit, startHeight, changeAddress, opReturn } = opts;
  if (inputs.length === 0 || inputs[0].utxo.vout !== 0) throw new Error("Genesis input must have vout 0");
  if (inputs.some((i) => i.utxo.token)) throw new Error("Genesis inputs must not hold tokens");
  const total = inputs.reduce((s, i) => s + i.utxo.satoshis, 0n);
  const category = inputs[0].utxo.txid;

  const build = (fee: bigint) => {
    const builder = new TransactionBuilder({ provider: contract.provider });
    for (const i of inputs) builder.addInput(i.utxo, i.unlocker);
    builder.addOutput({
      to: contract.tokenAddress,
      amount: deposit,
      token: { category, amount: 0n, nft: { capability: "mutable", commitment: encodeState({ periodStart: startHeight, spent: 0n }) } },
    });
    if (opReturn) builder.addOpReturnOutput(opReturn);
    const change = total - deposit - fee;
    if (change >= MIN_PAYMENT) builder.addOutput({ to: changeAddress, amount: change });
    return builder;
  };
  const size = build(500n).getTransactionSize();
  const fee = size * FEE_RATE + 2n;
  if (total < deposit + fee) throw new Error(`Insufficient funds: have ${total}, need ${deposit + fee}`);
  return { builder: build(fee), category, fee };
}
