# Satchel

**Give your agent a budget, not your keys.**

Satchel is a Bitcoin Cash covenant wallet for AI agents. You fund a vault, and your agent pays for APIs on its own. BCH consensus enforces the rules, not our server:

- **A cap per period.** The agent can spend at most *X* sats every *N* blocks, miner fees included.
- **Allowlisted payees only.** Payments can only go to the API providers you approved.
- **You can always pull out.** The owner key can withdraw everything at any time.

If the agent is prompt-injected, or our server is compromised, the worst it can do is spend the remaining budget on the providers you approved. Any transaction that breaks the rules is rejected by every node with `mandatory-script-verify-flag-failed`.

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/bchblaze2026/detail) (Mainnet Track).

## Demo flow (about 2 minutes)

1. **Connect** a wallet with WizardConnect (for example Cashonize).
2. **Create a vault**: choose a deposit, a cap per period, and a period length, then sign the funding transaction.
3. **Ask the agent** a question. It buys paid tool calls (price feed, web reader, deep analysis) over HTTP 402. Every payment is an on-chain transaction from the vault, shown with an explorer link.
4. **Try to break it.** *Overspend* and *Pay an attacker address* broadcast transactions that violate the covenant. The network rejects them, and the UI shows the raw rejection.
5. **Withdraw** the remainder with your owner key.

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

An AI SDK 7 tool-calling agent whose tools are the paid endpoints. The server derives the agent key for each vault from a master seed, so the server is stateless. The vault descriptor lives in the browser. The agent never checks the budget itself: the covenant is the enforcer.

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

Without `AI_GATEWAY_API_KEY`, the agent runs a scripted plan so that the payment flow still works.

### Chipnet end-to-end

```bash
npx tsx scripts/chipnet-e2e.mts address   # prints the test owner address; fund it from a chipnet faucet
npx tsx scripts/chipnet-e2e.mts run       # genesis → agent payments → attacks → withdraw (needs npm run dev)
```

## Security notes

- The server holds agent keys, but agent keys can only use `spend`, which is capped and allowlisted by the covenant.
- Changing the cap or the allowlist means withdrawing and creating a new vault, by design.
- This is hackathon software. Use small amounts.
