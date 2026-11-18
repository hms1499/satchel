# Satchel

**Give your agent a budget, not your keys.**

Satchel is the **budget layer** for AI agents on Bitcoin Cash. You fund a covenant vault, and your agent pays on its own: for
APIs over HTTP 402, or directly to people and services you approved. BCH consensus enforces the rules, not our server:

- **A cap per period.** The agent can spend at most *X* sats every *N* blocks, miner fees included.
- **Allowlisted payees only.** Payments can only go to the payees you approved: Satchel's tools, third-party sellers, or any
  BCH address you add.
- **You can always pull out.** The owner key can withdraw everything at any time.

Every payment, by any route, goes through the same covenant. If the agent is prompt-injected, or our server is compromised, the worst it can do is spend the remaining budget on the payees you approved. Any transaction that breaks the rules is rejected by every node with `mandatory-script-verify-flag-failed`.

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/bchblaze2026/detail) (Mainnet Track).

## Demo flow (about 2 minutes)

1. **Connect** a wallet with WizardConnect (for example Cashonize).
2. **Create a vault**: choose a deposit, a cap per period, a period length and the payees (Satchel's tools, suggested
   sellers, custom payees), then sign the funding transaction.
3. **Ask the agent** a question. It buys paid tool calls (price feed, web reader, deep analysis) over HTTP 402. Every payment is an on-chain transaction from the vault, shown with an explorer link.
4. **Try to break it.** *Overspend* and *Pay an attacker address* broadcast transactions that violate the covenant. The network rejects them, and the UI shows the raw rejection.
5. **Withdraw** the remainder with your owner key.

## Use Satchel from your own agent (MCP)

[`satchel-pay-mcp`](mcp/README.md) is an MCP server that lets your own agent, in Claude, Cursor, VS Code, Codex CLI,
Gemini CLI and other MCP clients, pay for APIs from a Satchel vault. The agent key is generated and kept on your machine;
the covenant enforces the cap and the allowlist.

```bash
claude mcp add satchel -- npx -y satchel-pay-mcp@0.1.0
```

Then ask your agent to "set up Satchel", create the vault from the link it gives you, and paste back the connect code.

- `satchel_pay_fetch` pays bch-sc402 APIs: Satchel's tools (`crypto-price`, `web-reader`, `deep-analysis`, `bch-address`,
  `bch-tx`) and sellers whose origin you add to `SATCHEL_PAY_ORIGINS`. `satchel_catalog` lists them with their prices.
- `satchel_send(to, amountSats, memo?)` pays an allowlisted address directly, with an optional on-chain memo
  (≤ 100 UTF-8 bytes). It is checked before signing (allowlisted payee, right network, 546 sats to `SATCHEL_MAX_SEND_SATS`),
  and the covenant still enforces the cap and the allowlist.

### Custom payees

When creating a vault you can add up to 8 payees in total: Satchel's tools, suggested sellers (from the server's
`SATCHEL_SELLERS`), and **custom payees** (a label plus any BCH address, e.g. a person or a service you pay by hand).
Addresses are stored in their canonical non-token form, so a token-aware `z…` address and its `q…` form count once. Labels
travel in the connect code, not on chain. The vault can still be recovered from chain: the genesis transaction's
OP_RETURN memo (v2) stores Satchel's tools as indexes and every other payee as a hash (at most 215 bytes, about 7 custom
P2PKH payees).

## Sell an API to Satchel agents

[`satchel-pay-server`](provider-kit/README.md) puts any Fetch API endpoint (`Request` → `Response`: Next.js route handlers,
Hono, Bun, Deno) behind a bch-sc402 paywall: signed challenges, 0-conf payment verification and idempotent paid retries,
with no database and no wallet software. It validates the input before answering 402, so a request that can only fail
never costs money, and it serves `/.well-known/satchel.json` so `satchel_catalog` can list your tools. Satchel's own
`/api/tools/*` run on it.

[`examples/provider`](examples/provider/README.md) is a working seller built with it: a **CashAddr and script decoder**
(`POST /api/address`, `POST /api/script`, 600 sats per call) on Hono, paid straight to the seller's own address.

## Roadmap

- **x402-bch upstream proposal.** Satchel speaks its own scheme, `bch-sc402`. A spike showed that the x402-bch `exact`
  reference verifier rejects payments from a covenant vault on two policy rules: the state NFT's commitment changes, and
  the locktime is non-zero. We plan to propose relaxing those two rules upstream so Satchel vaults can pay x402-bch sellers.
- **USD budgets**: caps in USD or stablecoins.
- **EVM bridge**: paying x402 sellers on EVM chains from a Satchel budget.

## How it works

### The covenant (`contracts/Satchel.cash`, CashScript 0.14)

The vault is a single UTXO that carries the BCH and a **mutable CashTokens NFT**. The NFT commitment holds the state:

```
periodStart (4 bytes LE, block height) ‖ spent (8 bytes LE, sats)
```

`spend(agentSig, allowlist, recipientIndex)`, signed by the agent:

- exactly one input (the vault)
- `outflow = input value − vault output value`, so fees count against the budget
- if `tx.locktime ≥ periodStart + periodBlocks`, the period rolls over (enforced with CLTV); otherwise `spent` accumulates
- `newSpent ≤ capPerPeriod`
- output 0 recreates the vault: same bytecode, same category, honest new commitment
- output 1 pays a recipient whose `sha256(lockingBytecode)` is in the allowlist (committed as `hash256` in the constructor)
- optional output 2 is a 0-value OP_RETURN memo that carries the x402 payment nonce

`withdraw(ownerSig)`: the owner can spend the vault freely.

### Pay-per-call over HTTP 402 (`bch-sc402`)

```
GET /api/tools/crypto-price?id=bitcoin-cash
→ 402 { accepts: [{ payTo, amount, nonce, expires, sig }] }

agent pays from the vault (OP_RETURN = nonce)

GET /api/tools/crypto-price?id=bitcoin-cash   X-Payment: base64({challenge, txid})
→ 200 { ...result }
```

The server verifies the payment transaction through Electrum (0-conf), checks the payee, the amount and the nonce, and serves the result.

### The agent

The hosted demo agent is an AI SDK 7 tool-calling agent whose tools are the paid endpoints (`crypto-price`,
`web-reader`, `deep-analysis`). The server derives the agent key for each vault from a master seed, so the server is stateless. The vault descriptor lives in the browser. The agent never checks the budget itself: the covenant is the enforcer.

## Tech stack

Next.js 16 · React 19 · CashScript 0.14 · libauth · WizardConnect · AI SDK 7 · Electrum (Fulcrum) · Tailwind 4

## Running locally

```bash
npm install
cp .env.example .env.local   # fill AGENT_MASTER_SEED and PROVIDER_SEED (openssl rand -hex 32)
npm run dev
```

```bash
npm test              # covenant tests on the full BCH VM (MockNetworkProvider)
npm run typecheck
npm run build
```

The hosted agent runs a scripted plan unless `AGENT_MODE=llm` and AI Gateway credentials are set. The paid `deep-analysis`
tool calls a real model only with `TOOL_LLM=on` plus the same credentials (model `TOOL_MODEL`); otherwise it returns a placeholder answer, labelled "demo mode" in the catalog.
`SATCHEL_SELLERS` lists suggested sellers in the create form (see `.env.example`).

### On-chain end-to-end

```bash
npx tsx scripts/e2e.mts address            # prints the test owner address; fund it first
npx tsx scripts/e2e.mts run                # genesis → agent payments → attacks → withdraw (needs npm run dev)
npx tsx scripts/e2e.mts recover            # lists the owner's open vaults, found on chain alone (genesis memo)
npx tsx scripts/e2e.mts withdraw <file>    # owner-withdraws a vault saved in .e2e-vaults/ (recovery after a crash)
npx tsx scripts/e2e.mts sweep              # moves the agent's tool payments back from the provider addresses
npx tsx scripts/e2e.mts refund <address>   # returns everything the test owner holds
```

The script uses chipnet by default. For mainnet, set `NEXT_PUBLIC_BCH_NETWORK=mainnet` and `E2E_ALLOW_MAINNET=1` for both the dev server and the script.

`mcp/scripts/mainnet-e2e.mts` drives the built `satchel-pay-mcp` over stdio against a Satchel server and a seller: a vault
with `bch-tx`, the seller and a custom payee; `satchel_send`; paid calls to `bch-tx` and the seller; a cap refusal; recovery
from chain; withdraw. It prints every txid with an explorer link and ends with `E2E OK`.

```bash
cd mcp && npm run build
E2E_NETWORK=chipnet E2E_SELLER_ORIGIN=http://localhost:8787 npx tsx scripts/mainnet-e2e.mts            # chipnet
E2E_ALLOW_MAINNET=1 E2E_SELLER_ORIGIN=https://<seller> npx tsx scripts/mainnet-e2e.mts                # mainnet, ~3,500 sats in fees
```

## Security notes

- The server holds agent keys, but agent keys can only use `spend`, which is capped and allowlisted by the covenant.
- Changing the cap or the allowlist means withdrawing and creating a new vault, by design.
- This is hackathon software. Use small amounts.
