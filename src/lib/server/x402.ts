import { randomBytes } from "node:crypto";
import { binToHex, decodeTransaction, hexToBin } from "@bitauth/libauth";
import { NETWORK } from "../config";
import { lockingBytecodeOf } from "../vault";
import { hmac } from "./keys";
import { getProvider } from "./electrum";

/**
 * Pay-per-call over HTTP 402 on Bitcoin Cash.
 *
 * 1. Client calls a paid endpoint without payment -> 402 + a signed challenge {payTo, amount, nonce, expires}.
 * 2. Client pays `amount` sats to `payTo` in a tx with an OP_RETURN output: "SC402" || nonce.
 * 3. Client retries with header `X-Payment: <base64 json {challenge, txid}>`.
 * 4. Server verifies the challenge signature, expiry, and the (0-conf) transaction, then serves the response.
 */
export const MEMO_PREFIX_HEX = binToHex(new TextEncoder().encode("SC402"));
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface Challenge {
  resource: string;
  payTo: string;
  amount: string; // sats, decimal string
  nonce: string; // 16 bytes hex
  expires: number; // unix ms
  network: string;
  sig: string;
}

/**
 * HMAC over the signed fields only, in a fixed order. Extra fields a client echoes back (such as `scheme`
 * from the 402 `accepts` entry) must not change the signature.
 */
export function signChallengeBody(c: Omit<Challenge, "sig">): string {
  const { resource, payTo, amount, nonce, expires, network } = c;
  return hmac(JSON.stringify({ resource, payTo, amount, nonce, expires, network }));
}

export function createChallenge(resource: string, payTo: string, amount: bigint): Challenge {
  const body = {
    resource,
    payTo,
    amount: amount.toString(),
    nonce: randomBytes(16).toString("hex"),
    expires: Date.now() + CHALLENGE_TTL_MS,
    network: NETWORK,
  };
  return { ...body, sig: signChallengeBody(body) };
}

/** Checks a challenge echoed back by a client. Returns an error message, or null when it is valid. */
export function checkChallenge(challenge: Challenge | undefined, resource: string): string | null {
  if (!challenge?.sig || signChallengeBody(challenge) !== challenge.sig) return "invalid challenge signature";
  if (challenge.resource !== resource) return "challenge is for a different resource";
  if (Date.now() > challenge.expires) return "challenge expired";
  return null;
}

export function memoForChallenge(c: Pick<Challenge, "nonce">): string {
  return MEMO_PREFIX_HEX + c.nonce;
}

export function encodePaymentHeader(challenge: Challenge, txid: string): string {
  return Buffer.from(JSON.stringify({ challenge, txid })).toString("base64");
}

// Best-effort replay protection (per server instance); challenges also expire after 10 minutes.
const usedNonces = new Set<string>();

export async function verifyPayment(header: string | null, resource: string): Promise<{ ok: true; txid: string } | { ok: false; error: string }> {
  if (!header) return { ok: false, error: "missing X-Payment header" };
  let parsed: { challenge: Challenge; txid: string };
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "malformed X-Payment header" };
  }
  const { challenge, txid } = parsed;
  const invalid = checkChallenge(challenge, resource);
  if (invalid) return { ok: false, error: invalid };
  if (usedNonces.has(challenge.nonce)) return { ok: false, error: "payment already used" };
  if (!/^[0-9a-f]{64}$/.test(txid ?? "")) return { ok: false, error: "invalid txid" };

  let rawHex: string;
  try {
    rawHex = await getProvider().getRawTransaction(txid);
  } catch {
    return { ok: false, error: "transaction not found on the network" };
  }
  const tx = decodeTransaction(hexToBin(rawHex));
  if (typeof tx === "string") return { ok: false, error: "could not decode transaction" };

  const payToBytecode = binToHex(lockingBytecodeOf(challenge.payTo));
  const paid = tx.outputs.some(
    (o) => binToHex(o.lockingBytecode) === payToBytecode && o.valueSatoshis >= BigInt(challenge.amount),
  );
  if (!paid) return { ok: false, error: "transaction does not pay the required amount to payTo" };
  const memo = memoForChallenge(challenge);
  const hasMemo = tx.outputs.some((o) => o.lockingBytecode[0] === 0x6a && binToHex(o.lockingBytecode).includes(memo));
  if (!hasMemo) return { ok: false, error: "transaction is missing the SC402 nonce memo" };

  usedNonces.add(challenge.nonce);
  return { ok: true, txid };
}
