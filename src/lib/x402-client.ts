import { binToHex } from "@bitauth/libauth";

/**
 * Client side of Satchel's pay-per-call protocol (bch-sc402), shared by the hosted agent and satchel-pay-mcp.
 * No secrets here: challenge signing and payment verification live on the provider (server/x402.ts).
 */

export const MEMO_PREFIX_HEX = binToHex(new TextEncoder().encode("SC402"));
export const SCHEME = "bch-sc402";

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

export function memoForChallenge(c: Pick<Challenge, "nonce">): string {
  return MEMO_PREFIX_HEX + c.nonce;
}

export function encodePaymentHeader(challenge: Challenge, txid: string): string {
  return Buffer.from(JSON.stringify({ challenge, txid })).toString("base64");
}

/** Reads the challenge from a 402 response body; only bch-sc402 challenges for `network` are accepted. */
export function parseChallenge(body: unknown, network: string): { ok: true; challenge: Challenge } | { ok: false; error: string } {
  const entry = (body as { accepts?: unknown[] } | null)?.accepts?.[0] as (Challenge & { scheme?: string }) | undefined;
  if (!entry || typeof entry !== "object") return { ok: false, error: "no payment challenge in the 402 response" };
  if (entry.scheme !== SCHEME) return { ok: false, error: "unsupported payment scheme" };
  if (entry.network !== network) return { ok: false, error: `challenge is for ${entry.network}, expected ${network}` };
  if (typeof entry.payTo !== "string" || !/^\d+$/.test(String(entry.amount)) || !/^[0-9a-f]{32}$/.test(String(entry.nonce))) {
    return { ok: false, error: "malformed payment challenge" };
  }
  return { ok: true, challenge: entry };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS_MS = process.env.NODE_ENV === "test" ? [1, 1, 1, 1] : [800, 1600, 2400, 3200];

/**
 * Sends a paid request, retrying with the same payment header (idempotent: the payment is bound to this exact
 * request) while the provider has not seen the payment yet, on 5xx responses and on network errors.
 * Client errors (4xx other than "payment not found") are final.
 */
export async function retryPaidRequest(doFetch: () => Promise<Response>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  let lastError = "the tool provider did not answer";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    let res: Response;
    try {
      res = await doFetch();
    } catch (e) {
      lastError = e instanceof Error ? e.message : "network error";
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (res.ok) return { ok: true, result: data.result };
    lastError = data.error ?? `HTTP ${res.status}`;
    const notSeenYet = res.status === 402 && /not found/.test(lastError);
    if (!notSeenYet && res.status < 500) return { ok: false, error: lastError };
  }
  return { ok: false, error: lastError };
}
