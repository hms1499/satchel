# Satchel

A Bitcoin Cash covenant wallet for AI agents: *"Give your agent a budget, not your keys."*
The owner funds a vault. An AI agent spends from it autonomously, but BCH consensus enforces a
**per-period cap** and a **recipient allowlist**. The owner can always withdraw.

Built for **BCH BLAZE 2026** (Mainnet Track). **Submission deadline: 2026-11-22 14:00 UTC (21:00 UTC+7).**
Design doc: `docs/superpowers/specs/2026-11-16-satchel-design.md`. Read it before changing behavior.

@AGENTS.md

## Commands

```bash
npm run dev                # Next.js dev server (Turbopack)
npm test                   # vitest — covenant tests run against MockNetworkProvider (full BCH VM)
npm run typecheck          # tsc --noEmit
npm run lint
npm run build
npm run compile:contract   # recompile contracts/Satchel.cash -> src/lib/contract/Satchel.artifact.json
```

After **any** edit to `contracts/Satchel.cash`, run `npm run compile:contract` and then `npm test`. The artifact
is committed and imported by both the client and the server.

## Stack

- Next.js 16 (App Router, React 19, React Compiler, Tailwind 4). This is **not** the Next.js in your training
  data. Check `node_modules/next/dist/docs/` before using a Next API. Request APIs (`params`, `headers()`, …) are async.
- CashScript 0.14 (`cashscript`, `cashc`) and `@bitauth/libauth@3.1.0-next.8`. Pin this exact version: it must match what
  cashscript and wizardconnect depend on. libauth uses top-level await, so import it as ESM only (no `require`).
- WizardConnect 0.2 (`@wizardconnect/react`, `/dapp`, `/core`) for wallet connection and signing via `inputPaths`.
- AI SDK 7 (`ai`) for the agent. Check `node_modules/ai/docs/` instead of relying on older (v4–v6) APIs.
- Electrum through the CashScript `ElectrumNetworkProvider` (`src/lib/server/electrum.ts`).

## Layout

- `contracts/Satchel.cash`: the covenant (functions `spend` and `withdraw`).
- `src/lib/vault.ts`: shared, isomorphic tx builders (`buildGenesis`, `buildAgentSpend`, `buildWithdraw`), plus
  state encoding and the budget math (`computeNextState`, `remainingBudget`).
- `src/lib/vault.test.ts`: covenant tests. Each negative test asserts the **specific** failing `require`.
- `src/lib/server/*`: server only. Agent and provider key derivation (`keys.ts`), Electrum, and the x402 pay-per-call protocol.
- `src/lib/tools.ts`: the paid tool catalog (prices in sats).
- `src/lib/config.ts`: network, explorer links, defaults, and banner links (from env).
- `src/lib/descriptor.ts`: the client-held vault descriptor (params, agentIndex, token). Validated by zod on the server.
- Pre-deploy hardening spec: `docs/superpowers/specs/2026-11-17-predeploy-hardening.md` (request-bound idempotent x402
  payments, stale-UTXO retries, explicit `AGENT_MODE`, JSON logs `evt: payment|tool|agent_run`).
- `src/lib/server/agent-wallet.ts`: `payFromVault` (serialized per vault, never pre-checks the budget, so the covenant
  is the enforcer). `paid-client.ts` handles the 402 → pay → retry flow. `agent-runner.ts` runs the AI SDK
  `ToolLoopAgent`, or a scripted plan when no LLM key is set.
- `src/app/api/*`: `config`, `chain` (Electrum proxy for the browser), `agent/register|run|attack`, `vault/status`, `tools/[tool]`.
- `src/lib/client/*`: browser-only code. `wallet.ts` handles WizardConnect accounts, UTXO scan, genesis and withdraw signing.
  `chain.ts` holds the HTTP `NetworkProvider`.
- `mcp/`: the `satchel-pay-mcp` package (own `package.json`, `npm install` inside it). `src/tools.ts` holds the tool logic,
  `src/server.ts` the MCP tool definitions, `src/index.ts` the stdio entry; `npm run build` bundles to `dist/index.js` with
  esbuild. Import `cashscript`/`@bitauth/libauth` from `mcp/src` only through `src/lib/chain-deps.ts` (one library copy).
  Its tests run in the root `npm test`; `cd mcp && npx tsc --noEmit -p tsconfig.json` typechecks it. Mainnet e2e:
  `cd mcp && npm run build && E2E_ALLOW_MAINNET=1 npx tsx scripts/mainnet-e2e.mts`.
- Shared payment code used by both the hosted agent and the MCP server: `src/lib/spend.ts` (`VaultSpender`),
  `src/lib/x402-client.ts`, `src/lib/connect-code.ts`. Vaults with `external: true` (agent index `0xffffffff`) belong
  to a user's own agent: Satchel serves their status but never drives them.
- `scripts/e2e.mts`: full on-chain run with a local test owner key (`address`, `run`, `sweep`, `refund`). Chipnet by default; mainnet needs `NEXT_PUBLIC_BCH_NETWORK=mainnet E2E_ALLOW_MAINNET=1`.

## Covenant invariants (do not break)

- Vault state = one UTXO + a mutable NFT. Commitment = `periodStart` (4B LE) ‖ `spent` (8B LE), 12 bytes.
- `spend`: exactly 1 input. Output 0 is the vault with the same bytecode and category and the honest new state. Output 1 is an allowlisted
  payee with no tokens. Output 2 is optional and must be a 0-value OP_RETURN. Outflow (payment + fee) counts toward the cap.
- Period roll only when `tx.locktime >= periodStart + periodBlocks`, enforced with CLTV (`tx.time`). Agent txs set
  `locktime = tip height`.
- No path may let the server or agent move funds beyond the cap or outside the allowlist. A new attack idea gets a
  failing test **first**, and that test must assert the exact `require` line that stops it.

## Conventions

- Satoshi amounts are `bigint` everywhere (suffix `n`). Never use JS `number` for sats.
- Default to **chipnet**. Use mainnet only for the final demo, and only with tiny amounts that can be recovered (rule of the hackathon).
- Secrets (`AGENT_MASTER_SEED`, `PROVIDER_SEED`, `AI_GATEWAY_API_KEY`) are server-only. Never import `src/lib/server/*`
  from client components, and never expose secrets through `NEXT_PUBLIC_*`. See `.env.example`.
- The server is stateless (no DB). The vault descriptor lives client-side (localStorage), and agent keys are re-derived from the seed.
- UI copy is in English (international judges). Keep the flow obvious; a judge spends about 2 minutes per project.

## Hackathon submission checklist (Mainnet Track — missing any = disqualified)

- [ ] A live demo URL where a judge can make a useful BCH **mainnet** transaction themselves
- [ ] WizardConnect wallet connection
- [ ] A top-of-page banner with the Widget Factory slides link, the repo link, and a CashTokens address for EMBER2026 donations
- [ ] Original work built during the hackathon (repo history shows this)
- [ ] Confirmed as real in the BCH BLAZE Telegram

## Verification

Before claiming something works, run the actual command (`npm test`, `npm run typecheck`, `npm run build`, or a
chipnet tx) and read its output. For on-chain flows, give the txid and explorer link as evidence.

## Commits

Commit only when asked or at a clear checkpoint. End commit messages with the attribution line from the session instructions.
