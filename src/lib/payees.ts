import { decodeCashAddress, encodeCashAddress } from "@bitauth/libauth";
import type { BchNetwork } from "./config";

export type NormalizedPayee = { ok: true; address: string } | { ok: false; error: string };

export const prefixFor = (network: BchNetwork) => (network === "mainnet" ? "bitcoincash" : "bchtest");

/**
 * Canonical form of a payee address: the non-token CashAddr (`q…`/`p…`) with the network's prefix.
 * Accepts P2PKH, P2SH20 and P2SH32, with or without the token marker (`z…`/`r…`).
 */
export function normalizePayee(address: string, network: BchNetwork): NormalizedPayee {
  const input = address.trim();
  const decoded = decodeCashAddress(input.includes(":") ? input : `${prefixFor(network)}:${input}`);
  if (typeof decoded === "string") return { ok: false, error: "not a valid BCH address" };
  const expected = prefixFor(network);
  if (decoded.prefix !== expected) {
    const other = network === "mainnet" ? "chipnet" : "mainnet";
    if (decoded.prefix === prefixFor(other)) {
      return { ok: false, error: `address is for ${other}, this vault is on ${network}` };
    }
    return { ok: false, error: "not a valid BCH address" };
  }
  const isP2pkh = decoded.type === "p2pkh" || decoded.type === "p2pkhWithTokens";
  const len = decoded.payload.length;
  if (isP2pkh ? len !== 20 : len !== 20 && len !== 32) return { ok: false, error: "unsupported address type" };
  const type = isP2pkh ? "p2pkh" : "p2sh";
  return { ok: true, address: encodeCashAddress({ prefix: expected, type, payload: decoded.payload }).address };
}
