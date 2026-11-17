/**
 * bch-sc402 wire format, shared by sellers and paying clients. This module has no imports on purpose: browser and
 * MCP bundles import it without pulling in a second copy of libauth.
 *
 * 1. A paid endpoint called without payment answers 402 with `{ error, accepts: [{ scheme: "bch-sc402", ...challenge }] }`.
 * 2. The client pays `amount` sats to `payTo` in a tx that also has an OP_RETURN output with `"SC402" || nonce`.
 * 3. The client retries with `X-Payment: base64(JSON {challenge, txid})`.
 * 4. The seller checks the challenge signature, expiry and request binding, verifies the (0-conf) tx, and serves.
 */

export const SCHEME = "bch-sc402";

/** Hex of the ASCII bytes "SC402". */
export const MEMO_PREFIX_HEX = "5343343032";

export type BchNetwork = "mainnet" | "chipnet";

export interface Challenge {
  resource: string;
  payTo: string;
  amount: string; // sats, decimal string
  nonce: string; // 16 bytes hex
  expires: number; // unix ms
  request: string; // sha256 hex of the canonical request (see requestDigest)
  network: string;
  sig: string;
}

/** Hex the OP_RETURN output of a payment must contain: "SC402" || nonce. */
export function memoForChallenge(c: Pick<Challenge, "nonce">): string {
  return MEMO_PREFIX_HEX + c.nonce;
}
