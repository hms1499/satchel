# satchel-pay-mcp

**Give your agent a budget, not your keys** — in any MCP client.

`satchel-pay-mcp` lets your own AI agent (Claude Desktop/Code, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI, …) pay
for APIs that charge per call, and send BCH to the payees you chose, from a
[Satchel](https://github.com/hms1499/satchel) vault on Bitcoin Cash.

- **The limit is enforced by consensus.** The vault is a BCH covenant: the agent can spend at most *X* sats in any *N*-block window
  (fees included; a new period starts only *N* blocks after the last payment) and only to allowlisted payees. Every node rejects anything else — even if this server, your
  machine or the agent is compromised.
- **The agent key never leaves your machine.** It is generated locally (`~/.satchel/agent.json`, mode 0600). Satchel's
  servers never see it. Your own wallet keeps the owner key and can withdraw everything at any time.
- **Extra guards in the server:** it pays only payees in the vault's allowlist, never more than
  `SATCHEL_MAX_PRICE_SATS` per API call or `SATCHEL_MAX_SEND_SATS` per direct send, and only APIs on origins you allowed,
  one payment at a time.

## What it can pay

- **Satchel's own paid tools** (listed by `satchel_catalog`).
- **Sellers that use `satchel-pay-server`** (the seller kit in the Satchel repo), once you add their origin to `SATCHEL_PAY_ORIGINS` and
  their address to the vault's allowlist.
- **Direct sends** (`satchel_send`) to any payee in the vault's allowlist, e.g. a person or a service you pay by hand.

Not yet: sellers that only speak x402-bch `exact`. Its reference verifier rejects Satchel payments on two policy rules
(the vault's state NFT commitment changes on every payment, and the locktime is non-zero), so a covenant wallet cannot
pass it today. That is on the roadmap, with an upstream proposal.

## Install

Requires Node.js 22 or later. Pin the version you reviewed.

**Claude Code**

```bash
claude mcp add satchel -- npx -y satchel-pay-mcp@0.2.0
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`~/.cursor/mcp.json`), **Windsurf**, **Gemini CLI**
(`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "satchel": { "command": "npx", "args": ["-y", "satchel-pay-mcp@0.2.0"] }
  }
}
```

**VS Code** (`.vscode/mcp.json`, used by Copilot agent mode):

```json
{
  "servers": {
    "satchel": { "type": "stdio", "command": "npx", "args": ["-y", "satchel-pay-mcp@0.2.0"] }
  }
}
```

**Codex CLI** (`~/.codex/config.toml` — note the underscore in `mcp_servers`):

```toml
[mcp_servers.satchel]
command = "npx"
args = ["-y", "satchel-pay-mcp@0.2.0"]
```

ChatGPT only accepts remote MCP servers, so it is not supported (the agent key would have to live on a server).

## Get started (2 minutes)

1. Ask your agent to **set up Satchel**. It calls `satchel_setup` and gives you a link.
2. Open the link, connect your wallet (WizardConnect, e.g. Cashonize), choose a deposit, a cap per period and the payees,
   and sign. Nothing moves until you sign.
3. Copy the **connect code** the page shows and paste it into the chat. The agent calls `satchel_connect`. If you picked
   sellers in the form, it answers with `addToPayOrigins`: add those origins to `SATCHEL_PAY_ORIGINS` and restart the
   server to buy from them.
4. Ask for something that needs a paid API ("What is the BCH price right now?"). The agent pays and shows the txid.
5. Withdraw any time from the Satchel page with your wallet.

## Tools

| Tool | What it does |
|---|---|
| `satchel_setup` | Creates the local agent key if needed; returns its public key and the vault-creation link |
| `satchel_connect` | Connects the vault from its connect code (`satchel1:…`); one vault per network |
| `satchel_status` | Balance, spent this period, remaining, when the budget resets (`resetsAtHeight`, null until the last payment confirms; `resetRule: "sliding"`), allowed payees with their labels |
| `satchel_catalog` | Paid APIs on Satchel and on each seller in `SATCHEL_PAY_ORIGINS`: endpoint, price, whether this vault may pay them; a seller that is down is reported, not fatal |
| `satchel_pay_fetch` | Calls an endpoint; on HTTP 402 pays from the vault and retries; returns the result and the txid |
| `satchel_send` | Sends BCH from the vault to an allowlisted payee, with an optional memo (≤ 100 UTF-8 bytes) on chain; returns the txid and the budget left |

## Custom payees

When you create the vault you can add your own payees (a label and a CashAddr) next to Satchel's tools, up to 8 payees in
total. They are stored in their canonical form, so a token-aware `z…` address and its `q…` form are the same payee.
Labels live in the connect code, not on chain: `satchel_status` shows them, and `satchel_send` returns the label of the
payee it paid. The covenant enforces the allowlist itself, so `satchel_send` cannot pay anyone else, and the server
refuses before signing:

1. an address that is not valid on this network (a `bchtest:` address on mainnet, for example);
2. an address outside the vault's allowlist;
3. an amount below 546 sats or above `SATCHEL_MAX_SEND_SATS`;
4. a memo over 100 UTF-8 bytes (emoji and accented letters take more than one byte).

The memo is written as an `OP_RETURN` output `"SATM" ‖ utf8(memo)`, so anyone can read it on chain.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SATCHEL_NETWORK` | `mainnet` | `mainnet` or `chipnet` |
| `SATCHEL_URL` | the Satchel web app | where vaults are created and the catalog lives |
| `SATCHEL_HOME` | `~/.satchel` | key and connected-vault files |
| `SATCHEL_MAX_PRICE_SATS` | `5000` | the most this server pays for one API call |
| `SATCHEL_MAX_SEND_SATS` | `10000` | the most one `satchel_send` pays |
| `SATCHEL_PAY_ORIGINS` | — | comma-separated seller origins (e.g. `https://seller.example`) that `satchel_pay_fetch` may pay and `satchel_catalog` lists, in addition to `SATCHEL_URL`. Only this variable widens them: neither Satchel's server nor a connect code can |
| `SATCHEL_AGENT_KEY` | — | a 64-hex private key to use instead of the key file (CI) |

## The payment protocol (bch-sc402)

1. The client calls an endpoint. Without payment it answers `402` with
   `{ accepts: [{ scheme: "bch-sc402", network, payTo, amount, nonce, expires, request, sig, … }] }`.
2. The client pays `amount` sats to `payTo` in a transaction with an `OP_RETURN` output `"SC402" ‖ nonce`.
3. The client repeats the same request with `X-Payment: base64(JSON { challenge, txid })`.
4. The provider checks its signature on the challenge, that the challenge is for this exact request, and that the
   transaction pays it (0-conf), then answers. Repeating the same paid request returns the same answer (idempotent).

Any HTTP service can accept bch-sc402 payments; add its address to your vault's allowlist when you create the vault,
and its origin to `SATCHEL_PAY_ORIGINS`.

## Security notes

- Payments are capped by the covenant: at most one cap in any *N*-block window, so that is the most a compromised agent
  can spend, and only to the payees you allowed.
- Sellers accept payments at 0-conf: the paying transaction is checked when it reaches the mempool, before it is
  confirmed. That is fine for the small per-call prices this is built for; do not treat it as final settlement for large
  amounts.
- This is hackathon software (BCH BLAZE 2026). Use small amounts.
