import { binToHex, hmacSha256, sha256, utf8ToBin } from "@bitauth/libauth";
import type { BchNetwork, Challenge } from "./protocol";

/**
 * Each challenge is bound to one request (`request` = digest of the tool and its parameters). Within its expiry a paid
 * header can be replayed only for that identical request, so a retry is safe on any number of serverless instances
 * and needs no shared state. The handler may run again on a different instance (the result cache is per instance).
 */
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/**
 * HMAC-SHA256 (hex) over the signed fields only, in a fixed order. Extra fields a client echoes back (such as `scheme`
 * from the 402 `accepts` entry) must not change the signature.
 */
export function signChallengeBody(c: Omit<Challenge, "sig">, secret: string): string {
  const { resource, payTo, amount, nonce, expires, network, request } = c;
  const body = JSON.stringify({ resource, payTo, amount, nonce, expires, network, request });
  return binToHex(hmacSha256(utf8ToBin(secret), utf8ToBin(body)));
}

/** Digest of a request: name + parameters sorted by key, so parameter order does not matter. */
export function requestDigest(name: string, params: Record<string, string> | URLSearchParams): string {
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  const canonical = JSON.stringify([name, entries.map(([k, v]) => [k, String(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
  return binToHex(sha256.hash(utf8ToBin(canonical)));
}

export function createChallenge(o: {
  resource: string;
  payTo: string;
  amount: bigint;
  request: string;
  network: BchNetwork;
  secret: string;
  ttlMs?: number;
  now?: number;
}): Challenge {
  const body = {
    resource: o.resource,
    payTo: o.payTo,
    amount: o.amount.toString(),
    nonce: binToHex(globalThis.crypto.getRandomValues(new Uint8Array(16))),
    expires: (o.now ?? Date.now()) + (o.ttlMs ?? CHALLENGE_TTL_MS),
    network: o.network,
    request: o.request,
  };
  return { ...body, sig: signChallengeBody(body, o.secret) };
}

/** Compares two strings without returning early at the first differing character (equal lengths only). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checks a challenge echoed back by a client. Returns an error message, or null when it is valid. */
export function checkChallenge(
  c: Challenge | undefined,
  o: { resource: string; request?: string; network: BchNetwork; secret: string; now?: number },
): string | null {
  if (!c?.sig || !constantTimeEqual(signChallengeBody(c, o.secret), c.sig)) return "invalid challenge signature";
  if (c.network !== o.network) return "challenge is for another network";
  if (c.resource !== o.resource) return "challenge is for a different resource";
  if (o.request !== undefined && c.request !== o.request) return "payment is for a different request";
  if ((o.now ?? Date.now()) > c.expires) return "challenge expired";
  return null;
}
