"use client";

import type { NetworkProvider, SpendableUtxo, Utxo } from "cashscript";
import { cashAddressToLockingBytecode, lockingBytecodeToCashAddress, binToHex, hexToBin } from "@bitauth/libauth";
import { NETWORK } from "../config";

async function chain<T>(body: unknown): Promise<T> {
  const res = await fetch("/api/chain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `chain request failed (${res.status})`);
  return data as T;
}

type WireUtxo = { txid: string; vout: number; satoshis: string; token?: { amount: string; category: string; nft?: { capability: "none" | "mutable" | "minting"; commitment: string } } };

function fromWire(u: WireUtxo, lockingBytecode: Uint8Array): SpendableUtxo {
  const utxo: Utxo = {
    txid: u.txid,
    vout: u.vout,
    satoshis: BigInt(u.satoshis),
    ...(u.token ? { token: { amount: BigInt(u.token.amount), category: u.token.category, ...(u.token.nft ? { nft: u.token.nft } : {}) } } : {}),
  };
  return { ...utxo, lockingBytecode: binToHex(lockingBytecode) };
}

export async function getUtxosFor(addresses: string[]): Promise<Record<string, SpendableUtxo[]>> {
  const { utxos } = await chain<{ utxos: Record<string, WireUtxo[]> }>({ op: "utxos", addresses });
  const out: Record<string, SpendableUtxo[]> = {};
  for (const [address, list] of Object.entries(utxos)) {
    const lb = cashAddressToLockingBytecode(address);
    if (typeof lb === "string") continue;
    out[address] = list.map((u) => fromWire(u, lb.bytecode));
  }
  return out;
}

export const getHistory = async (addresses: string[]) => (await chain<{ txids: string[] }>({ op: "history", addresses })).txids;
export const getTransactions = async (txids: string[]) => (await chain<{ txs: { txid: string; hex: string }[] }>({ op: "txs", txids })).txs;
export const getBlockHeight = async () => (await chain<{ height: number }>({ op: "height" })).height;
export const broadcast = async (hex: string) => (await chain<{ txid: string }>({ op: "broadcast", hex })).txid;

/** A CashScript NetworkProvider for the browser that talks to our /api/chain proxy. */
export const httpProvider: NetworkProvider = {
  network: NETWORK,
  async getUtxos(address: string) {
    return (await getUtxosFor([address]))[address] ?? [];
  },
  async getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string) {
    const bytecode = typeof lockingBytecode === "string" ? hexToBin(lockingBytecode) : lockingBytecode;
    const res = lockingBytecodeToCashAddress({ bytecode, prefix: NETWORK === "mainnet" ? "bitcoincash" : "bchtest" });
    if (typeof res === "string") throw new Error(`cannot encode ${binToHex(bytecode)}: ${res}`);
    return (await getUtxosFor([res.address]))[res.address] ?? [];
  },
  getBlockHeight,
  async getRawTransaction() {
    throw new Error("not supported in the browser provider");
  },
  sendRawTransaction: broadcast,
} as NetworkProvider;
