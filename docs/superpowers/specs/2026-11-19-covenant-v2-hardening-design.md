# Covenant v2 (sliding-window cap) and pre-judging hardening

Date: 2026-11-19. Status: approved approach, design for review.
Source: MVP audit of 2026-11-19 (finding 1, critical; findings 2–4, medium).

## Why

Satchel's core promise is "the agent can spend at most X sats every N blocks, enforced by consensus". The audit
showed that this is false for v1. On a period roll the covenant trusts `tx.locktime`, and CLTV only proves that the
chain is *at least* that high. So an agent key can pick an **old** locktime and roll one period per transaction.
After k idle periods it can spend k × cap at once. We confirmed this on the BCH VM: 5 chained spends at one tip
height spent over 45,000 sats against a 10,000 cap. Exploiting it needs the agent key (the hosted seed or an MCP
user's key file); prompt injection alone cannot do it. But the README, the DoraHacks text and the landing page all
claim the opposite, and the judges (23–27 Nov) know covenants well.

The medium findings are about keeping the live demo up during judging week. Today there is a single Electrum
server, an open Electrum proxy, and paid results that are cached per instance only.

## Goals

- **G1.** A provable cap: across **any** window of `periodBlocks` consecutive blocks, the agent's outflow
  (payments + fees) is at most `capPerPeriod`. A regression test asserts the exact failing `require`.
- **G2.** The demo survives the failure of one Electrum server.
- **G3.** `/api/chain` cannot be used as a cheap amplifier against our Electrum servers.
- **G4.** A paid result runs its handler at most once per payment across instances (best effort), so replays never
  re-spend LLM quota.
- **G5.** The README, DoraHacks text, landing page and MCP docs state exactly what v2 guarantees.

## Non-goals

- Keeping v1 vaults usable from the new code. All live v1 vaults are withdrawn before the switch.
- A fixed reset schedule ("resets at block #X"). It cannot be enforced, as shown below.
- Running our own Fulcrum server, adding a database, or adding auth to `/api/chain`.

## Anti-goals (a failure even if it works)

- Anything that lets a vault be drained or frozen. The owner's `withdraw` must stay unconditional.
- Shipping v2 without a green mainnet e2e. Judges will make real transactions.
- Breaking existing `satchel-pay-server` 0.1.x users. The kit change must be backward compatible.

## Constraints

- Deadline: submission 2026-11-22 14:00 UTC. **Cut-off for this work: 2026-11-20 23:59 (UTC+7).** If the v2 mainnet
  e2e is not green by then, main goes back to the current production code (c7f0d5b), and only the wording is
  fixed: v1's limit is documented as a known limitation with the v2 fix on the roadmap.
- CashScript 0.14 and libauth `3.1.0-next.8` (pinned). The transaction version is already 2, as BIP68 requires.
- BIP68 relative locks in blocks hold at most 65,535 blocks. The UI periods are 6, 144 and 1,008.
- The server stays stateless (no DB). Vercel Runtime Cache counts as an ephemeral cache, not a DB.

## Approaches considered (finding 1)

1. **Sliding window with a CSV cooldown (chosen).** A new period may start only when the vault UTXO is at least
   `periodBlocks` old (`this.age`). The spends of two periods are therefore always separated by `periodBlocks`
   blocks, so no window of that length holds both. Trade-off: the reset drifts. It happens `periodBlocks` after the
   last payment confirms, not at a fixed height. When the agent has used up its cap it cannot pay anyway, so in
   practice it just means "wait N blocks".
2. **Fixed schedule with a mitigation** (for example one roll per block via `this.age >= 1`). Rejected: a burst of
   k × cap over k blocks is still possible, so the promise stays false.
3. **Fixed schedule kept, wording changed only.** Rejected as the main plan, because it leaves the core promise
   weak. It is kept as the fallback if the cut-off is missed.

The user chose approach 1.

## Design

### Covenant (`contracts/Satchel.cash`)

- `spend(sig agentSig, bytes allowlist, int recipientIndex, bool newPeriod)`:
  - When `newPeriod` is true: `require(this.age >= periodBlocks)`, then `newSpent = outflow` and `newStart = tx.locktime`.
  - When it is false: `newSpent = spent + outflow` and `newStart = periodStart`.
  - The `tx.locktime >= nextPeriod` / `tx.time` branch is **removed**. The agent cannot start a period early: a too-low
    sequence fails CSV in script, and a too-young coin is non-final.
- The commitment format stays the same (12 bytes, `periodStart ‖ spent`), so the decoders and recovery code are
  unchanged. `periodStart` becomes informational ("the period started at about this height"). It is always at most
  the height it was mined at, because a transaction cannot be mined before its locktime.
- Everything else is unchanged: single input, category and mutable capability, allowlist before budget, fee counted
  in outflow, output 2 OP_RETURN, unconditional `withdraw`.
- Constraint checked off-chain: `periodBlocks` is between 1 and 65,535. The UI and the builder reject anything else.
  The covenant does not need this check, because a larger value just makes CSV unsatisfiable, which is safe.

### Transaction builder and budget math (`src/lib/vault.ts`, `src/lib/spend.ts`)

- `buildAgentSpend` gains `newPeriod: boolean`. When it is true, the vault input gets `sequence = periodBlocks`
  (BIP68 blocks, disable flag clear).
- `computeNextState` and `remainingBudget` take the vault UTXO's **confirmation height** instead of comparing heights
  to `periodStart`. A new period is allowed when the coin is confirmed and `tip + 1 − coinHeight >= periodBlocks`,
  because the next block is where the transaction lands.
- `remainingBudget` returns `resetsAtHeight = coinHeight + periodBlocks − 1` (the tip height from which a reset is
  possible) when `spent > 0` and the coin is confirmed, and `null` while the coin is unconfirmed. The UI then shows
  "resets N blocks after this payment confirms".
- `VaultSpender` rolls automatically whenever a new period is allowed. Rolling never hurts: it resets `spent` to
  this payment's outflow.
- The coin height comes from Electrum `blockchain.scripthash.listunspent`. CashScript's `getUtxos` drops it, so
  `SpendTarget` gains `coinHeight(utxo) => Promise<number>` (0 = unconfirmed), and the server and the MCP server both
  implement it on their Electrum provider. The spender's cached successor UTXO is unconfirmed by definition (height 0).

### Surfaces

- Dashboard: the budget panel says "Resets N blocks after the last payment" and shows the countdown from
  `resetsAtHeight` when it is known.
- `/api/vault/status` and the MCP `satchel_status`: return `resetsAtHeight` as a number or null, plus
  `resetRule: "sliding"`.
- Attack demo: unchanged. Optionally add a third button, *Start a new period early*, only if time allows after
  everything else is green. It is not required.
- Copy (G5): replace "at most X sats every N blocks" and "worst it can do is spend the remaining budget" with the v2
  wording: "at most X sats in any N-block window, fees included; a new period starts only N blocks after the last
  payment". Applies to the README, `dorahacks-description.md`, the Landing feature card, and the MCP and kit READMEs.
  Check the slides deck for the old wording and list any slide that needs a manual edit.

### Electrum failover (finding 2)

- A `FailoverElectrumProvider` that implements CashScript's `NetworkProvider` plus `performRequest`. It is built
  from an ordered host list per network (CashScript's default first, then two or more public Fulcrum servers; the
  builder verifies each one from Vercel).
- On a **connection-level** failure (timeout, socket closed, cannot connect) it moves to the next host and retries
  the call once. A node *rejection* of a broadcast is a result, not a failure, and is never retried elsewhere. Note
  that re-broadcasting the same transaction is harmless anyway (same txid).
- Used by `src/lib/server/electrum.ts`, `mcp/src/index.ts` and `provider-kit/src/electrum.ts` (the kit already has
  its own host table; it gets the same list and the same failover rule).

### `/api/chain` limits (finding 3)

- Per-request caps go down to what the browser actually needs: `utxos` ≤ 10 addresses, `history` ≤ 10 addresses,
  `txs` ≤ 25 txids. The builder confirms these against `src/lib/client/*` (the recovery scan and the wallet UTXO scan).
- A per-IP rate limit: first try a Vercel Firewall rate-limit rule on `/api/chain` (config only, no code). If the
  Hobby plan cannot do it, use a fixed-window counter in Vercel Runtime Cache keyed by IP and minute
  (about 60 requests per minute per IP), answering 429. A cache error means "allow" (fail open, demo first).

### Shared paid-result cache (finding 4)

- `satchel-pay-server` **0.2.0**: `PaywallConfig.cache` accepts any object with
  `get(key) => T | undefined | Promise<T | undefined>` and `set(key, value, expires) => void | Promise<void>`.
  `ResultCache` still satisfies it, so 0.1.x code keeps working.
- Satchel's `/api/tools/*` passes an adapter over Vercel Runtime Cache (`@vercel/functions`, TTL = time to the
  challenge's expiry, key prefix `paid:`). If the cache fails, it falls back to the in-memory `ResultCache`.
- Known race, accepted: two replays that arrive at the same moment on two instances can both miss and both run.
  That is rare and bounded by the challenge TTL.

## Release and rollout

1. Contract v2, tests (including the catch-up probe turned into a regression test asserting
   `require(this.age >= periodBlocks)`, plus a premature-roll test), `npm run compile:contract`.
2. Builder, spender, coin height, surfaces, copy.
3. Electrum failover, `/api/chain` limits, kit 0.2.0 cache.
4. Before deploying: withdraw every live v1 vault. That means the 6 `.e2e-vaults/` mainnet vaults (Claude, with the
   local seeds) and the user's Cashonize vaults (the user, through the current production UI).
5. Deploy to production, then run the mainnet e2e on v2. The run must include one real period roll after the
   cooldown, using `periodBlocks = 1` in the script so it needs only one confirmation, and one premature roll that
   is rejected. Record the txids in the README proof table, replacing the v1 rows.
6. Publish `satchel-pay-server@0.2.0` and `satchel-pay-mcp@0.2.0`, which bundles the v2 artifact. Bump the README
   install lines to the new versions.
7. Check the cut-off (above). If it is missed, roll back and apply only the wording fix.

## Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, the MCP and kit typecheck and build, and
`npm pack --dry-run` for both packages. The mainnet e2e prints `E2E OK` with explorer links. One manual judge flow
on production with Cashonize: create, agent run, both attacks, withdraw.

## Left to the builder

- The exact Fulcrum host list (verified reachable), the retry and timeout values, and how the cooldown copy is
  worded in the UI.
- Whether the Firewall rule is possible on this plan. If not, use the Runtime Cache counter.
- Whether the optional *Start a new period early* attack button fits in time.
