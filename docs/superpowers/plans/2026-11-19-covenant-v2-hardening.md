# Covenant v2 (sliding-window cap) and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cap hold over any `periodBlocks` window (CSV cooldown instead of a locktime-based roll), and harden the live demo (Electrum failover, `/api/chain` limits, a shared paid-result cache) before judging.

**Architecture:** `spend` gets a `bool newPeriod` argument. Starting a new period requires `this.age >= periodBlocks`, so consensus (BIP68) enforces the cooldown. The builder sets the input sequence and learns the vault coin's confirmation height from Electrum. The infrastructure fixes are independent modules: a failover `NetworkProvider`, a Runtime Cache helper (rate limit and paid results), and an async-capable cache in `satchel-pay-server`.

**Tech Stack:** CashScript 0.14 / cashc, libauth 3.1.0-next.8, Next.js 16, Vercel Runtime Cache (`@vercel/functions`), `@electrum-cash/network`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-covenant-v2-hardening-design.md`

## Global Constraints

- Cut-off: v2 mainnet e2e green by **2026-11-20 23:59 UTC+7**. If it is missed, reset main to `c7f0d5b` + the wording-only fix (Task 7 fallback).
- Commitment format unchanged: 12 bytes, `periodStart` (4B LE) ‖ `spent` (8B LE).
- `periodBlocks` must be in `1..65535` (BIP68 block-based relative lock). The UI offers 6, 144 and 1008.
- `withdraw(sig ownerSig)` stays unconditional.
- Sats are `bigint` everywhere. libauth is ESM only.
- After any edit to `contracts/Satchel.cash`, run `npm run compile:contract`, then `npm test`.
- `satchel-pay-server` 0.2.0 must still accept a 0.1.x-style synchronous `ResultCache`.
- Runtime Cache failures never break a request: the rate limit fails open, and the paid cache falls back to memory.
- A broadcast *rejected* by a node is never retried on another Electrum host.
- Never poll the production site in a loop. Check deploys with `vercel ls satchel --prod` and `vercel inspect`.
- Copy wording (verbatim): **"at most X sats in any N-block window, fees included; a new period starts only N blocks after the last payment"**.

## Review Focus

1. Vault coin still unconfirmed right after a payment (height 0): no new period, and the status shows `resetsAtHeight: null` ("resets N blocks after this payment confirms"). It must not error. (Tasks 1 and 2)
2. Electrum's listunspent does not list the vault outpoint yet (index lag): treat it as unconfirmed (0). That is the safe default, because it never sets an unsatisfiable sequence. (Task 2)
3. A broadcast rejection (`mandatory-script-verify-flag-failed`, `non-BIP68-final`) passes through the failover provider unchanged, so the attack demo still shows the covenant verdict. (Task 3)
4. No Runtime Cache (local dev, tests, cache errors): the rate limiter allows the request, and the paid results use the in-memory cache. (Tasks 4 and 5)
5. Wallet recovery scans 20 wallet addresses (2 paths × `SCAN_DEPTH` 10) and up to 60 txids, so the new `/api/chain` caps must still admit those exact sizes. (Task 4)

---

### Task 0: Withdraw every live v1 vault (before any contract change)

**Files:** none (operational). Uses the current code on `main` (`c7f0d5b`).

- [ ] **Step 1:** For each file in `.e2e-vaults/` run `NEXT_PUBLIC_BCH_NETWORK=mainnet E2E_ALLOW_MAINNET=1 npx tsx scripts/e2e.mts withdraw .e2e-vaults/<file>.json`. Expected: a withdraw txid, or a message that the vault was already withdrawn. For the two `mainnet-mcp-*` files (external agent), the owner path is the same.
- [ ] **Step 2:** Ask the user to withdraw their Cashonize vaults in the current production UI and to confirm when done. Do not start Task 7's deploy until they confirm.
- [ ] **Step 3:** Record the withdraw txids in the task ledger. No commit.

### Task 1: Covenant v2 and vault math

**Files:**
- Modify: `contracts/Satchel.cash`, then regenerate `src/lib/contract/Satchel.artifact.json`
- Modify: `src/lib/vault.ts`
- Test: `src/lib/vault.test.ts`

**Interfaces:**
- Produces (in `src/lib/vault.ts`):
  - `export const MAX_PERIOD_BLOCKS = 65535n`. `getVaultContract` throws `"periodBlocks must be between 1 and 65535"` outside that range.
  - `export function canStartNewPeriod(coinHeight: number, tipHeight: number, periodBlocks: bigint): boolean`: true iff `coinHeight > 0 && tipHeight + 1 - coinHeight >= Number(periodBlocks)`.
  - `computeNextState(state: VaultState, outflow: bigint, newPeriod: boolean, locktime: number, params): { next: VaultState; withinCap: boolean }`. When `newPeriod` is true: `{ periodStart: locktime, spent: outflow }`.
  - `remainingBudget(state: VaultState, coinHeight: number, tipHeight: number, params): { remaining: bigint; resetsAtHeight: number | null }`. If `canStartNewPeriod`, then `remaining = cap`. `resetsAtHeight = coinHeight + periodBlocks - 1` when `coinHeight > 0`, and `null` when `coinHeight === 0`.
  - `AgentSpendRequest` gains `coinHeight: number` (required), `overrideSequence?: number` (testing/demo only) and `overrideNewPeriod?: boolean` (testing/demo only). `buildAgentSpend` returns `{ builder, outflow, newState, fee, newPeriod }`. `newPeriod = overrideNewPeriod ?? canStartNewPeriod(coinHeight, tipHeight, periodBlocks)`. When `newPeriod` is true, the vault input is added with `{ sequence: overrideSequence ?? Number(periodBlocks) }`. The unlocker passes `newPeriod` as the 4th `spend` argument. Locktime stays `tipHeight`.

- [ ] **Step 1: Write the failing tests** in `src/lib/vault.test.ts`. Update `spend()` to pass `coinHeight: START`, and replace the two period tests ("rejects an agent that fakes a new period early" and "resets the budget once the period has passed"):
  - `it("starts a new period only with a cooldown sequence: newPeriod with sequence 0 fails CSV")`: `spend({ overrideNewPeriod: true, overrideSequence: 0 }).builder.send()` rejects with `/this\.age >= periodBlocks/`.
  - `it("a new-period spend always carries sequence >= periodBlocks (BIP68 makes it unminable before the cooldown)")`: build with `coinHeight: START, tipHeight: START + 144` and assert `builder.build()` decodes (libauth `decodeTransaction`) to `inputs[0].sequenceNumber === 144` and `version === 2`.
  - `it("regression 2026-11-19: an old locktime no longer rolls a period")`: tipHeight `START + 5*144`, `overrideNewPeriod: false`, chained spends of 2,000 sats each until one is refused. The total accepted outflow is ≤ the 10,000 cap, and the first spend beyond it rejects with `/newSpent <= capPerPeriod/`. This is the audit's burst, which now stops at one cap.
  - `it("resets the budget after the cooldown")`: `coinHeight: START, tipHeight: START + 143`. Expect `newPeriod` true, `send()` succeeds, and the new state is `{ periodStart: START + 143, spent: outflow }`.
  - `it("lies about the counter are still rejected")`: keep the existing `overrideNextState` test, now with `newPeriod: false`.
  - `remainingBudget` cases: unconfirmed `(coinHeight 0)` gives `resetsAtHeight null` and `remaining = cap - spent`. `coinHeight START, tip START+142` gives no reset and `resetsAtHeight START+143`. `tip START+143` gives `remaining = cap`.
  - `getVaultContract` with `periodBlocks: 0n` and with `65536n` throws.
- [ ] **Step 2:** Run `npx vitest run src/lib/vault.test.ts`. Expected: the new tests FAIL (unknown fields, or the old roll still allowed).
- [ ] **Step 3: Implement the covenant.** In `spend(sig agentSig, bytes allowlist, int recipientIndex, bool newPeriod)`, replace the `if (tx.locktime >= nextPeriod) {…}` block with:
  ```cashscript
  int newStart = periodStart;
  int newSpent = spent + outflow;
  if (newPeriod) {
      // Cooldown: the vault coin must be periodBlocks old (BIP68), so two periods' spends are >= periodBlocks apart.
      require(this.age >= periodBlocks);
      newStart = tx.locktime;
      newSpent = outflow;
  }
  require(newSpent <= capPerPeriod);
  ```
  Update the header comment to the v2 rule. Run `npm run compile:contract`.
- [ ] **Step 4:** Implement the `vault.ts` interfaces above. Update the callers in `src/lib/spend.ts`, `src/lib/server/agent-wallet.ts` and `mcp/src/tools.ts` just enough to typecheck: pass `coinHeight: 0` for now, because Task 2 wires the real value.
- [ ] **Step 5:** Run `npx vitest run src/lib/vault.test.ts`, then `npm test` and `npm run typecheck`. Expected: all PASS.
- [ ] **Step 6:** Commit `feat(covenant): v2 sliding-window cap — new period only after a CSV cooldown`.

### Task 2: Coin height, the spender and the status surfaces

**Files:**
- Create: `src/lib/coin-height.ts`, test `src/lib/coin-height.test.ts`
- Modify: `src/lib/spend.ts`, `src/lib/spend.test.ts`, `src/lib/server/agent-wallet.ts`, `mcp/src/tools.ts`, `mcp/src/index.ts`, `mcp/src/tools.test.ts`, `src/components/Dashboard.tsx`

**Interfaces:**
- Consumes: Task 1's `canStartNewPeriod`, `remainingBudget`, and `buildAgentSpend({ coinHeight })`.
- Produces:
  - `export type ElectrumLike = { performRequest(method: string, ...params: unknown[]): Promise<unknown> }`.
  - `export async function coinHeight(electrum: ElectrumLike, address: string, utxo: { txid: string; vout: number }): Promise<number>`. It calls `blockchain.scripthash.listunspent` on the address's Electrum scripthash and returns the matching entry's `height` when it is > 0, otherwise 0. It returns 0 on a miss or on any error.
  - `SpendTarget` gains `coinHeight: (utxo: SpendableUtxo) => Promise<number>`. The spender's own cached successor UTXO always counts as height 0, without a lookup.
  - `VaultStatus.resetsAtHeight: number | null` and `VaultStatus.resetRule: "sliding"`. The MCP `satchel_status` returns the same two fields.

- [ ] **Step 1: Write the failing tests.**
  - `coin-height.test.ts`: a fake `performRequest` returns `[{ tx_hash: T, tx_pos: 0, height: 900 }]`, giving 900. Height 0, a missing outpoint, and a throwing `performRequest` all give 0 (Review Focus 1 and 2). The scripthash argument equals the reversed sha256 of the locking bytecode (reuse the vector from the `api/chain` `electrumScriptHash` logic).
  - `spend.test.ts`: `it("starts a new period when the vault coin has cooled down")` uses `coinHeight` → `tip - 143` with `periodBlocks` 144, and expects the broadcast tx input sequence to be 144. `it("does not start a new period while the coin is unconfirmed")` uses `coinHeight` → 0 and expects sequence `0xfffffffe` and spent to accumulate. `it("does not look up the height of its own just-broadcast successor")`: the `coinHeight` spy is not called for the cached successor.
  - `mcp/src/tools.test.ts`: the status of an unconfirmed vault coin has `resetsAtHeight: null` and `resetRule: "sliding"`.
- [ ] **Step 2:** Run `npx vitest run src/lib/coin-height.test.ts src/lib/spend.test.ts mcp/src/tools.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `coin-height.ts`, thread `coinHeight` through `VaultSpender.payOnce` and the outcome's `remaining`, and implement `target()` in `agent-wallet.ts` and `HandlerDeps` in the MCP with `(u) => coinHeight(provider, contract.tokenAddress, u)`. In `vaultStatus`, fetch the coin height alongside the tip.
- [ ] **Step 4:** Dashboard: when `resetsAtHeight` is null, show "Resets {N} blocks after the last payment confirms". Otherwise show the existing countdown with the label "Resets {N} blocks after the last payment". `blocksLeft = resetsAtHeight === null ? null : max(0, resetsAtHeight - tipHeight)`.
- [ ] **Step 5:** Run `npm test`, `npm run typecheck`, `npm run lint` and `cd mcp && npx tsc --noEmit -p tsconfig.json`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(spend): learn the vault coin height; roll after the cooldown; sliding reset in status/UI/MCP`.

### Task 3: Electrum failover

**Files:**
- Create: `provider-kit/src/hosts.ts`, `src/lib/electrum-failover.ts`, test `src/lib/electrum-failover.test.ts`
- Modify: `provider-kit/src/electrum.ts`, `src/lib/server/electrum.ts`, `src/lib/chain-deps.ts`, `mcp/src/index.ts`, `src/lib/server/chain-tools.ts` (type only)

**Interfaces:**
- Produces:
  - `provider-kit/src/hosts.ts`: `export const ELECTRUM_HOSTS: Record<BchNetwork, readonly string[]>`. CashScript's default goes first (`bch.imaginary.cash` / `chipnet.bch.ninja`), then the verified extras (Step 1).
  - `export function isConnectionError(e: unknown): boolean`: true for timeouts, connect/socket/closed/ECONN*/ENOTFOUND messages; false for node rejections (anything matching `/mandatory-script-verify|non-BIP68-final|missing-?inputs|txn-mempool-conflict|dust|bad-txns/i`).
  - `export class FailoverElectrumProvider implements NetworkProvider` with `constructor(network: Network, hosts?: readonly string[], make?: (host: string) => ElectrumNetworkProvider)`, the `NetworkProvider` methods, and `performRequest(method, ...params)`. It stays on the current host. On `isConnectionError` it advances to the next host and retries that call once.
  - `getProvider()` returns `FailoverElectrumProvider`. MCP `main()` uses it too. `electrumTransactionFetcher(network, host?)` with no `host` tries `ELECTRUM_HOSTS[network]` in order on connection errors (same rule).

- [ ] **Step 1: Verify hosts.** From this machine, for 3–4 candidate mainnet Fulcrum hosts (e.g. `electroncash.de`, `bch.loping.net`, `electrum.imaginary.cash`), run a short tsx snippet that creates an `ElectrumNetworkProvider("mainnet", { hostname })` and calls `getBlockHeight()`. Keep the ones that answer with the same tip as `bch.imaginary.cash`, up to 3 including the default. Do the same for chipnet if a second host exists; otherwise keep the default alone.
- [ ] **Step 2: Write the failing tests** (`electrum-failover.test.ts`, with fake providers via `make`):
  - `it("moves to the next host on a connection error and retries once")`
  - `it("stays on the host that worked for later calls")`
  - `it("passes a broadcast rejection through without trying another host")`, using `"mandatory-script-verify-flag-failed (Script failed an OP_CHECKSEQUENCEVERIFY operation)"` (Review Focus 3)
  - `it("throws the last error when every host fails")`
  - kit: `electrumTransactionFetcher` with an injected client factory falls over to host 2 on a connect timeout (add an optional `connect` factory parameter for tests).
- [ ] **Step 3:** Run them and expect FAIL. Implement. Run `npm test` and expect PASS.
- [ ] **Step 4:** Run `cd provider-kit && npm run typecheck && npm run build`, then `cd mcp && npm run typecheck && npm run build`. Expected: clean.
- [ ] **Step 5:** Commit `feat(electrum): failover across verified Fulcrum hosts (server, MCP, kit)`.

### Task 4: `/api/chain` limits and rate limit

**Files:**
- Create: `src/lib/server/runtime-cache.ts`, `src/lib/server/rate-limit.ts`, test `src/lib/server/rate-limit.test.ts`
- Modify: `src/app/api/chain/route.ts`, `package.json` (`@vercel/functions`)

**Interfaces:**
- Produces:
  - `runtime-cache.ts`: `export function sharedCache(): { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown, ttlSeconds: number): Promise<void> } | null`. It wraps `getCache()` from `@vercel/functions` and returns `null` when that is unavailable or throws. Before writing it, check the real API in `node_modules/@vercel/functions` (load the `vercel:runtime-cache` skill).
  - `rate-limit.ts`: `export async function allowRequest(key: string, limit = 60, windowSeconds = 60, cache = sharedCache()): Promise<boolean>`. It is a fixed-window counter at key `rl:${key}:${floor(now/window)}`, returns `true` when `cache` is null or errors, and returns false once the count exceeds the limit.
  - Route caps: `utxos` ≤ 20 addresses, `history` ≤ 20 addresses, `txs` ≤ 60 txids (Review Focus 5). Over a cap the route answers 400 with `"too many addresses (max 20)"` or `"too many txids (max 60)"` instead of silently truncating. The client never sends more than this.

- [ ] **Step 1: Firewall first.** Try a Vercel Firewall rate-limit rule for path prefix `/api/chain` (60 requests per 60 s per IP, action 429) with the `vercel firewall` CLI (load the `vercel:vercel-firewall` skill). If the plan does not allow rate-limit rules, note that in the ledger and do Steps 2–4. If the rule is active, skip `allowRequest` in the route and still do the caps (Steps 2 and 4 without the limiter test).
- [ ] **Step 2: Write the failing tests:** `allowRequest` allows 60 and refuses the 61st in a window (fake cache). It returns true when the cache is null or `get` throws (Review Focus 4). Route: 20 addresses → 200 (stub provider), 21 → 400 `"too many addresses (max 20)"`, 60 txids → 200, 61 → 400.
- [ ] **Step 3:** Run and expect FAIL. Implement. In the route, the key is the first `x-forwarded-for` hop. A refusal answers 429 `{ error: "rate limited, try again in a minute" }`.
- [ ] **Step 4:** Run `npm test`, `npm run typecheck` and `npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(chain): cap /api/chain request sizes and rate-limit per IP`.

### Task 5: Shared paid-result cache (`satchel-pay-server` 0.2.0)

**Files:**
- Modify: `provider-kit/src/paywall.ts`, `provider-kit/src/paywall.test.ts`, `provider-kit/src/index.ts`, `provider-kit/package.json` (version `0.2.0`), `provider-kit/README.md`
- Modify: `src/lib/server/result-cache.ts`, `src/app/api/tools/[tool]/route.ts` (also fix finding 5: `Object.hasOwn(PAID_TOOLS, tool)`)

**Interfaces:**
- Produces:
  - Kit: `export interface PaidResultStore<T> { get(key: string): T | undefined | Promise<T | undefined>; set(key: string, value: T, expires: number): void | Promise<void> }`. `PaywallConfig.cache?: PaidResultStore<unknown>`. `handle` awaits both calls. A thrown `get` counts as a miss, and a thrown `set` is ignored.
  - App: `export const paidResults: PaidResultStore<unknown>`, a two-level store. It reads Runtime Cache (`sharedCache()`, key `paid:${nonce}`, TTL `ceil((expires - now)/1000)`) and falls back to the in-memory `ResultCache`, and it writes both.

- [ ] **Step 1: Write the failing tests** in `paywall.test.ts`: `it("uses an async cache: a replay on another instance returns the stored result without running the handler")` (two `createPaywall` instances share one async Map-backed store, and the handler spy is called once). `it("still accepts the 0.1 ResultCache")`. `it("a cache whose get throws is a miss, not a 500")`. In the app: `it("/api/tools/toString is 404")`.
- [ ] **Step 2:** Run `npx vitest run provider-kit/src/paywall.test.ts src/lib/server` and expect FAIL. Implement. Run again and expect PASS.
- [ ] **Step 3:** Run `cd provider-kit && npm run typecheck && npm run build && npm pack --dry-run`. Expected: version 0.2.0 and the same file list as 0.1.0.
- [ ] **Step 4:** Commit `feat(kit): async paid-result store (0.2.0); Satchel shares paid results via Runtime Cache`.

### Task 6: Copy and docs for v2

**Files:** `README.md`, `../dorahacks-description.md`, `src/components/Landing.tsx`, `mcp/README.md`, `provider-kit/README.md`, `CLAUDE.md` (the "Covenant invariants" and `remainingBudget` notes), `src/components/CreateVault.tsx` (helper text under the period select, plus finding 6: a non-integer deposit or cap shows the form error `"Use whole sats (no decimals)."` instead of throwing)

- [ ] **Step 1:** Replace every "at most X sats every N blocks / per period" and "worst it can do is spend the remaining budget" with the Global Constraints wording. Find them with `grep -rn "every \*N\* blocks\|per period\|remaining budget\|tx.locktime >= periodStart" README.md ../dorahacks-description.md src mcp/README.md provider-kit/README.md CLAUDE.md`. Expected after the edits: no stale hits.
- [ ] **Step 2:** In `CLAUDE.md` invariants, replace the CLTV bullet with: "A new period only via `spend(…, newPeriod=true)`, which requires `this.age >= periodBlocks` (BIP68). Agent txs set `locktime = tip` and, on a new period, input `sequence = periodBlocks`."
- [ ] **Step 3:** Add a `CreateVault` test or a manual check: entering `1.5` shows the error. Then `npm run lint` and `npm test`.
- [ ] **Step 4:** Extract the slide text from `../Satchel-BLAZE-2026.pptx` (the pptx skill's text extraction) and list every slide that states the old rule. Report them to the user for a manual edit. Claude does not edit the deck.
- [ ] **Step 5:** Commit `docs: v2 sliding-window wording everywhere; whole-sats form error`.

### Task 7: Mainnet proof, release and the cut-off

**Files:**
- Create: `scripts/v2-cooldown-e2e.mts`
- Modify: `README.md` (proof table), `mcp/package.json` (`0.2.0`), `mcp/src/server.ts` (`VERSION`), README install lines `@0.1.0` → `@0.2.0`

- [ ] **Step 1: Write `scripts/v2-cooldown-e2e.mts`** (mainnet only with `E2E_ALLOW_MAINNET=1`; the owner is `MAINNET_OWNER_SEED` from `.env.local`; a fresh local agent key; the descriptor saved to `.e2e-vaults/` before broadcasting). Flow: genesis with `periodBlocks: 1n`, cap 3,000, deposit 8,000, allowlist = [Satchel `bch-tx` payee] → pay 1,200 (no new period, the coin is unconfirmed) → try a new period now with `overrideNewPeriod: true, overrideSequence: 0`, which must be rejected with a node error matching `/mandatory-script-verify-flag-failed/` → try `overrideNewPeriod: true` with sequence 1 on the unconfirmed coin, which must be rejected with `/non-BIP68-final/` → wait (bounded, ≤ 40 min, polling `getBlockHeight` every 30 s against Electrum, not the site) until the coin confirms → pay 1,200 with `newPeriod` true, which must be accepted with the new state `spent = outflow` → owner withdraw. Print `E2E OK` and each explorer link.
- [ ] **Step 2: Deploy** after Task 0's user confirmation: `git checkout main && git merge --ff-only <branch> && git push origin main`, then `vercel ls satchel --prod` / `vercel inspect` until Ready, and confirm the commit SHA via `vercel api /v13/deployments/<url>`.
- [ ] **Step 3:** Run `cd mcp && npm run build && E2E_ALLOW_MAINNET=1 E2E_SELLER_ORIGIN=https://satchel-example-seller.vercel.app npx tsx scripts/mainnet-e2e.mts`, then `NEXT_PUBLIC_BCH_NETWORK=mainnet E2E_ALLOW_MAINNET=1 npx tsx scripts/v2-cooldown-e2e.mts`. Expected: both print `E2E OK`. Replace the README proof rows with the new txids and add the two rejection rows (CSV in script, BIP68 at the node).
- [ ] **Step 4:** Publish. Ask the user first, then `cd provider-kit && npm publish`, and `cd mcp && npm publish` (0.2.0). Wait for `npm view satchel-pay-mcp version` to show `0.2.0` (bounded, about 2 min).
- [ ] **Step 5:** The user runs one judge flow on production with Cashonize: create, agent, both attacks, withdraw. Record the txids.
- [ ] **Step 6:** Commit and push `docs: v2 mainnet proof; release 0.2.0`.
- [ ] **Fallback (only if the cut-off is missed):** create branch `v2-wip` at the current head, then reset `main` to `c7f0d5b`, cherry-pick only the wording commit, changed to v1-honest text ("at most X per period; a compromised agent key can carry over unused periods; v2 fix on the roadmap"), and push. This needs the user's explicit go-ahead because it rewrites main.
