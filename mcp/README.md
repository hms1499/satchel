# satchel-pay-mcp

**Give your agent a budget, not your keys** — in any MCP client.

`satchel-pay-mcp` lets your own AI agent (Claude Desktop/Code, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI, …) pay
for APIs that charge per call, from a [Satchel](https://github.com/hms1499/satchel) vault on Bitcoin Cash.

- **The limit is enforced by consensus.** The vault is a BCH covenant: the agent can spend at most *X* sats per period
  (miner fees included) and only to allowlisted payees. Every node rejects anything else — even if this server, your
  machine or the agent is compromised.
- **The agent key never leaves your machine.** It is generated locally (`~/.satchel/agent.json`, mode 0600). Satchel's
  servers never see it. Your own wallet keeps the owner key and can withdraw everything at any time.
- **Extra guards in the server:** it pays only payees in the vault's allowlist and never more than
  `SATCHEL_MAX_PRICE_SATS` per call, one payment at a time.

## Install

Requires Node.js 22 or later. Pin the version you reviewed.

**Claude Code**

```bash
claude mcp add satchel -- npx -y satchel-pay-mcp@0.1.0
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`~/.cursor/mcp.json`), **Windsurf**, **Gemini CLI**
(`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "satchel": { "command": "npx", "args": ["-y", "satchel-pay-mcp@0.1.0"] }
  }
}
```

**VS Code** (`.vscode/mcp.json`, used by Copilot agent mode):

```json
{
  "servers": {
    "satchel": { "type": "stdio", "command": "npx", "args": ["-y", "satchel-pay-mcp@0.1.0"] }
  }
}
```

**Codex CLI** (`~/.codex/config.toml` — note the underscore in `mcp_servers`):

```toml
[mcp_servers.satchel]
command = "npx"
args = ["-y", "satchel-pay-mcp@0.1.0"]
```

ChatGPT only accepts remote MCP servers, so it is not supported (the agent key would have to live on a server).

## Get started (2 minutes)

1. Ask your agent to **set up Satchel**. It calls `satchel_setup` and gives you a link.
2. Open the link, connect your wallet (WizardConnect, e.g. Cashonize), choose a deposit, a cap per period and the payees,
   and sign. Nothing moves until you sign.
3. Copy the **connect code** the page shows and paste it into the chat. The agent calls `satchel_connect`.
4. Ask for something that needs a paid API ("What is the BCH price right now?"). The agent pays and shows the txid.
5. Withdraw any time from the Satchel page with your wallet.

## Tools

| Tool | What it does |
|---|---|
| `satchel_setup` | Creates the local agent key if needed; returns its public key and the vault-creation link |
| `satchel_connect` | Connects the vault from its connect code (`satchel1:…`); one vault per network |
| `satchel_status` | Balance, spent this period, remaining, when the budget resets, allowed payees |
| `satchel_catalog` | Satchel's paid APIs: endpoint, price, whether this vault may pay them |
| `satchel_pay_fetch` | Calls an endpoint; on HTTP 402 pays from the vault and retries; returns the result and the txid |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SATCHEL_NETWORK` | `mainnet` | `mainnet` or `chipnet` |
| `SATCHEL_URL` | the Satchel web app | where vaults are created and the catalog lives |
| `SATCHEL_HOME` | `~/.satchel` | key and connected-vault files |
| `SATCHEL_MAX_PRICE_SATS` | `5000` | the most this server pays for one call |
| `SATCHEL_AGENT_KEY` | — | a 64-hex private key to use instead of the key file (CI) |

## The payment protocol (bch-sc402)

1. The client calls an endpoint. Without payment it answers `402` with
   `{ accepts: [{ scheme: "bch-sc402", network, payTo, amount, nonce, expires, request, sig, … }] }`.
2. The client pays `amount` sats to `payTo` in a transaction with an `OP_RETURN` output `"SC402" ‖ nonce`.
3. The client repeats the same request with `X-Payment: base64(JSON { challenge, txid })`.
4. The provider checks its signature on the challenge, that the challenge is for this exact request, and that the
   transaction pays it (0-conf), then answers. Repeating the same paid request returns the same answer (idempotent).

Any HTTP service can accept bch-sc402 payments; add its address to your vault's allowlist when you create the vault.

## Security notes

- Payments are capped by the covenant per period, so the most a compromised agent can lose is the remaining budget,
  and only to the payees you allowed.
- This is hackathon software (BCH BLAZE 2026). Use small amounts.
