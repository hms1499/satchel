import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeAuthenticationInstructions,
  decodeTransaction,
  hexToBin,
  lockingBytecodeToAddressContents,
  lockingBytecodeToCashAddress,
  sha256,
  type Output,
} from "@bitauth/libauth";
import { NETWORK } from "../config";
import { normalizePayee, prefixFor } from "../payees";
import { InputError } from "../../../provider-kit/src/index";
import type { ElectrumNetworkProvider } from "cashscript";
import { getProvider } from "./electrum";

/** One Electrum request. */
export type Rpc = (method: string, ...params: unknown[]) => Promise<unknown>;

const RPC_TIMEOUT_MS = 8000;

/** Bounds every Electrum call, so a stalled server fails the request instead of hanging it. */
export function withTimeout(rpc: Rpc, ms = RPC_TIMEOUT_MS): Rpc {
  return (method, ...params) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Electrum ${method} timed out after ${ms} ms`)), ms);
    });
    return Promise.race([rpc(method, ...params), timeout]).finally(() => clearTimeout(timer));
  };
}

/** The app's Electrum server (the network of this deployment), with the time limit. */
export const electrumRpc: Rpc = withTimeout((method, ...params) =>
  getProvider().performRequest(method, ...(params as Parameters<ElectrumNetworkProvider["performRequest"]>[1][])),
);

export type AddressInfo = {
  address: string;
  network: typeof NETWORK;
  balance: { confirmed: string; unconfirmed: string };
  utxoCount: number;
  tokens: { category: string; fungible: string; nfts: number }[];
  recent: { txid: string; height: number }[];
};

export type TxOutputInfo = {
  index: number;
  value: string;
  address: string | null;
  type: string;
  token: { category: string; amount: string; nft: { capability: string; commitment: string } | null } | null;
  opReturn: { hex: string; text: string | null } | null;
};

export type TxInfo = {
  txid: string;
  confirmations: number;
  height: number | null;
  size: number;
  fee: string | null;
  inputs: { txid: string; vout: number }[];
  outputs: TxOutputInfo[];
};

const RECENT_LIMIT = 10;
const MAX_FEE_INPUTS = 20;
const TXID = /^[0-9a-f]{64}$/;

/** The canonical address on this app's network, or a 400. */
export function checkAddress(address: string | null): string {
  if (!address) throw new InputError("address is required");
  const r = normalizePayee(address, NETWORK);
  if (!r.ok) throw new InputError(r.error.replace("this vault is on", "this service is on"));
  return r.address;
}

export function checkTxid(txid: string | null): string {
  if (!txid || !TXID.test(txid)) throw new InputError("txid must be 64 lowercase hex characters");
  return txid;
}

/** Fulcrum/bitcoind wording for a txid it does not know. */
const isNotFound = (e: unknown) => /no such mempool or blockchain transaction|no transaction matching|not found/i.test(String(e));

/** Raw tx hex. An unknown txid is a 404; an Electrum failure stays a plain error (not the caller's fault). */
export async function fetchTransaction(txid: string, rpc: Rpc): Promise<string> {
  try {
    return String(await rpc("blockchain.transaction.get", txid));
  } catch (e) {
    if (isNotFound(e)) throw new InputError("transaction not found", 404);
    throw e;
  }
}

type ElectrumUtxo = { token_data?: { amount: string; category: string; nft?: unknown } };
type ElectrumHistory = { tx_hash: string; height: number }[];

/** Blocks back from the tip to look for recent history before asking for all of it (about a week, then ~5 months). */
const HISTORY_WINDOWS = [1_000, 20_000];

/**
 * Enough history to hold the newest entries. A busy address can have tens of thousands of entries (the full list
 * takes Fulcrum >10 s), so ask for recent blocks first: if a window already holds RECENT_LIMIT entries, nothing
 * older can be among the newest.
 */
async function recentHistory(scripthash: string, rpc: Rpc): Promise<ElectrumHistory> {
  const { height: tip } = (await rpc("blockchain.headers.get_tip")) as { height: number };
  for (const window of HISTORY_WINDOWS) {
    const from = tip - window;
    if (from <= 0) break;
    const entries = (await rpc("blockchain.scripthash.get_history", scripthash, from, -1)) as ElectrumHistory;
    if (entries.length >= RECENT_LIMIT) return entries;
  }
  return (await rpc("blockchain.scripthash.get_history", scripthash)) as ElectrumHistory;
}

export async function addressInfo(address: string, rpc: Rpc): Promise<AddressInfo> {
  const canonical = checkAddress(address);
  const locking = cashAddressToLockingBytecode(canonical);
  if (typeof locking === "string") throw new InputError(locking);
  const scripthash = binToHex(sha256.hash(locking.bytecode).reverse());
  const [balance, utxos, history] = await Promise.all([
    rpc("blockchain.scripthash.get_balance", scripthash, "include_tokens") as Promise<{ confirmed: number; unconfirmed: number }>,
    rpc("blockchain.scripthash.listunspent", scripthash, "include_tokens") as Promise<ElectrumUtxo[]>,
    recentHistory(scripthash, rpc),
  ]);

  const byCategory = new Map<string, { fungible: bigint; nfts: number }>();
  for (const { token_data: t } of utxos) {
    if (!t) continue;
    const entry = byCategory.get(t.category) ?? { fungible: 0n, nfts: 0 };
    entry.fungible += BigInt(t.amount);
    if (t.nft) entry.nfts += 1;
    byCategory.set(t.category, entry);
  }

  // Mempool entries (height 0, or -1 with unconfirmed parents) first, then the newest blocks.
  const rank = (h: number) => (h <= 0 ? Number.POSITIVE_INFINITY : h);
  const recent = [...history]
    .sort((a, b) => rank(b.height) - rank(a.height))
    .slice(0, RECENT_LIMIT)
    .map((h) => ({ txid: h.tx_hash, height: h.height }));

  return {
    address: canonical,
    network: NETWORK,
    balance: { confirmed: BigInt(balance.confirmed).toString(), unconfirmed: BigInt(balance.unconfirmed).toString() },
    utxoCount: utxos.length,
    tokens: [...byCategory].map(([category, t]) => ({ category, fungible: t.fungible.toString(), nfts: t.nfts })),
    recent,
  };
}

const OP_RETURN = 0x6a;
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}\n\t]+$/u;

/** The pushes of an OP_RETURN that are printable UTF-8, joined by spaces. */
function opReturnText(bytecode: Uint8Array): string | null {
  const parts: string[] = [];
  for (const instruction of decodeAuthenticationInstructions(bytecode.slice(1))) {
    if (!("data" in instruction) || instruction.data.length === 0) continue;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(instruction.data);
    } catch {
      continue;
    }
    if (PRINTABLE.test(text)) parts.push(text);
  }
  return parts.length ? parts.join(" ") : null;
}

function describeOutput(output: Output, index: number): TxOutputInfo {
  const bytecode = output.lockingBytecode;
  const token = output.token
    ? {
        category: binToHex(output.token.category),
        amount: output.token.amount.toString(),
        nft: output.token.nft ? { capability: output.token.nft.capability, commitment: binToHex(output.token.nft.commitment) } : null,
      }
    : null;
  if (bytecode[0] === OP_RETURN) {
    return {
      index,
      value: output.valueSatoshis.toString(),
      address: null,
      type: "op_return",
      token,
      opReturn: { hex: binToHex(bytecode.slice(1)), text: opReturnText(bytecode) },
    };
  }
  const contents = lockingBytecodeToAddressContents(bytecode);
  const encoded = lockingBytecodeToCashAddress({ bytecode, prefix: prefixFor(NETWORK), tokenSupport: token !== null });
  return {
    index,
    value: output.valueSatoshis.toString(),
    address: typeof encoded === "string" ? null : encoded.address,
    type: contents.type.toLowerCase(),
    token,
    opReturn: null,
  };
}

function decode(raw: string) {
  const tx = decodeTransaction(hexToBin(raw));
  if (typeof tx === "string") throw new Error(`cannot decode transaction: ${tx}`);
  return tx;
}

/** Sum of the spent outputs minus the outputs; null when any input cannot be fetched or there are too many. */
async function computeFee(inputs: TxInfo["inputs"], outputTotal: bigint, rpc: Rpc): Promise<string | null> {
  if (inputs.length === 0 || inputs.length > MAX_FEE_INPUTS) return null;
  try {
    const parents = new Map<string, Promise<ReturnType<typeof decode>>>();
    for (const { txid } of inputs) if (!parents.has(txid)) parents.set(txid, fetchTransaction(txid, rpc).then(decode));
    let inputTotal = 0n;
    for (const { txid, vout } of inputs) {
      const spent = (await parents.get(txid)!).outputs[vout];
      if (!spent) return null;
      inputTotal += spent.valueSatoshis;
    }
    return (inputTotal - outputTotal).toString();
  } catch {
    return null; // a coinbase input, a pruned or unknown parent, or an Electrum hiccup
  }
}

export async function txInfo(txid: string, rpc: Rpc): Promise<TxInfo> {
  checkTxid(txid);
  const [raw, height, tip] = await Promise.all([
    fetchTransaction(txid, rpc),
    rpc("blockchain.transaction.get_height", txid) as Promise<number>,
    rpc("blockchain.headers.get_tip") as Promise<{ height: number }>,
  ]);
  const tx = decode(raw);
  const inputs = tx.inputs.map((i) => ({ txid: binToHex(i.outpointTransactionHash), vout: i.outpointIndex }));
  const outputTotal = tx.outputs.reduce((sum, o) => sum + o.valueSatoshis, 0n);
  const confirmed = height > 0;
  return {
    txid,
    confirmations: confirmed ? Math.max(tip.height - height + 1, 1) : 0,
    height: confirmed ? height : null,
    size: raw.length / 2,
    fee: await computeFee(inputs, outputTotal, rpc),
    inputs,
    outputs: tx.outputs.map(describeOutput),
  };
}
