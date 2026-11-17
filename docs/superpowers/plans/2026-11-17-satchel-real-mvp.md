# Satchel Real MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Satchel into a real MVP for developers with their own agent. Vaults can pay any approved BCH address
(`satchel_send`). Anyone can sell an API with `satchel-pay-server`. Satchel's own tools have real value (BCH chain data,
a live `deep-analysis`).

**Architecture:** The covenant does not change. A new package `provider-kit/` (`satchel-pay-server`) holds the bch-sc402
seller side, and the Satchel app runs its `/api/tools/*` on it. Recovery memos move to v2 to carry custom payee hashes.
The MCP server gains `satchel_send` and lists sellers from other origins. An example seller (`examples/provider`, Hono)
is deployed as a separate Vercel project.

**Tech Stack:** Next.js 16, CashScript 0.14, `@bitauth/libauth@3.1.0-next.8`, `@electrum-cash/network` 4.x, AI SDK 7
(Vercel AI Gateway), MCP SDK, vitest, esbuild, Hono.

**Spec:** `docs/superpowers/specs/2026-11-17-satchel-real-mvp-design.md`. Read it first; this plan argues from it.

## Global Constraints

- `contracts/Satchel.cash` must not change. All covenant tests (`src/lib/vault.test.ts`) must keep passing unchanged.
- `@bitauth/libauth` is pinned to `3.1.0-next.8` in every package.json that lists it.
- Sats are `bigint` everywhere (suffix `n`). JSON carries sats as decimal strings.
- The bch-sc402 wire format does not change: the challenge fields `resource, payTo, amount, nonce, expires, network, request, sig`, the header `X-Payment: base64(JSON {challenge, txid})`, the memo `"SC402" || nonce`, and the 402 body `{ error, accepts: [{ scheme: "bch-sc402", ...challenge }] }`.
- The catalog order is append-only. Existing indexes `crypto-price`=0, `web-reader`=1, `deep-analysis`=2 must not move. New tools: `bch-address`=3, `bch-tx`=4. `PROVIDER_COUNT = 5`.
- v1 recovery memos must still decode. New vaults write v2.
- Allowlist: 1 to 8 payees in total. The recovery payload is at most **215 bytes** (whole OP_RETURN script ≤ 223).
- Custom payees are stored in their **canonical non-token CashAddr form** (a `z…`/`r…` address is normalized to `q…`/`p…`).
- Secrets stay server-side: `PROVIDER_SEED`, `SELLER_SECRET`, the agent key. None go in client code, logs or tool output.
- Every new endpoint validates its input **before** answering 402. A request that can only fail must never cost money.
- UI copy is in English. In Next.js 16, request APIs are async; read `node_modules/next/dist/docs/` before using a Next API.
- Chipnet first. Mainnet only with tiny amounts that can be recovered. Every publish (`npm publish`) and every production
  env/deploy change is done only after asking the user.
- Work happens on branch `feat/real-mvp`. Production (https://satchel-sigma.vercel.app) is updated only after the mainnet e2e passes.

## Review Focus

1. A custom payee entered as a token-aware `z…` address, or the same address as a tool's payTo: it must be normalized
   and deduplicated, not stored twice. Test: Task 1 `normalizePayee` and Task 3 `buildAllowlist`.
2. An address for the other network (`bchtest:` on mainnet) as a payee, an MCP `to`, or a `bch-address` input: rejected
   with a clear message, before anything is signed or paid. Tests: Tasks 1, 6, 8.
3. A `satchel_send` memo whose UTF-8 bytes exceed 100 while its JS `length` does not (emoji, Vietnamese): rejected.
   Test: Task 8.
4. A seller origin in `SATCHEL_PAY_ORIGINS` that is down or serves invalid `/.well-known/satchel.json`: `satchel_catalog`
   still lists Satchel's tools and reports that seller's error instead of failing. Test: Task 8.
5. A well-formed `bch-tx` txid that does not exist: answered 404 **before** the 402, so nobody pays for nothing. Test: Task 6.

---

### Task 1: Payee normalization and recovery memo v2

**Files:**
- Create: `src/lib/payees.ts`, `src/lib/payees.test.ts`
- Modify: `src/lib/recovery.ts`, `src/lib/recovery.test.ts`, `src/lib/client/wallet.ts` (pass the network to `findVaultsInTransactions` if its signature changes)

**Interfaces:**
- Produces:
  - `normalizePayee(address: string, network: BchNetwork): { ok: true; address: string } | { ok: false; error: string }`
    accepts P2PKH, P2SH20 and P2SH32, with or without a token marker, and returns the non-token CashAddr with prefix
    `bitcoincash` (mainnet) or `bchtest` (chipnet). Error strings: `"not a valid BCH address"`,
    `"address is for chipnet, this vault is on mainnet"` (and the reverse), `"unsupported address type"`.
  - `MAX_RECOVERY_PAYLOAD = 215`
  - `recoveryPayloadSize(allowlist: string[], knownPayees: string[]): number`
  - `encodeRecoveryMemo(params, agentIndex, knownPayees): string[]`: same signature, now writes v2.
  - `decodeRecoveryMemo(lockingBytecode, ownerPk, knownPayees, network: BchNetwork)`: gains `network`.
  - `findVaultsInTransactions(txs, ownerPk, knownPayees, provider)`: unchanged signature; uses `provider.network` for decoding.

- [ ] **Step 1: Write failing tests** in `src/lib/payees.test.ts`:
  - `normalizePayee` maps a `bitcoincash:z…` P2PKH-with-tokens address to its `bitcoincash:q…` form.
  - It leaves a mainnet `q…` unchanged, and rejects a `bchtest:` address on `"mainnet"` with the network error.
  - It rejects `"hello"`.
  - It accepts a P2SH32 address.

  And in `src/lib/recovery.test.ts`:
  - `v2 round-trips known indexes, P2PKH, P2SH20 and P2SH32 payees`: build params with one known payee and three custom
    ones, encode, then decode with `"chipnet"`; expect an allowlist equal to the inputs normalized, and the same cap,
    period and agentIndex.
  - `v1 memos still decode`: a hand-built v1 payload (`version=1`, two known indexes) decodes as before.
  - `payload over 215 bytes throws`: eight P2SH32 payees → `encodeRecoveryMemo` throws `/too many custom payees/`.
  - `PUSHDATA1 payload is parsed`: a v2 memo longer than 75 bytes round-trips through `findVaultsInTransactions`
    (genesis on `MockNetworkProvider`, as the existing test does).
  - `a memo whose rebuilt contract does not match is ignored`: the existing guard, now with a v2 memo.
- [ ] **Step 2: Run** `npx vitest run src/lib/payees.test.ts src/lib/recovery.test.ts` and expect the new tests to FAIL.
- [ ] **Step 3: Implement** `src/lib/payees.ts` with libauth `decodeCashAddress`/`encodeCashAddress`. In `recovery.ts`,
  write v2 entries: `0x00 i` for a known payee (index < 256), `0x01 <20B>` P2PKH, `0x02 <20B>` P2SH20, `0x03 <32B>` P2SH32.
  Push the payload with a direct push when ≤ 75 bytes, else `0x4c len`. Decode both push forms and both versions. Throw
  `"Allowlist must have 1 to 8 entries"` outside 1..8, and
  `"too many custom payees to recover this vault from chain (payload N > 215 bytes)"` past the limit.
- [ ] **Step 4: Run** `npm test` and expect all PASS. Run `npm run typecheck` and expect it to be clean.
- [ ] **Step 5: Commit** `feat: recovery memo v2 with custom payee hashes`.

### Task 2: Labels and seller origins in descriptor and connect code

**Files:**
- Modify: `src/lib/descriptor.ts`, `src/lib/connect-code.ts`, `src/lib/connect-code.test.ts`

**Interfaces:**
- Produces:
  - `DescriptorSchema` gains `labels: z.record(z.string(), z.string().min(1).max(32)).optional()`, keyed by canonical
    address, and `sellers: z.array(z.string().url()).max(8).optional()` (origins).
  - `ConnectInfo` gains the same optional `labels` and `sellers`. `encodeConnectCode` copies them, and only them, beyond
    today's fields.

- [ ] **Step 1: Write failing tests** in `connect-code.test.ts`:
  - `round-trips labels and seller origins`.
  - `a code from 0.1.0 without labels still decodes`: the fixture is today's encoded string.
  - `drops unknown fields`: an injected `token` field never appears in the decoded info.
- [ ] **Step 2: Run** `npx vitest run src/lib/connect-code.test.ts` and expect it to FAIL.
- [ ] **Step 3: Implement** the schema additions.
- [ ] **Step 4: Run** `npm test` and expect PASS.
- [ ] **Step 5: Commit** `feat: payee labels and seller origins in descriptor and connect code`.

### Task 3: Custom payees and suggested sellers in the web app

**Files:**
- Create: `src/lib/server/sellers.ts`, `src/lib/server/sellers.test.ts`, `src/lib/allowlist.ts`, `src/lib/allowlist.test.ts`
- Modify: `src/app/api/config/route.ts`, `src/lib/client/agent.ts` (`AppConfig`), `src/components/CreateVault.tsx`,
  `src/components/SatchelApp.tsx`, `src/components/Dashboard.tsx`, `src/lib/client/wallet.ts` (`CreateVaultInput`), `.env.example`

**Interfaces:**
- Consumes: `normalizePayee`, `recoveryPayloadSize`, `MAX_RECOVERY_PAYLOAD` (Task 1); descriptor `labels`/`sellers` (Task 2).
- Produces:
  - `type SellerInfo = { name: string; origin: string; payTo: string; description: string }`
  - `loadSellers(env = process.env): SellerInfo[]` parses `SATCHEL_SELLERS` (a JSON array). Invalid JSON or an invalid
    entry throws at startup with the env var's name in the message. Empty or unset → `[]`.
  - `AppConfig.sellers: SellerInfo[]`
  - `buildAllowlist(input: { tools: string[]; sellers: SellerInfo[]; custom: { label: string; address: string }[]; network: BchNetwork; knownPayees: string[] }): { ok: true; allowlist: string[]; labels: Record<string, string>; sellers: string[] } | { ok: false; error: string }`
    in `src/lib/allowlist.ts`, a pure function that the form calls.
  - `CreateVaultInput` gains `labels: Record<string, string>` and `sellers: string[]`. `createVault` stores both in the
    returned descriptor.

- [ ] **Step 1: Write failing tests:**
  - `sellers.test.ts`: parses one valid seller; `[]` when unset; throws `/SATCHEL_SELLERS/` on invalid JSON and on a
    seller whose payTo is not an address.
  - `allowlist.test.ts`:
    - tools + one seller + one custom payee → three entries; the labels hold the seller name and the custom label;
      `sellers` holds the seller origin.
    - a `z…` custom address equal to a tool's payTo → error `/already in the list/`.
    - 9 payees in total → error `/at most 8/`.
    - a payload over 215 bytes → error `/recover/`.
    - an empty label → error `/label/`.
    - a wrong-network address → that network's error.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/sellers.test.ts src/lib/allowlist.test.ts` and expect FAIL.
- [ ] **Step 3: Implement** `loadSellers`, `buildAllowlist`, and add `sellers` to `/api/config`. In `CreateVault`, add a
  "Suggested sellers" block (one checkbox per seller, off by default, showing name, description and origin) and a "Custom
  payees" block (rows of label + address, "Add payee", "Remove"). `submit` calls `buildAllowlist` and shows its error in
  the existing `formError`. In `Dashboard`, payee names come from the tool name, else `descriptor.labels[addr]`, else
  `Custom payee <shortAddress>`. The connect code (`ConnectAgentCard`) passes `labels` and `sellers`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run lint`, and expect them clean.
- [ ] **Step 5: Verify in the browser:** start the `satchel-dev` preview (chipnet) with
  `SATCHEL_SELLERS='[{"name":"Test seller","origin":"https://example.com","payTo":"<a chipnet address>","description":"test"}]'`.
  Read the create form and check the seller checkbox and custom-payee rows. Enter a `bchtest:z…` duplicate of a tool
  and check that the error is shown. Take a screenshot.
- [ ] **Step 6: Commit** `feat: custom payees and suggested sellers when creating a vault`.

### Task 4: `satchel-pay-server` package

**Files:**
- Create: `provider-kit/package.json` (name `satchel-pay-server`, version `0.1.0`, `type: module`, `exports` →
  `dist/index.js` + `dist/index.d.ts`, `files: ["dist","README.md"]`, deps `@bitauth/libauth@3.1.0-next.8` and
  `@electrum-cash/network@^4.4.8`), `provider-kit/build.mjs` (esbuild ESM, deps external, then
  `tsc --emitDeclarationOnly`), `provider-kit/tsconfig.json` (like `mcp/tsconfig.json`), `provider-kit/README.md`
- Create: `provider-kit/src/protocol.ts`, `provider-kit/src/challenge.ts`, `provider-kit/src/verify.ts`,
  `provider-kit/src/cache.ts`, `provider-kit/src/paywall.ts`, `provider-kit/src/electrum.ts`, `provider-kit/src/index.ts`,
  and a test file for each of `challenge`, `verify` and `paywall`
- Modify: root `tsconfig.json` (exclude `provider-kit`, `examples`), `eslint.config.mjs` (ignore `provider-kit/dist/**`,
  `examples/**/node_modules/**`), `.gitignore` (`provider-kit/dist/`, `provider-kit/node_modules/`)

**Interfaces:**
- The kit must not import from `../src` and must not depend on `cashscript`. Its only runtime globals are
  `globalThis.crypto.getRandomValues`, `TextEncoder`, `Request` and `Response`. HMAC and SHA-256 come from libauth
  (`hmacSha256`, `sha256`), so it runs on Node, Bun, Deno and Workers.
- Produces (`provider-kit/src/index.ts` re-exports all of these):
  - `protocol.ts`: `SCHEME = "bch-sc402"`, `MEMO_PREFIX_HEX` (hex of `"SC402"`), `interface Challenge` (the fields above),
    `memoForChallenge(c: Pick<Challenge,"nonce">): string`, `type BchNetwork = "mainnet" | "chipnet"`.
  - `challenge.ts`:
    - `signChallengeBody(c: Omit<Challenge,"sig">, secret: string): string`: hex HMAC-SHA256 over
      `JSON.stringify({resource,payTo,amount,nonce,expires,network,request})`, byte-identical to today's `createHmac`
      output.
    - `requestDigest(name: string, params: Record<string,string> | URLSearchParams): string`: today's canonicalization.
    - `createChallenge(o: { resource; payTo; amount: bigint; request; network: BchNetwork; secret: string; ttlMs?: number; now?: number }): Challenge`,
      with `ttlMs` defaulting to 600000.
    - `checkChallenge(c: Challenge | undefined, o: { resource: string; request?: string; secret: string; now?: number }): string | null`,
      returning today's error strings.
  - `verify.ts`: `verifyPaymentTx(rawHex: string, challenge: Challenge): string | null`. It returns null when an output
    pays `payTo` at least `amount` **and** an OP_RETURN output contains `memoForChallenge`. Otherwise it returns today's
    error strings.
  - `cache.ts`: `class ResultCache<T>`, moved unchanged from `src/lib/server/result-cache.ts`.
  - `electrum.ts`: `electrumTransactionFetcher(network: BchNetwork, host?: string): (txid: string) => Promise<string>`.
    It connects lazily, reuses one client, and uses default hosts `bch.imaginary.cash` (mainnet) and `chipnet.bch.ninja`
    (chipnet), the same hosts as CashScript.
  - `paywall.ts`:
    - `class InputError extends Error { status: 400 | 404 }`
    - `interface PaidRoute { resource: string; name: string; price: bigint; payTo: string; params: readonly string[]; validate?: (p: URLSearchParams) => void | Promise<void>; handler: (p: URLSearchParams) => Promise<unknown> }`
    - `createPaywall(cfg: { network: BchNetwork; secret: string; getTransaction?: (txid: string) => Promise<string>; cache?: ResultCache<unknown>; now?: () => number; log?: (evt: Record<string, unknown>) => void }): { handle(req: Request, route: PaidRoute): Promise<Response> }`
    - `type CatalogEntry = { name: string; title: string; description: string; price: string; params: Record<string,string>; payTo: string; endpoint: string }`
    - `wellKnownResponse(info: { name: string; network: BchNetwork; tools: CatalogEntry[] }): Response` (JSON, CORS `*`).
  - `handle` behaviour, moved from `src/app/api/tools/[tool]/route.ts`:
    1. Read params from the JSON body (POST) or the query (GET).
    2. Reject unknown parameter names with 400 `unknown parameter "x"; expected: a, b`.
    3. Run `validate`: `InputError` → its status; anything else → 500.
    4. With no `X-Payment` → 402 with the challenge and header `www-authenticate: BCH-SC402 realm="satchel"`.
    5. Otherwise check the challenge and verify the tx. Failure → 402 `{error}`.
    6. A cached result for the nonce → 200 with it.
    7. Run `handler`. Success → cache it, 200 `{result, paidWith}`. `InputError` → its status `{error, paidWith}`.
       Other errors → 502 `{error, paidWith}`.

- [ ] **Step 1: Write failing tests:**
  - `challenge.test.ts`: port every case of `src/lib/server/x402.test.ts`, plus `signature equals node:crypto createHmac output`.
  - `verify.test.ts`: a decoded tx paying payTo with the memo → null; underpaying → error; a missing memo → error; an
    unrelated OP_RETURN → error.
  - `paywall.test.ts`, using a stubbed `getTransaction` and fixed `now`:
    - unknown param → 400, and no 402 is issued;
    - `validate` throwing `InputError(…,404)` → 404 before any 402;
    - no header → 402 whose `accepts[0].scheme === "bch-sc402"`;
    - a valid payment → 200, and `handler` called once;
    - replaying the same header → 200 from the cache, `handler` not called again;
    - a header for another request digest → 402 `payment is for a different request`;
    - `handler` throwing → 502 with `paidWith`;
    - `wellKnownResponse` serves JSON with `access-control-allow-origin: *`.
- [ ] **Step 2: Run** `npx vitest run provider-kit` and expect FAIL.
- [ ] **Step 3: Implement** the modules. Write the README with a Next.js route example and a Hono example (about 10
  lines each), the protocol in brief, the 0-conf risk sentence from the spec, and an env table (`SELLER_SECRET` ≥ 32
  chars). State that Cloudflare Workers need a custom `getTransaction` (no raw sockets).
- [ ] **Step 4: Run** `npm test` and expect PASS. Then run `cd provider-kit && npx tsc --noEmit -p tsconfig.json && node build.mjs && npm pack --dry-run`
  and expect the files to be only `dist/index.js`, `dist/*.d.ts`, `README.md` and `package.json`. (Install the
  provider-kit dev deps with `npm install` inside `provider-kit/` if the build needs them, as `mcp/` does.)
- [ ] **Step 5: Commit** `feat: satchel-pay-server package (bch-sc402 seller kit)`.

### Task 5: Satchel's paid tools on the kit

**Files:**
- Modify: `src/lib/server/x402.ts`, `src/lib/x402-client.ts`, `src/app/api/tools/[tool]/route.ts`,
  `src/lib/server/result-cache.ts`, `src/lib/server/tool-impl.ts`
- Test: the existing `src/lib/server/x402.test.ts`, `hardening.test.ts`, `tool-input.test.ts` (all must pass, updated
  only where noted)

**Interfaces:**
- Consumes: everything Task 4 produces, imported by relative path (`../../../provider-kit/src/index`). No path alias.
- Produces:
  - `src/lib/server/x402.ts` keeps its exported names (`signChallengeBody`, `requestDigest`, `createChallenge`,
    `checkChallenge`, `verifyPayment`, `memoForChallenge`, `MEMO_PREFIX_HEX`, `encodePaymentHeader`, `Challenge`) as
    thin wrappers that bind `secret = PROVIDER_SEED` and `network = NETWORK`.
  - `x402-client.ts` imports `SCHEME`, `MEMO_PREFIX_HEX`, `Challenge` and `memoForChallenge` from
    `provider-kit/src/protocol`, so there is one definition.
  - `validateToolInput(name, params): Promise<void>` becomes async and throws the kit's `InputError` (re-exported as
    `ToolInputError`).
  - `route.ts` builds a `PaidRoute` from `PAID_TOOLS[name]` and calls one module-level
    `createPaywall({ network: NETWORK, secret: PROVIDER_SEED, getTransaction: (txid) => getProvider().getRawTransaction(txid), cache: paidResults, log: (e) => logEvent("tool", e) })`.

- [ ] **Step 1: Update the tests:** in `tool-input.test.ts`, change the sync `expect(() => …).toThrow` to
  `await expect(…).rejects.toThrow`. Add `x402.test.ts` case `402 body is byte-compatible with 0.1.0 clients`:
  `parseChallenge` from `x402-client` accepts a kit-issued 402 body.
- [ ] **Step 2: Run** `npm test` and expect the updated tests to FAIL.
- [ ] **Step 3: Implement** the wrappers and route. Delete duplicated logic from the route and `x402.ts`, so that only
  the kit holds it.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `cd mcp && npx tsc --noEmit -p tsconfig.json && npm run build`,
  and expect all to pass. Then start the `satchel-dev` preview and `curl -s -X POST localhost:3000/api/tools/crypto-price -H 'content-type: application/json' -d '{"id":"bitcoin-cash"}'`;
  expect a 402 with `"scheme":"bch-sc402"`.
- [ ] **Step 5: Commit** `refactor: Satchel paid tools run on satchel-pay-server`.

### Task 6: `bch-address` and `bch-tx` tools

**Files:**
- Create: `src/lib/server/chain-tools.ts`, `src/lib/server/chain-tools.test.ts`
- Modify: `src/lib/tools.ts`, `src/lib/server/tool-impl.ts`, `src/lib/server/keys.ts` (only if it hardcodes 3),
  `src/lib/server/agent-runner.ts` (no new tools for the hosted agent; make sure it still compiles)

**Interfaces:**
- Consumes: `normalizePayee` (Task 1), `InputError` (Task 4).
- Produces:
  - `PAID_TOOLS` appends `"bch-address"` (price `800n`, provider `3`, params `{ address: "A BCH address (CashAddr)" }`)
    and `"bch-tx"` (price `500n`, provider `4`, params `{ txid: "A transaction id (64 hex chars)" }`).
    `PROVIDER_COUNT = 5`.
  - `addressInfo(address: string, rpc: Rpc): Promise<AddressInfo>` and `txInfo(txid: string, rpc: Rpc): Promise<TxInfo>`
    in `chain-tools.ts`, where `type Rpc = (method: string, ...params: unknown[]) => Promise<unknown>`. In production
    `rpc` is `getProvider().performRequest` with an 8 s timeout.
  - `AddressInfo = { address; network; balance: { confirmed: string; unconfirmed: string }; utxoCount: number; tokens: { category: string; fungible: string; nfts: number }[]; recent: { txid: string; height: number }[] }`,
    where `recent` holds at most 10 entries, mempool (height ≤ 0) first, then height descending.
  - `TxInfo = { txid; confirmations: number; height: number | null; size: number; fee: string | null; inputs: { txid: string; vout: number }[]; outputs: { index: number; value: string; address: string | null; type: string; token: {...} | null; opReturn: { hex: string; text: string | null } | null }[] }`.
    `fee` is null when an input transaction cannot be fetched or there are more than 20 inputs.
  - Validation before payment: `bch-address` → `normalizePayee` on the app's network (any type allowed), else 400.
    `bch-tx` → `/^[0-9a-f]{64}$/` (400), then `blockchain.transaction.get` must succeed, else 404 `transaction not found`.

- [ ] **Step 1: Write failing tests** with a stubbed `rpc` that returns canned Electrum responses:
  - balance and token aggregation;
  - `recent` ordering and the 10-item cap;
  - an address for the other network → 400 `InputError`;
  - `txInfo` decodes P2PKH and OP_RETURN outputs, the token data and the fee;
  - `fee: null` when an input fetch fails;
  - unknown txid → `InputError` with status 404 from `validateToolInput("bch-tx", …)`;
  - the catalog keeps `crypto-price, web-reader, deep-analysis` at indexes 0–2.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/chain-tools.test.ts` and expect FAIL.
- [ ] **Step 3: Implement**, using `blockchain.scripthash.get_balance`,
  `blockchain.scripthash.listunspent` (with `"include_tokens"`), `blockchain.scripthash.get_history`,
  `blockchain.transaction.get` and `blockchain.transaction.get_height` (or `get` verbose; whichever Fulcrum serves).
  Decode with libauth.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`, and expect PASS. Live check on chipnet with the preview:
  GET `/api/tools/bch-tx?txid=<a known chipnet txid>` → 402; `?txid=00…00` → 404; `?txid=xyz` → 400.
- [ ] **Step 5: Commit** `feat: bch-address and bch-tx paid tools`.

### Task 7: Live `deep-analysis`, separate from the demo agent

**Files:**
- Modify: `src/lib/server/llm.ts`, `src/lib/server/tool-impl.ts`, `src/lib/server/agent-runner.ts`,
  `src/app/api/agent/run/route.ts`, `src/app/api/config/route.ts`, `src/lib/client/agent.ts` (`AppConfig`), `.env.example`
- Test: `src/lib/server/llm.test.ts` (create)

**Interfaces:**
- Produces:
  - `agentUsesLlm(env = process.env): boolean`, the old `hasLlm` (renamed everywhere).
  - `toolUsesLlm(env = process.env): boolean`: `env.TOOL_LLM === "on"` and (`AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`).
  - `TOOL_MODEL = process.env.TOOL_MODEL ?? "anthropic/claude-haiku-5.5"`.
  - `/api/config` adds `deepAnalysis: "live" | "demo"`. When it is `"demo"`, the `deep-analysis` description gets the
    suffix ` (demo mode: placeholder answer)`.

- [ ] **Step 1: Write failing tests:**
  - `toolUsesLlm` is false without `TOOL_LLM`, false with `TOOL_LLM=on` and no credentials, and true with both;
  - `agentUsesLlm` ignores `TOOL_LLM`;
  - the config description gets the suffix in demo mode.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/llm.test.ts` and expect FAIL.
- [ ] **Step 3: Implement.** `deepAnalysis` uses `toolUsesLlm()` and `TOOL_MODEL`. Add `TOOL_LLM` and `TOOL_MODEL` to
  `.env.example`, with a comment telling the user to set an AI Gateway budget in the Vercel dashboard.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run build`, and expect them clean.
- [ ] **Step 5: Commit** `feat: live deep-analysis behind TOOL_LLM, separate from AGENT_MODE`.

### Task 8: MCP `satchel_send`, labels and multi-origin catalog

**Files:**
- Modify: `mcp/src/config.ts`, `mcp/src/tools.ts`, `mcp/src/server.ts`, `mcp/src/tools.test.ts`, `mcp/src/server.test.ts`, `mcp/README.md`

**Interfaces:**
- Consumes: `normalizePayee` (Task 1); `ConnectInfo.labels`/`sellers` (Task 2); `CatalogEntry` shape (Task 4);
  `VaultSpender.pay(t, to, amount, memoHex)` (existing).
- Produces:
  - `McpConfig.maxSendSats: bigint` from `SATCHEL_MAX_SEND_SATS` (default `"10000"`; it must be a whole number, else a
    startup error naming the variable).
  - `handlers.send(args: { to: string; amountSats: number; memo?: string }): Promise<ToolResult>`. The checks run in this
    order:
    1. a vault is connected;
    2. `normalizePayee(to, cfg.network)`;
    3. `to` is in the allowlist (by locking bytecode);
    4. `546 ≤ amount ≤ maxSendSats`;
    5. the memo is at most 100 UTF-8 bytes.

    Memo hex = hex(`"SATM"`) + hex(utf8(memo)). On success it returns
    `{ txid, explorer, to, label, amount, fee, spentThisPeriod, remaining, balance }`. A covenant refusal uses the same
    message format as `payFetch`.
  - Tool `satchel_send` registered in `server.ts` with inputSchema
    `{ to: z.string(), amountSats: z.number().int().min(546), memo: z.string().optional() }` and this description: "Pays
    BCH directly from the vault to one of its allowlisted payees (see satchel_status). The vault's covenant caps spending
    per period and refuses any other recipient. Only pay when the user asked for it or it is clearly part of the task they
    gave you."
  - `status()` adds `payees: { address: string; label: string | null }[]`. `connect()` adds `sellerOrigins` and, for any
    of them not in `cfg.payOrigins`, `addToPayOrigins: string[]` with a one-line instruction.
  - `catalog()` returns `{ tools: [...], sellers: [{ origin, ok: boolean, error?: string, tools?: [...] }] }`. Seller
    tools come from `${origin}/.well-known/satchel.json` for each `cfg.payOrigins` entry other than Satchel's own origin,
    fetched with a 5 s timeout. `allowed` is computed against the allowlist, as it is for Satchel's tools.
  - `VERSION` stays `0.1.0` (not published yet).

- [ ] **Step 1: Write failing tests** in `tools.test.ts`, with the existing mocks:
  - `send` pays an allowlisted custom payee and puts `SATM` + memo in the tx;
  - it refuses a non-allowlisted address with `/not in this vault's allowlist/` and calls no spender;
  - it refuses `amountSats` above `SATCHEL_MAX_SEND_SATS`;
  - it refuses a memo of 34 emoji (136 bytes) with `/100 bytes/`;
  - it refuses a `bchtest:` address on mainnet;
  - `catalog` with one seller origin returning invalid JSON → Satchel tools listed and `sellers[0].ok === false`;
  - `status` shows labels from the connect code.

  In `server.test.ts`: `satchel_send` is in `listTools`.
- [ ] **Step 2: Run** `npm test` and expect FAIL.
- [ ] **Step 3: Implement.** Update `mcp/README.md`: the tools table (6 tools), the env table (`SATCHEL_MAX_SEND_SATS`,
  `SATCHEL_PAY_ORIGINS`), custom payees, the scope of v0.1.0 (Satchel's tools, sellers using `satchel-pay-server`, direct
  sends; not x402-bch `exact` yet, with the reason from the spec), and the 0-conf note.
- [ ] **Step 4: Run** `npm test`, then `cd mcp && npx tsc --noEmit -p tsconfig.json && npm run build`, and expect them clean.
- [ ] **Step 5: Commit** `feat(mcp): satchel_send, payee labels and seller catalogs`.

### Task 9: Example seller (`examples/provider`)

**Files:**
- Create: `examples/provider/package.json` (deps `hono` and `satchel-pay-server`, which in this task is
  `file:./vendor/satchel-pay-server-0.1.0.tgz` from `npm pack` of `provider-kit`; it is switched to the npm version in
  Task 10 if the user approves publishing), `examples/provider/src/index.ts`, `examples/provider/src/decoder.ts`,
  `examples/provider/src/decoder.test.ts`, `examples/provider/README.md`, `examples/provider/vendor/` (the packed tarball, committed)
- Create: root `vitest.config.ts` that excludes `examples/**`, `**/node_modules/**` and `**/dist/**`. The example has its
  own install and test run, while the root `npm test` keeps running `src/`, `mcp/` and `provider-kit/` tests.

**Interfaces:**
- Consumes: `createPaywall`, `InputError`, `wellKnownResponse` and `CatalogEntry` from `satchel-pay-server`.
- Produces:
  - `decodeAddress(address: string): { forms: { cashaddr: string; tokenAware: string; legacy: string | null }; type: "p2pkh" | "p2sh20" | "p2sh32"; network: "mainnet" | "chipnet"; lockingBytecode: string }`.
    `legacy` is null for P2SH32. It throws `InputError` (400) for an invalid address.
  - `decodeScript(hex: string): { asm: string; type: "p2pkh" | "p2sh20" | "p2sh32" | "op_return" | "nonstandard"; opReturn: { hex: string; text: string | null }[] | null }`.
    It throws `InputError` for non-hex or a script over 10000 bytes.
  - Hono app:
    - `POST /api/address` (`{address}`, 500 sats) and `POST /api/script` (`{hex}`, 500 sats), both via `createPaywall`
      and validated before the 402;
    - `GET /.well-known/satchel.json` via `wellKnownResponse`, with endpoints built from the request origin;
    - `GET /` serves a short plain-text page saying what this seller is.
  - Env: `SELLER_NETWORK` (`mainnet`), `SELLER_SECRET` (≥ 32 chars), `SELLER_PAY_TO` (an address from the user's wallet,
    given by the user).

- [ ] **Step 1: Write failing tests** in `decoder.test.ts`:
  - a known mainnet P2PKH → its legacy form (a fixed vector);
  - a `z…` input gives the same `cashaddr`;
  - a P2SH32 → `legacy: null`;
  - `6a0453415443…` decodes the OP_RETURN text;
  - `"zz"` → `InputError`.
- [ ] **Step 2: Run** them (`cd examples/provider && npm install && npx vitest run`) and expect FAIL.
- [ ] **Step 3: Implement** the decoder with libauth (`decodeCashAddress`, `encodeCashAddress`,
  `lockingBytecodeToBase58Address`, `disassembleBytecodeBCH`), and the Hono app. Write a README covering what it sells,
  its env and how to deploy it (a new Vercel project with root `agentvault/examples/provider`).
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit`, and expect PASS. Run it locally with chipnet env and check:
  `curl -X POST localhost:<port>/api/address -d '{"address":"bad"}'` → 400; a valid address → 402 with `bch-sc402`;
  `/.well-known/satchel.json` lists both tools.
- [ ] **Step 5: Commit** `feat: example seller (CashAddr & script decoder) on satchel-pay-server`.
- [ ] **Step 6: Deploy (ask the user first):** the user creates the Vercel project. They provide `SELLER_PAY_TO` from
  their own wallet, and we set `SELLER_SECRET` (`openssl rand -hex 32`, entered by the user in the Vercel dashboard).
  Check that the production URL serves `/.well-known/satchel.json` and gives a 402 on `/api/address`.

### Task 10: End-to-end on mainnet, docs and release

**Files:**
- Modify: `mcp/scripts/mainnet-e2e.mts`, `README.md`, `CLAUDE.md` (layout and commands for `provider-kit/` and
  `examples/provider`; the new env vars), `.env.example`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Extend the e2e script.** Add env `E2E_SELLER_ORIGIN` and `E2E_CUSTOM_PAYEE` (default: the test owner's
  own address, so the send is recovered). Then:
  1. create a vault with allowlist `[bch-tx payTo, seller payTo (from its /.well-known), custom payee]` and labels;
  2. connect;
  3. `satchel_send` 1000 sats with memo `"e2e"` to the custom payee;
  4. `satchel_pay_fetch` `bch-tx` with the genesis txid;
  5. `satchel_pay_fetch` the seller's `/api/address`;
  6. keep paying until the covenant refuses;
  7. `findVaultsInTransactions` over the genesis tx recovers the vault (v2 memo);
  8. withdraw.

  Log every txid with an explorer link and print `E2E OK`.
- [ ] **Step 2: Chipnet run (if chipnet coins are available; otherwise say so and go to mainnet).** Run it against the
  `satchel-dev` preview and a local seller on chipnet. Expect `E2E OK`.
- [ ] **Step 3: Mainnet run (ask the user first; tiny amounts).** Use the `satchel-mainnet` preview plus the deployed
  seller: `cd mcp && npm run build && E2E_ALLOW_MAINNET=1 E2E_SELLER_ORIGIN=<seller url> npx tsx scripts/mainnet-e2e.mts`.
  Expect `E2E OK`. Record the txids in the commit message.
- [ ] **Step 4: Docs.** In the README, describe the product as the budget layer and cover custom payees, `satchel_send`,
  selling with `satchel-pay-server`, the example seller, and the roadmap (x402-bch upstream proposal with the spike's
  two rules, USD budgets, the EVM bridge). Update `CLAUDE.md` layout/commands and `.env.example` (`SATCHEL_SELLERS`,
  `TOOL_LLM`, `TOOL_MODEL`).
- [ ] **Step 5: Full check.** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, the typecheck and
  build of `mcp/` and `provider-kit/`, and `npm pack --dry-run` of both packages. All must be clean.
- [ ] **Step 6: Commit** `test: mainnet e2e for sends, seller payments and v2 recovery; docs`.
- [ ] **Step 7: Release (ask the user for each item):**
  1. merge `feat/real-mvp` into `main` and push;
  2. set production env `SATCHEL_SELLERS` (the deployed seller) and optionally `TOOL_LLM=on`, then redeploy;
  3. smoke test production: `/api/config` shows 5 tools and 1 seller; `bch-tx` gives a 402;
  4. `npm publish --access public` for `satchel-pay-server@0.1.0`, then `satchel-pay-mcp@0.1.0`;
  5. if published, switch `examples/provider` to `"satchel-pay-server": "0.1.0"` and redeploy;
  6. verify `npx -y satchel-pay-mcp@0.1.0` starts.
