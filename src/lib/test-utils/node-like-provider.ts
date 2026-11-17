// Test helper: a MockNetworkProvider that behaves like a BCHN node (rejects spending an already-spent outpoint with
// Fulcrum's error text) and can simulate a lagging Electrum index (getUtxos answers from a stale snapshot).
import { MockNetworkProvider, type SpendableUtxo } from "cashscript";
import { binToHex, decodeTransaction, hexToBin } from "@bitauth/libauth";

export class NodeLikeProvider extends MockNetworkProvider {
  /** While > 0, getUtxos answers from `stale` (and counts down). */
  lagCalls = 0;
  stale = new Map<string, SpendableUtxo[]>();
  spent = new Set<string>();
  /** Outpoints of transactions that "never propagated": spending them fails like an unknown input. */
  dropped = new Set<string>();

  async getUtxos(address: string) {
    if (this.lagCalls > 0 && this.stale.has(address)) {
      this.lagCalls--;
      return this.stale.get(address)!;
    }
    return super.getUtxos(address);
  }

  async sendRawTransaction(hex: string) {
    const tx = decodeTransaction(hexToBin(hex));
    if (typeof tx === "string") return super.sendRawTransaction(hex);
    const outpoints = tx.inputs.map((i) => `${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`);
    if (outpoints.some((o) => this.dropped.has(o))) throw new Error("the transaction was rejected by network rules.\n\nbad-txns-inputs-missingorspent (code 16)");
    if (outpoints.some((o) => this.spent.has(o))) throw new Error("the transaction was rejected by network rules.\n\ntxn-mempool-conflict (code 18)");
    const txid = await super.sendRawTransaction(hex);
    outpoints.forEach((o) => this.spent.add(o));
    return txid;
  }

  /** Freeze the current view of these addresses: the next `lagCalls` reads return it. */
  async freeze(addresses: string[], lagCalls: number) {
    for (const a of addresses) this.stale.set(a, await super.getUtxos(a));
    this.lagCalls = lagCalls;
  }
}
