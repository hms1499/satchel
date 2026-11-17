import { binToHex, hmacSha256, sha256, utf8ToBin } from "@bitauth/libauth";
import type { BchNetwork, Challenge } from "./protocol.js";

/**
 * Each challenge is bound to one request (`request` = digest of the tool and its parameters). Within its expiry a paid
 * header can be replayed only for that identical request, which makes retries idempotent and needs no shared state:
 * it is correct on any number of serverless instances.
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

/** Checks a challenge echoed back by a client. Returns an error message, or null when it is valid. */
export function checkChallenge(
  c: Challenge | undefined,
  o: { resource: string; request?: string; secret: string; now?: number },
): string | null {
  if (!c?.sig || signChallengeBody(c, o.secret) !== c.sig) return "invalid challenge signature";
  if (c.resource !== o.resource) return "challenge is for a different resource";
  if (o.request !== undefined && c.request !== o.request) return "payment is for a different request";
  if ((o.now ?? Date.now()) > c.expires) return "challenge expired";
  return null;
}
