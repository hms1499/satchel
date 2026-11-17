# satchel-pay-server

**Charge AI agents per API call, in Bitcoin Cash.**

`satchel-pay-server` puts any Fetch API endpoint (`Request` → `Response`) behind an HTTP 402 paywall that speaks
**bch-sc402**, the protocol [Satchel](https://github.com/hms1499/satchel) agents and `satchel-pay-mcp` pay with. The
seller needs no database, no wallet software and no account anywhere: a secret to sign challenges, a CashAddr to be paid
to, and an Electrum server to look up payments.

It runs on Node.js 22+, Bun and Deno. Its only dependencies are `@bitauth/libauth` and `@electrum-cash/network`.

## Next.js (App Router)

```ts
// app/api/price/route.ts
import { createPaywall, InputError, type PaidRoute } from "satchel-pay-server";

const pay = createPaywall({ network: "chipnet", secret: process.env.SELLER_SECRET! });
const route: PaidRoute = {
  resource: "/api/price", name: "price", price: 500n, payTo: process.env.SELLER_PAYTO!, params: ["id"],
  validate: (p) => { if (!p.get("id")) throw new InputError("id is required"); },
  handler: async (p) => ({ id: p.get("id"), usd: await lookupPrice(p.get("id")!) }),
};
export const GET = (req: Request) => pay.handle(req, route);
export const POST = GET;
```

## Hono

```ts
import { Hono } from "hono";
import { createPaywall, wellKnownResponse, type PaidRoute } from "satchel-pay-server";

const pay = createPaywall({ network: "chipnet", secret: process.env.SELLER_SECRET! });
const route: PaidRoute = {
  resource: "/api/price", name: "price", price: 500n, payTo: process.env.SELLER_PAYTO!, params: ["id"],
  handler: async (p) => ({ id: p.get("id"), usd: await lookupPrice(p.get("id")!) }),
};
const app = new Hono();
app.on(["GET", "POST"], "/api/price", (c) => pay.handle(c.req.raw, route));
app.get("/.well-known/satchel.json", () => wellKnownResponse({ name: "Price seller", network: "chipnet", tools: [/* CatalogEntry */] }));
```

## What `handle` does

1. Reads the parameters from the query string (GET) or the JSON body (POST).
2. Answers **400** for a parameter name that is not in `params`, and runs `validate`. An `InputError` is answered with
   its status (400 or 404). Input that can only fail is refused **before** any payment is asked for.
3. Without an `X-Payment` header: **402** with a signed challenge and `www-authenticate: BCH-SC402 realm="satchel"`.
4. With a header: checks the challenge and the paying transaction. Any problem is a **402** `{ error }`.
5. Runs `handler` once per payment and answers **200** `{ result, paidWith }`. A replay of the same paid header for the
   same request gets the stored result. If `handler` throws, the answer is **502** (or the `InputError` status)
   `{ error, paidWith }`, and the caller can retry with the same header without paying again.

`wellKnownResponse` serves `/.well-known/satchel.json` (your catalog, CORS `*`) so Satchel agents can list your tools.

## The protocol in brief

1. The client calls the endpoint and gets `402 { error, accepts: [{ scheme: "bch-sc402", resource, payTo, amount, nonce, expires, network, request, sig }] }`.
   `amount` is in sats (decimal string), `request` is the SHA-256 of the tool name and its sorted parameters, and `sig`
   is an HMAC-SHA256 of the other fields under your secret. A challenge is valid for 10 minutes.
2. The client pays at least `amount` sats to `payTo` in a transaction whose only OP_RETURN output is exactly
   `OP_RETURN <push of "SC402" || nonce>` (hex `6a15` + `5343343032` + nonce). One transaction pays for one challenge.
3. The client retries the identical request with `X-Payment: base64(JSON { challenge, txid })`.
4. The server checks the signature, the resource, the request binding and the expiry, then fetches the transaction and
   checks the payment output and the memo. No state is shared between instances: a paid header only ever buys the
   identical request, so retries are idempotent on any number of serverless instances.

## Risk: payments are accepted at 0-conf

Payments are accepted at 0-conf. The paying agent's key could double-spend its vault UTXO in a race. That is acceptable
for small amounts; do not sell anything per call that you could not afford to give away now and then.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `SELLER_SECRET` | yes | At least 32 characters of randomness (`createPaywall` throws otherwise). Signs the challenges. Keep it server-side; rotating it invalidates open challenges. |
| `SELLER_PAYTO` | yes | Your CashAddr (`bitcoincash:…` on mainnet, `bchtest:…` on chipnet). Payments go straight to it. |

`createPaywall` options: `network` (`"mainnet"` or `"chipnet"`), `secret`, `getTransaction` (txid → raw tx hex; default:
an Electrum client, `bch.imaginary.cash` on mainnet and `chipnet.bch.ninja` on chipnet), `cache` (a `ResultCache`;
default: in memory, per instance), `now` and `log` (receives one JSON event per paid call).

**Cloudflare Workers** cannot keep the default Electrum client's connection open between requests (no raw or long-lived
sockets), so pass your own `getTransaction`, for example a `fetch` to a block explorer or indexer API that returns the
raw transaction hex.
