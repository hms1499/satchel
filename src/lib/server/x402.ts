import * as kit from "../../../provider-kit/src/index";
import type { Challenge } from "../../../provider-kit/src/index";
import { NETWORK } from "../config";
import { getProvider } from "./electrum";
import { providerSeed } from "./keys";

export { MEMO_PREFIX_HEX, memoForChallenge, type Challenge } from "../../../provider-kit/src/index";
export { encodePaymentHeader } from "../x402-client";

/**
 * Satchel's side of bch-sc402 (pay-per-call over HTTP 402). The protocol lives in satchel-pay-server
 * (`provider-kit/`); these wrappers only bind Satchel's secret (`PROVIDER_SEED`) and `NETWORK`.
 */

export function signChallengeBody(c: Omit<Challenge, "sig">): string {
  return kit.signChallengeBody(c, providerSeed());
}

export const requestDigest = kit.requestDigest;

export function createChallenge(resource: string, payTo: string, amount: bigint, request: string): Challenge {
  return kit.createChallenge({ resource, payTo, amount, request, network: NETWORK, secret: providerSeed() });
}

/** Checks a challenge echoed back by a client. Returns an error message, or null when it is valid. */
export function checkChallenge(challenge: Challenge | undefined, resource: string, request?: string): string | null {
  return kit.checkChallenge(challenge, { resource, request, network: NETWORK, secret: providerSeed() });
}

/** Verifies an `X-Payment` header for one request (satchel-pay-server `verifyPaymentHeader`). */
export async function verifyPayment(
  header: string | null,
  resource: string,
  request: string,
): Promise<{ ok: true; txid: string; nonce: string; expires: number } | { ok: false; error: string }> {
  if (!header) return { ok: false, error: "missing X-Payment header" };
  const payment = await kit.verifyPaymentHeader(header, {
    resource,
    request,
    network: NETWORK,
    secret: providerSeed(),
    getTransaction: (txid) => getProvider().getRawTransaction(txid),
  });
  if (!payment.ok) return payment;
  return { ok: true, txid: payment.txid, nonce: payment.challenge.nonce, expires: payment.challenge.expires };
}
