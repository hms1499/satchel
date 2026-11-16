# AgentVault — Design

Status: approved by the user, who delegated the product decisions to Claude (2026-11-16).
Target: BCH BLAZE 2026 Mainnet Track. Deadline 2026-11-22 14:00 UTC.

## Intent

AI agents need to pay for things such as APIs, data, and compute. Giving an agent a normal hot wallet means a bug,
a prompt injection, or a server compromise can drain everything. AgentVault is a **Bitcoin Cash covenant
wallet for AI agents**. The owner deposits BCH and the agent can spend it autonomously, but only
**up to a cap per period** and **only to allowlisted recipients**. The owner can withdraw everything at any time.
The rules are enforced by BCH consensus, not by our server.

Pitch line: *"Give your agent a budget, not your keys."*

## Users

- **Primary:** developers or businesses that run AI agents and need them to pay for paid APIs
  (x402-style pay-per-call). We offer them an SDK and a vault.
- **Demo persona:** a judge who opens the site, funds a vault with a few cents of BCH, and chats with a research
  agent that buys paid tool calls until the covenant refuses.

## Goals

1. A covenant that enforces the per-period cap, the recipient allowlist, and owner withdrawal on mainnet.
2. A judge can do the whole flow in about 2 minutes on mainnet: connect via WizardConnect, create and fund a vault,
   watch the agent pay for tools, see the covenant **reject** an over-budget or non-allowlisted spend, and withdraw the remainder.
3. A pay-per-call (HTTP 402) protocol on BCH, with real paid tools served by us.

## Non-goals (MVP)

- PUSD/token-denominated caps (stretch goal).
- Changing the allowlist or cap of an existing vault (instead, withdraw and create a new vault).
- Multi-agent vaults, and an Owner-Key NFT for transferable ownership (stretch goal).
- Persisted user accounts or a database.

## Anti-goals

- Any path where our server can move funds outside the cap or the allowlist. That would make the product a lie.
- A flow that confuses judges, or that needs them to hold PUSD or use a specific chain other than BCH.

## Constraints

- Hackathon rules: a live demo URL, a mainnet BCH transaction a judge can make, WizardConnect, and a banner with the slides,
  the repo, and an EMBER2026 CashTokens address.
- WizardConnect signs via `inputPaths` (HD path name and index per input). Contract inputs use CashScript
  placeholders.
- Use tiny mainnet amounts (≤ ~50k sats per demo).

## Approaches considered

1. **Covenant with the state in a mutable NFT commitment (chosen).** One vault UTXO carries the BCH and a mutable NFT
   whose commitment holds `periodStart` and `spentInPeriod`. Each agent spend recreates the UTXO with updated state.
   This allows many micro-payments per period. It is the most BCH-native option and showcases CashTokens.
2. **Relative-timelock coins (`this.age`).** This allows only one payment per period, which does not fit agents
   making micro-payments.
3. **Off-chain policy server + 2-of-2 multisig.** Simple, but the server is trusted, so it defeats the point.

## Covenant (CashScript 0.14)

Constructor: `ownerPk`, `agentPk`, `capPerPeriod` (sats), `periodBlocks`, `allowlistHash`
(`hash256` of the concatenated `sha256(lockingBytecode)` of each allowed recipient, 32 bytes each).

NFT commitment (12 bytes): `periodStart` (4-byte LE int, block height) ‖ `spent` (8-byte LE int, sats).

`spend(agentSig, allowlist, recipientIndex)`:
- agent signature; exactly 1 input (the vault); input 0 holds a mutable NFT (33-byte category).
- `outflow = input.value − outputs[0].value` (this includes the miner fee, so fees count against the budget).
- Period roll: if `tx.locktime ≥ periodStart + periodBlocks`, then enforce it with `require(tx.time >= …)` (CLTV),
  set `newStart = tx.locktime` and `newSpent = outflow`. Otherwise `newSpent = spent + outflow`.
- `newSpent ≤ capPerPeriod`.
- output 0: the same locking bytecode, the same category, commitment `newStart ‖ newSpent`, no fungible tokens.
- output 1: `sha256(lockingBytecode)` equals allowlist entry `recipientIndex`, no tokens.
- Optional output 2: value 0, used as an OP_RETURN payment memo (x402 nonce). No other outputs.

`withdraw(ownerSig)`: the owner signature authorizes any spend. The owner can also re-fund the vault through this path.

Why no category constructor param: a fake-state NFT UTXO can only hold funds that someone else deposited into it,
and `spend` forbids extra inputs, so vault funds can never be merged into a fake state. Plain BCH sent to the
address without the NFT can only be recovered by the owner.

## System

- **Next.js 16 app (Vercel)**: the landing page and the vault dashboard (create, fund, agent chat, live ledger, withdraw).
- **Wallet**: `@wizardconnect/react`. `ownerPk` is `receive/0`. We scan receive and change addresses 0–19 for UTXOs.
  The genesis input must be an outpoint with index 0; if none exists, we do a self-send first.
- **Agent key**: derived per vault from the server secret `AGENT_MASTER_SEED` plus `agentIndex`, so the server is stateless.
  The client stores the vault descriptor (params + agentIndex + HMAC access token) in localStorage.
- **Paid tools (x402 on BCH)**: `GET /api/tools/<name>` returns `402 {payTo, amount, nonce}`. The agent pays from the vault with an
  OP_RETURN nonce, then retries with `X-Payment: <txid>`, and the server verifies the tx via Electrum (0-conf).
  Tools: crypto price (CoinGecko), web page reader, and a deep-analysis LLM call.
- **Agent**: AI SDK 7 tool-calling loop. The tools are the paid endpoints. It shows every payment (txid, explorer link).
- **Proof moments**: the "Overspend" and "Pay attacker" buttons broadcast covenant-violating txs. The node
  rejects them, and the UI shows the raw rejection.
- **Network**: chipnet for development, mainnet for the demo. Electrum via the CashScript `ElectrumNetworkProvider`.

## Left to the builder

UI styling, tool prices (around 1–3k sats), and the default cap (~10k sats per 144 blocks).
