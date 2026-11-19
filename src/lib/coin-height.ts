import { binToHex, cashAddressToLockingBytecode, sha256 } from "@bitauth/libauth";


/**
 * Confirmation height of a coin at `address`, from Electrum's listunspent; 0 when it is unconfirmed, not listed yet
 * (index lag), on any error, or when the provider cannot make raw requests. 0 is the safe default: the spender then
 * never starts a new period, so it never sets a relative lock the coin cannot satisfy yet.
 */
export async function coinHeight(electrum: object, address: string, utxo: { txid: string; vout: number }): Promise<number> {
  // Any provider with a raw Electrum `performRequest` (CashScript's ElectrumNetworkProvider, the failover provider).
  const request = (electrum as { performRequest?: unknown }).performRequest;
  if (typeof request !== "function") return 0;
  try {
    const lb = cashAddressToLockingBytecode(address);
    if (typeof lb === "string") return 0;
    const scripthash = binToHex(sha256.hash(lb.bytecode).reverse());
    const list = (await (request as (m: string, p: string) => Promise<unknown>).call(electrum, "blockchain.scripthash.listunspent", scripthash)) as
      | { tx_hash: string; tx_pos: number; height: number }[]
      | undefined;
    const hit = Array.isArray(list) ? list.find((e) => e.tx_hash === utxo.txid && e.tx_pos === utxo.vout) : undefined;
    return hit && hit.height > 0 ? hit.height : 0;
  } catch {
    return 0;
  }
}
