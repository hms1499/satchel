# Satchel — Pre-deploy hardening

Status: written by Claude at the user's request (pipeline: Discovery → Validation → Spec → Build → Review), 2026-11-17.
Goal: the public Vercel demo must not break or misbehave in ways the localhost demo hides.

## Validated risks (evidence)

| # | Risk | Evidence |
|---|---|---|
| R1 | A paid `X-Payment` header is not bound to the request. On another instance or after a cold start (in-memory `usedNonces` is empty) the same header buys any call to that tool until it expires. | `validation.test.ts`: header verified again after `vi.resetModules()` |
| R2 | If the tool fails after the payment was verified, the agent's retry is refused (`payment already used`): paid, no result. | `validation.test.ts` |
| R3 | A fresh instance whose Electrum view still shows the spent vault UTXO broadcasts a conflicting tx, and the user is told "the vault covenant does not allow this payment". | `validation.test.ts` (node behavior modeled: `txn-mempool-conflict`) |
| R4 | On Vercel, `VERCEL_OIDC_TOKEN` is always present, so `hasLlm()` silently switches the agent to the never-tested LLM path; with no gateway credits every run fails. | `llm.ts` + Vercel AI Gateway auth docs |
| R5 | A paid call costs ~690 sats in miner fees (tx 689 B: redeem script 310 B, allowlist 96 B, outputs 156 B), ~69% on a 1,000-sat call. Users are not told. | measured with a built spend |
| R6 | No structured logs; no success metric. | code search |

## Decisions

### D1. Request-bound, idempotent payments (fixes R1, R2) — stateless
- The 402 challenge gets a signed `request` field: `sha256` of the canonical request (`tool` + params sorted by key).
- `verifyPayment(header, resource, request)` rejects a header whose challenge was issued for a different request.
- The in-memory "already used" rejection is removed. Within its 10-minute expiry, a paid header may be replayed **only for the
  identical request**: an idempotent retry, not a free call. No database needed, correct on any number of instances.
- `paidCall` retries with the same header on network errors and 5xx responses (3 attempts, backoff), so a failed tool
  after payment is retried instead of lost.

### D2. Stale-UTXO handling (fixes R3)
- On a broadcast failure, the failure is attributed to the covenant **only** if the local VM evaluation fails (a failing
  `require`) or the node reports a script failure. Otherwise it is a network/state error.
- For conflict/missing-input errors, `payFromVault` waits (0.8 s, 1.6 s, 2.4 s), re-reads the vault UTXO skipping the
  outpoint that just failed, and retries. If Electrum still lags, it returns
  "The vault is busy: the previous payment is still propagating. Try again in a few seconds." — never a covenant claim.

### D3. Explicit agent mode (fixes R4)
- `AGENT_MODE=llm` is required to use the LLM (plus `AI_GATEWAY_API_KEY` or Vercel OIDC). Default: `scripted`.
- In `llm` mode, if the gateway call fails, the run emits a notice and falls back to the scripted plan.
- The UI already labels demo mode ("fixed research plan").

### D4. Fee transparency (R5)
- Show the network fee per paid call (~700 sats, counts toward the cap) where the user picks the cap and tools.
- Cutting the fee (batching, payment channels, a smaller covenant) is out of scope for this deadline; it goes in the pitch.

### D5. Structured logs and success metrics (R6)
- One JSON log line per payment (`evt:"payment"`: ok, txid, amount, fee, rule/reason, ms), per paid tool request
  (`evt:"tool"`: status, ms) and per agent run (`evt:"agent_run"`: mode, paid, refused, failed, msToFirstPayment, ms).
- Success metrics, read from Vercel logs:
  - **Payment reliability** — share of payment attempts that are either confirmed or refused *by the covenant*: ≥ 99%.
  - **Fee overhead** — fee / tool price per call (reported, target for the future < 10%).
  - **Time to first paid call** in an agent run: < 15 s.

### D6. Small hardening
- `web-reader` follows redirects manually and re-checks each hop with the public-URL guard (max 3 hops).

## Out of scope
Shared KV store, payment channels / batching, covenant redesign, developer SDK/MCP, enabling the LLM (needs the user's
AI Gateway decision), the deploy itself.

## Deploy notes
- Preview deployments are behind Vercel Deployment Protection by default; the agent calls `/api/tools/*` on its own origin,
  so demo from the production URL (or disable protection for previews).
- Set `AGENT_MASTER_SEED`, `PROVIDER_SEED`, `NEXT_PUBLIC_BCH_NETWORK=mainnet` in the Vercel project.

## Verification
TDD for D1–D3, D6 (replace `validation.test.ts` with regression tests asserting the fixed behavior), full test suite,
typecheck, lint, build, code review, then one mainnet e2e run.
