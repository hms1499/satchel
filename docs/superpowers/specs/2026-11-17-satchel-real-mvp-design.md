# Satchel real MVP — Design

Status: draft for the user's approval, 2026-11-17. The hackathon deadline (2026-11-22 14:00 UTC) still exists, but the
user asked to build the complete product rather than cut scope to fit it. Work happens on a branch; the live deployment
(https://satchel-sigma.vercel.app) only changes once the new version is verified on mainnet.

## Intent

Today Satchel is a demo with a closed loop. The only things a vault can pay are three tools Satchel wrote itself, and
every payment goes to addresses Satchel controls (derived from `PROVIDER_SEED`). One of those tools (`deep-analysis`)
returns a placeholder while `AGENT_MODE=scripted`.

The goal is a real MVP for **one primary user: a developer with their own AI agent** (Claude, Cursor, Codex, … through
`satchel-pay-mcp`), who wants to give that agent a budget it cannot exceed. That user should get value from Satchel even
though BCH has almost no pay-per-call sellers today. To do that:

1. The vault can pay **any BCH address the owner approves**, not only Satchel's tools. The agent can pay such an address
   directly (`satchel_send`), not only through HTTP 402.
2. **Anyone can sell an API to Satchel agents** with a small npm package (`satchel-pay-server`). Satchel uses that same
   package for its own tools, and an example seller runs on a separate domain with its own payout address.
3. **The paid tools have real value**: a new BCH chain-data tool, and `deep-analysis` answers with a real model.

Why Satchel's value survives this: it is the budget layer, and the budget is enforced by consensus. Every payment, by any
route, is still capped per period and limited to the allowlist by the unchanged covenant.

## Goals

1. When creating a vault, the owner can add **custom payees** (a label plus a BCH address) next to Satchel's tools.
2. `satchel-pay-mcp` gains **`satchel_send(to, amountSats, memo?)`**: a direct payment to an allowlisted address, with an
   optional text memo.
3. A vault with custom payees can still be **recovered from chain** (from the genesis OP_RETURN), as vaults can today.
4. **`satchel-pay-server`** (new npm package) lets any HTTP service charge per call in bch-sc402. It runs on any runtime that
   speaks the Fetch API (`Request` → `Response`): Next.js route handlers, Hono, Bun, Deno, Cloudflare Workers.
5. Satchel's `/api/tools/*` is rewritten on top of `satchel-pay-server`, with no change to the wire protocol, so existing
   clients and `satchel-pay-mcp` keep working.
6. An **example seller** (`examples/provider`) is deployed as a second Vercel project on its own domain, with its own payout
   address, selling a BCH-native service (see "Example seller").
7. New paid tools in Satchel's catalog, backed by the existing Electrum connection: **`bch-address`** and **`bch-tx`**.
8. **`deep-analysis` calls a real model** through the Vercel AI Gateway. It is controlled by its own setting, separate from
   the hosted demo agent's `AGENT_MODE`.
9. Verified end to end on **mainnet**: `satchel_send` to a custom payee, `satchel_pay_fetch` to a Satchel tool and to the
   example seller, and a cap refusal. Then publish `satchel-pay-mcp` and `satchel-pay-server` to npm, each publish only
   after asking the user.

## Non-goals

- Compatibility with x402-bch `exact`. The 2026-11-17 spike showed that its reference verifier rejects Satchel payments on
  two policy rules (the state NFT's commitment changes, and locktime is non-zero). This goes on the roadmap with an
  upstream proposal.
- Budgets in USD or stablecoins, a bridge to x402 on EVM, editing a vault's allowlist in place, and a provider
  directory or registry.
- `satchel_send` in the hosted web agent. The hosted agent stays a scripted demo for judges.
- Token metadata (BCMR names and icons) in `bch-address`. Tokens are shown by category id and amount.
- Human confirmation prompts in MCP (elicitation), and storing the key in the OS keychain.

## Anti-goals (a failure even if everything "works")

- Any path that lets the Satchel server, the MCP server or the agent move funds beyond the cap or outside the allowlist.
  The covenant does not change at all.
- Breaking recovery of existing vaults: v1 recovery memos must still decode.
- Breaking existing `satchel-pay-mcp` installs or the hosted agent: the bch-sc402 wire format does not change.
- Secrets in the client bundle, in logs or in tool output. This covers `PROVIDER_SEED`, a seller's secret and the agent key.
- Changing the catalog order of existing tools. Recovery memos store payees as indexes into the known-payee list, so new
  tools are only ever appended.
- The live demo breaking before the new version is verified on mainnet.

## Constraints

- Everything in `CLAUDE.md` applies: covenant invariants, sats as `bigint`, chipnet first and mainnet only with tiny
  amounts that can be recovered, server-only secrets, English UI copy, Next.js 16 (read `node_modules/next/dist/docs/`
  first), and AI SDK 7.
- `@bitauth/libauth@3.1.0-next.8` is pinned in every package (the app, `mcp/`, `provider-kit/`).
- Standard OP_RETURN relay limit: **223 bytes** for the whole output script.
- The vault descriptor allowlist is limited to **1–8 entries** (zod schema), and the covenant's allowlist argument grows
  by 32 bytes per entry (it adds to every payment's fee).
- Payments are accepted at 0-conf. The agent key could double-spend the vault UTXO in a race. That is acceptable for small
  amounts, but it must be stated in the seller docs.
- The server stays stateless (no database). Result caching stays per instance, as today.

## Approaches considered

How the work is organized:

1. **One repo; Satchel uses the seller kit for its own tools** — chosen. `provider-kit/` sits next to `mcp/`;
   `src/app/api/tools/[tool]` is rewritten on top of it; `examples/provider` uses it too. There is a single implementation of
   the payment code, proven by the product running on mainnet. The cost is refactoring code that works today, so mainnet
   e2e must be rerun.
2. Kit in a separate repo, the app keeps its own payment code. Rejected: two copies drift apart, and the kit would be
   proven only by an example.
3. Protocol docs only, no kit. Rejected: it does not create real sellers, which is the point of this work.

Which "real" tool comes first (decided with the user): (b) BCH chain data from our own Electrum, with no upstream cost
and no resale terms to worry about, **plus** (c) a real model for `deep-analysis` (about $0.00035 per call on
`anthropic/claude-haiku-5.5`). A paid web-search API was not chosen: it has an upstream cost and resale terms to check,
and many agents already have search built in.

Primary user (decided with the user): **A — developers with their own agent** (MCP first), rather than B (API sellers
first). The seller kit is in scope, but kept small.

## Design

### 1. Custom payees

**Web app (`CreateVault.tsx`, `SatchelApp.tsx`, `Dashboard.tsx`)**
- Under the tool checkboxes, a "Custom payees" list. Each row has a label (1–32 chars) and an address. The address is
  validated as a CashAddr on the app's network; a token-aware `z…` address and its `q…` form are treated as the same payee.
  Duplicates of a tool address or of another row are rejected.
- Limits: at most **8 payees in total** (tools + custom), and the recovery memo must fit (see below). The form says which
  limit was hit.
- Labels live in the descriptor (`labels?: Record<address, string>`, new and optional) and in the connect code (new
  optional field). Labels are never written on chain. The dashboard shows tool names for tool payees and labels for
  custom ones; a vault recovered from chain shows "Custom payee" plus a short form of the address.

**Recovery memo v2 (`src/lib/recovery.ts`)**
- v1 is still decoded. New vaults write v2.
- v2 payload:
  `version=2 | agentIndex u32 LE | agentPk 33B | cap u64 LE | periodBlocks u32 LE | n | n entries`.
  Each entry is one of:
  - `0x00 i` — known payee index i (Satchel's catalog);
  - `0x01 <20B>` — P2PKH hash;
  - `0x02 <20B>` — P2SH20 hash;
  - `0x03 <32B>` — P2SH32 hash.
- The payload goes in a single push, using OP_PUSHDATA1 when it is longer than 75 bytes. The whole script is at most 223
  bytes: `6a` + push "STCH" (5) + `4c len` (2) + payload, so the payload is at most 215 bytes. Fixed fields take 51 bytes,
  which leaves room for about 7 P2PKH custom payees or 4 P2SH32 ones. `encodeRecoveryMemo` throws a clear error past the
  limit, and the form checks the same limit before signing.
- The decoder accepts both direct pushes and OP_PUSHDATA1. As today, a memo is trusted only if the rebuilt contract
  matches the genesis output 0 exactly.

**Suggested sellers (my call)**
- `/api/config` gains `sellers: [{ name, origin, payTo, description }]`, read from env `SATCHEL_SELLERS` (JSON). At first
  this lists only the example seller.
- In the create form, a suggested seller appears as a checkbox, like a tool. Ticking it adds its `payTo` as a custom payee
  labelled with its name.
- In the recovery memo, sellers are stored as address hashes, not catalog indexes, so they do not depend on list order.

**MCP**
- `satchel_status` and `satchel_catalog` show labels from the connect code. Custom payees appear in a `payees` list.
- `satchel_catalog` lists Satchel's tools (from `/api/config`) **plus** the tools of every origin in `SATCHEL_PAY_ORIGINS`
  (from its `/.well-known/satchel.json`). Each entry shows whether the vault may pay it.
- The connect code also carries the origins of the sellers chosen in the form. The MCP README tells the user to add those
  origins to `SATCHEL_PAY_ORIGINS`. That variable stays the only thing that widens which origins the MCP will pay: Satchel's
  server cannot widen it remotely.

### 2. `satchel_send` (MCP)

- Input: `to` (CashAddr), `amountSats` (an integer, at least 546), `memo` (optional, at most 100 UTF-8 bytes).
- Guards, in this order, before anything is signed:
  1. a vault is connected;
  2. `to` is in the vault's allowlist (compared by locking bytecode);
  3. `amountSats` ≤ `SATCHEL_MAX_SEND_SATS` (new env, default 10000);
  4. one payment at a time (the existing serialization).
- The payment is built with `VaultSpender` (shared, `src/lib/spend.ts`). The memo goes in the covenant's optional OP_RETURN
  output 2, as `"SATM" || utf8(memo)`, which the covenant already allows.
- Result: the txid, an explorer link, the amount, the fee, and what is left of this period's budget. A covenant refusal is
  reported the same way `satchel_pay_fetch` reports one (which rule failed).
- The tool description tells the model it can pay only the listed payees and only within the budget.

### 3. `satchel-pay-server` (new package, `provider-kit/`)

- Has its own `package.json`, follows the `mcp/` layout, is bundled with esbuild to ESM, and has tests that run in the root
  `npm test`.
- API (exact names are the builder's call; this is the shape):
  ```ts
  const pay = createPaywall({
    network: "mainnet" | "chipnet",
    secret,               // >= 32 chars; signs challenges (HMAC), like PROVIDER_SEED does today
    payTo,                // seller's CashAddr (or per-route override)
    getTransaction?,      // (txid) => raw hex; default: an Electrum client for the network
    resultCache?,         // optional; default in-memory per instance, as today
  });
  // Wrap a Fetch API handler: answers 402 with a challenge, verifies the X-Payment header, runs the handler once per payment.
  export const POST = pay.route({ resource: "/api/address", price: 500n, params: ["address"] }, async (input) => ({ ... }));
  ```
- Behaviour is moved, not reinvented, from `src/lib/server/x402.ts` and `src/app/api/tools/[tool]/route.ts`: the challenge
  (`resource`, `payTo`, `amount`, `nonce`, `expires`, `network`, `request`, `sig`), the request digest, the "SC402" ||
  nonce memo, idempotent replay for the identical request, input validation **before** asking for payment, 400 versus
  502 errors, and returning `paidWith` on failure so the caller can retry without paying again.
- Also exported: a small `/.well-known/satchel.json` helper. It returns the seller's catalog (name, description, price,
  params, payTo, endpoint), in the same shape as Satchel's `/api/config` `tools`, so `satchel_catalog` can list a seller's
  tools.
- Docs: a README with a 10-line example for Next.js and one for Hono, the protocol in brief, and the 0-conf risk statement.

**Satchel app on the kit**
- `src/app/api/tools/[tool]/route.ts` becomes a thin adapter over the kit. `PROVIDER_SEED` remains the secret, and
  provider i's payout address is unchanged (so existing vaults keep paying the same addresses).
- `src/lib/server/x402.ts` keeps only what the hosted agent needs, or re-exports from the kit. The builder decides how, but
  there must be one implementation.

### 4. Example seller (`examples/provider`)

- A separate small app deployed as its own Vercel project, on its own domain. It has its own `SELLER_SECRET` and its own
  payout address, which belongs to the user (an address from the user's wallet, given by the user). It holds **no private
  key** and spends nothing: the user chose a seller without a hot wallet.
- **Service (my call): a BCH developer toolkit, "CashAddr & script decoder"**, with no upstream dependency:
  - `POST /api/address` with `{ address }` → every form of the address (CashAddr with and without a token marker, legacy
    Base58), its type (P2PKH, P2SH20, P2SH32), network, and locking bytecode hex;
  - `POST /api/script` with `{ hex }` → the locking or unlocking script disassembled into readable opcodes, the detected
    standard type, and decoded OP_RETURN pushes (hex plus printable text).
  Both are deterministic, run on libauth alone and are always available, which suits a reliable demo. Price: 500 sats each.
  Agents often get CashAddr and script details wrong, so this has small but real value. Its main job is to prove that a
  vault pays a seller that is not Satchel.
- It serves `/.well-known/satchel.json`. The user adds its origin to `SATCHEL_PAY_ORIGINS` and its payout address as a
  custom payee in the vault. This is the end-to-end proof that a vault pays a seller that is not Satchel.

### 5. New Satchel tools (appended to the catalog: providers 3 and 4)

- **`bch-address`** — `{ address }` → confirmed and unconfirmed balance, UTXO count, fungible token totals and NFT counts
  by category, and the last 10 transactions (txid, height). Electrum: `blockchain.scripthash.get_balance`, `listunspent`
  (with token data) and `get_history`. Price: 800 sats.
- **`bch-tx`** — `{ txid }` → decoded transaction: confirmations or height, inputs (outpoints), outputs (address or script
  type, value, token data), OP_RETURN data as hex plus printable text, size and fee when the inputs can be fetched. Price:
  500 sats.
- Both validate their input before asking for payment (a malformed address or txid gets a 400 with nothing paid), work on
  the app's network, and have a time limit on Electrum calls.
- `PROVIDER_COUNT` becomes 5. Existing vaults keep working: their allowlists simply don't include the new providers.

### 6. Real `deep-analysis`

- New env `TOOL_LLM=on` (default off) plus the existing gateway credentials. `hasLlm()` is split into `agentUsesLlm()`
  (`AGENT_MODE=llm`, unchanged) and `toolUsesLlm()` (`TOOL_LLM=on`).
- `TOOL_MODEL` sets the model (default `anthropic/claude-haiku-5.5`), so the free tier or paid credits is a configuration
  choice. When the tool LLM is off, the catalog description says "(demo mode: placeholder answer)", and `/api/config`
  shows `deepAnalysis: "demo" | "live"`, so no one pays 3000 sats without knowing.
- The spend cap lives in the AI Gateway dashboard (a budget), which the user sets. The README says so.

## Testing and verification

- **Unit:** recovery v2 (round trip for each entry type, v1 still decodes, the size limit, PUSHDATA1 parsing, a rebuilt
  contract that doesn't match is rejected); the kit (challenge signing and checking, digest, memo check, idempotent
  replay, input validation before 402, error mapping) using a stubbed `getTransaction`; `satchel_send` guards and the
  memo; `bch-address`/`bch-tx` with a stubbed Electrum; the `toolUsesLlm` split.
- **Covenant tests unchanged**; they must all still pass.
- **Where e2e runs:** against a local mainnet dev server (launch config `satchel-mainnet`) plus the example seller, as for
  the previous mainnet e2e. Vercel preview deployments sit behind Vercel's login by default, so they are not used for e2e.
  After merging, run a smoke test on production.
- **Chipnet, then mainnet e2e** (extend `mcp/scripts/mainnet-e2e.mts`, tiny amounts): create a vault with one custom payee
  (the user's own address) plus the example seller plus `bch-tx`; `satchel_send` to the custom payee; `satchel_pay_fetch`
  to `bch-tx` and to the seller's `/api/address`; a refusal when over the cap; recover the vault from chain by scanning the owner's history;
  withdraw. Record the txids as evidence.
- `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` pass. The `mcp/` and `provider-kit/` typecheck passes.
  `npm pack --dry-run` of each package shows only the intended files.

## Left to the builder

- The exact names in the kit API, file layout inside `provider-kit/`, and how `x402.ts` re-exports from the kit.
- Electrum client choice inside the kit (keep it free of `cashscript` if practical).
- UI details of the custom-payee rows (within the copy and flow above).
- Example seller framework (Hono or a minimal Next.js app), whichever deploys cleanly on Vercel.
- Order of work, as long as the live deployment is only updated after mainnet verification.

## Calls I made (for the user to check)

- `satchel_send` exists only in MCP, not in the hosted agent.
- At most 8 payees in total; custom payees are also limited by the 215-byte recovery memo (about 7 P2PKH).
- Labels are not on chain. A vault recovered from chain shows "Custom payee" plus a short address.
- `SATCHEL_MAX_SEND_SATS` defaults to 10000; memo at most 100 bytes, prefixed "SATM".
- Example seller = "CashAddr & script decoder" (no wallet, no upstream API) on its own domain; payout address is one
  from the user's wallet. (Considered and rejected: a timestamp notary, which needs a hot wallet; and a CashTokens
  metadata lookup, because no stable public BCMR API could be confirmed.)
- Suggested sellers come from `SATCHEL_SELLERS` in `/api/config` and are stored in the recovery memo as hashes.
- Prices: `bch-address` 800 sats, `bch-tx` 500 sats.
- `deep-analysis` live behind `TOOL_LLM=on`, separate from `AGENT_MODE`; demo mode is labelled in the catalog.
