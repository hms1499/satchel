# Satchel example seller

A small, real bch-sc402 seller: a Bitcoin Cash **CashAddr and script decoder** that agents pay for per call, built on
[`satchel-pay-server`](../../provider-kit/README.md). Protocol and wallet: https://github.com/hms1499/satchel

## What it sells

| Endpoint | Body | Price | Returns |
| --- | --- | --- | --- |
| `POST /api/address` | `{"address": "..."}` | 600 sats | all address forms (CashAddr, token-aware `z...`, legacy; legacy is `null` for P2SH32), type, network, locking bytecode |
| `POST /api/script` | `{"hex": "..."}` | 600 sats | disassembly, script type, OP_RETURN pushes with UTF-8 text when valid |

Both validate the input before answering 402, so a request that can only fail never costs money (bad address: 400).
`GET /.well-known/satchel.json` lists both tools (endpoints are built from the request origin) and `GET /` is a plain-text
description.

## Environment

| Variable | Meaning |
| --- | --- |
| `SELLER_NETWORK` | exactly `mainnet` (default when unset) or `chipnet`; anything else fails at startup |
| `SELLER_SECRET` | at least 32 characters of randomness (`openssl rand -hex 32`); signs the challenges, keep it secret |
| `SELLER_PAY_TO` | your CashAddr (`bitcoincash:` on mainnet, `bchtest:` on chipnet); required, checked at startup; payments go straight to it |

## Run locally

```bash
npm install
npm test && npm run typecheck
SELLER_NETWORK=chipnet SELLER_SECRET=$(openssl rand -hex 32) SELLER_PAY_TO=bchtest:... npm run dev   # http://localhost:8787
curl -i -X POST localhost:8787/api/address -d '{"address":"bchtest:..."}'   # 402 with a bch-sc402 challenge
```

## Deploy on Vercel

Create a new Vercel project from this repo with **Root Directory** `examples/provider`. `vercel.json` sets
the Hono framework preset, and Vercel runs the default-exported app in `src/index.ts`. Vercel compiles each file to native
ESM without bundling, so relative imports keep their `.js` extension (`tsconfig` uses `NodeNext` to enforce it). Set `SELLER_NETWORK`, `SELLER_SECRET` and `SELLER_PAY_TO` in the project's environment variables. Check
`/.well-known/satchel.json` and that `POST /api/address` with a valid address gives a 402.

`satchel-pay-server` is installed from `vendor/satchel-pay-server-0.1.0.tgz` (an `npm pack` of `../../provider-kit`) until
it is published to npm.

Payments are accepted at 0-conf, see the kit README for the risk.
