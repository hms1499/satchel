import { base64ToBin, binToUtf8, isBase64 } from "@bitauth/libauth";
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
  return kit.checkChallenge(challenge, { resource, request, secret: providerSeed() });
}

/** Verifies an `X-Payment` header for one request: the challenge, then the paying transaction (0-conf). */
export async function verifyPayment(
  header: string | null,
  resource: string,
  request: string,
): Promise<{ ok: true; txid: string; nonce: string; expires: number } | { ok: false; error: string }> {
  if (!header) return { ok: false, error: "missing X-Payment header" };
  let parsed: { challenge?: Challenge; txid?: unknown } | null;
  try {
    parsed = isBase64(header) ? JSON.parse(binToUtf8(base64ToBin(header))) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "malformed X-Payment header" };
  const { challenge, txid } = parsed;
  const invalid = checkChallenge(challenge, resource, request);
  if (invalid || !challenge) return { ok: false, error: invalid ?? "invalid challenge signature" };
  if (typeof txid !== "string" || !/^[0-9a-f]{64}$/.test(txid)) return { ok: false, error: "invalid txid" };

  let rawHex: string;
  try {
    rawHex = await getProvider().getRawTransaction(txid);
  } catch {
    return { ok: false, error: "transaction not found on the network" };
  }
  const unpaid = kit.verifyPaymentTx(rawHex, challenge);
  if (unpaid) return { ok: false, error: unpaid };
  return { ok: true, txid, nonce: challenge.nonce, expires: challenge.expires };
}
