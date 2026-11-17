import { ResultCache } from "./cache";
import { createChallenge, requestDigest } from "./challenge";
import { electrumTransactionFetcher } from "./electrum";
import { SCHEME, type BchNetwork } from "./protocol";
import { verifyPaymentHeader } from "./verify";

/** Bad input from the caller. Thrown from `validate` (before any 402) or from `handler` (after payment). */
export class InputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "InputError";
  }
}

export interface PaidRoute {
  /** The path the challenge is issued for, e.g. "/api/price". */
  resource: string;
  /** The name the request digest is bound to. */
  name: string;
  /** Price in sats. */
  price: bigint;
  /** The seller's CashAddr. */
  payTo: string;
  /** Allowed parameter names; any other name is answered 400 before payment. */
  params: readonly string[];
  /** Rejects input that can only fail, before payment is asked for. Throw `InputError`. */
  validate?: (p: URLSearchParams) => void | Promise<void>;
  /** Runs once per payment; its result is returned as `{ result, paidWith }`. */
  handler: (p: URLSearchParams) => Promise<unknown>;
}

export interface PaywallConfig {
  network: BchNetwork;
  /** At least 32 characters. Signs challenges (HMAC-SHA256). */
  secret: string;
  /** Raw tx hex by txid. Default: an Electrum client for `network`. */
  getTransaction?: (txid: string) => Promise<string>;
  /** Paid results by challenge nonce. Default: in memory, per instance. */
  cache?: ResultCache<unknown>;
  now?: () => number;
  log?: (evt: Record<string, unknown>) => void;
}

/** One entry of `/.well-known/satchel.json`, the same shape as Satchel's `/api/config` `tools`. */
export type CatalogEntry = {
  name: string;
  title: string;
  description: string;
  price: string; // sats, decimal string
  params: Record<string, string>;
  payTo: string;
  endpoint: string;
};

const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers });

async function readParams(req: Request): Promise<URLSearchParams> {
  if (req.method !== "POST") return new URL(req.url).searchParams;
  const body: unknown = await req.json().catch(() => ({}));
  const entries = body && typeof body === "object" ? Object.entries(body) : [];
  return new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
}

/**
 * Pay-per-call over HTTP 402 on Bitcoin Cash (bch-sc402). `handle` answers 402 with a signed challenge, verifies
 * the `X-Payment` header and the paying transaction, and runs the route's handler once per payment.
 */
export function createPaywall(cfg: PaywallConfig): { handle(req: Request, route: PaidRoute): Promise<Response> } {
  // A missing or short secret would let anyone sign their own challenges (and set payTo to themselves).
  if (typeof cfg.secret !== "string" || cfg.secret.length < 32) {
    throw new Error("satchel-pay-server: secret must be a string of at least 32 characters (set SELLER_SECRET)");
  }
  const getTransaction = cfg.getTransaction ?? electrumTransactionFetcher(cfg.network);
  const cache = cfg.cache ?? new ResultCache<unknown>();
  const now = cfg.now ?? Date.now;
  const log = cfg.log ?? (() => {});

  async function handle(req: Request, route: PaidRoute): Promise<Response> {
    const params = await readParams(req);

    // Reject input that can only fail before asking for payment.
    for (const key of params.keys()) {
      if (!route.params.includes(key)) return json({ error: `unknown parameter "${key}"; expected: ${route.params.join(", ")}` }, 400);
    }
    try {
      await route.validate?.(params);
    } catch (e) {
      if (e instanceof InputError) return json({ error: e.message }, e.status);
      log({ evt: "tool", tool: route.name, status: 500, error: e instanceof Error ? e.message : String(e) });
      return json({ error: "internal error" }, 500);
    }
    // The payment is bound to this exact request: a paid header cannot buy a different call.
    const digest = requestDigest(route.name, params);

    const header = req.headers.get("x-payment");
    if (!header) {
      const challenge = createChallenge({
        resource: route.resource,
        payTo: route.payTo,
        amount: route.price,
        request: digest,
        network: cfg.network,
        secret: cfg.secret,
        now: now(),
      });
      return json({ error: "payment required", accepts: [{ scheme: SCHEME, ...challenge }] }, 402, {
        "www-authenticate": 'BCH-SC402 realm="satchel"',
      });
    }

    const started = now();
    const fail = (error: string) => {
      log({ evt: "tool", tool: route.name, status: 402, error, ms: now() - started });
      return json({ error }, 402);
    };
    const payment = await verifyPaymentHeader(header, {
      resource: route.resource,
      request: digest,
      secret: cfg.secret,
      getTransaction,
      now: now(),
    });
    if (!payment.ok) return fail(payment.error);
    const { challenge: paid, txid: paidWith } = payment;

    // A replay of a paid request (retry) gets the stored response; the handler runs once per payment.
    const cached = cache.get(paid.nonce);
    if (cached) {
      log({ evt: "tool", tool: route.name, status: 200, txid: paidWith, cached: true, ms: now() - started });
      return json(cached);
    }

    try {
      const result = await route.handler(params);
      cache.set(paid.nonce, { result, paidWith }, paid.expires);
      log({ evt: "tool", tool: route.name, status: 200, txid: paidWith, ms: now() - started });
      return json({ result, paidWith });
    } catch (e) {
      const status = e instanceof InputError ? e.status : 502;
      const error = e instanceof Error ? e.message : "tool failed";
      log({ evt: "tool", tool: route.name, status, txid: paidWith, error, ms: now() - started });
      return json({ error, paidWith }, status);
    }
  }

  return { handle };
}

/** Serves `/.well-known/satchel.json`: the seller's catalog, readable from any origin. */
export function wellKnownResponse(info: { name: string; network: BchNetwork; tools: CatalogEntry[] }): Response {
  return json(info, 200, { "access-control-allow-origin": "*" });
}
