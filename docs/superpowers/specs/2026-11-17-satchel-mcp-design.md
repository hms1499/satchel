# satchel-pay-mcp — Design

Status: draft for the user's approval, 2026-11-17. Deadline for the hackathon submission: 2026-11-22 14:00 UTC.
Research and validation behind the choices: see the conversation summary in "Approaches" below.

## Intent

Today Satchel's agent is Satchel's own: the server derives the agent key, runs the agent and is also every allowlisted payee.
A product review called this a closed loop and the main reason Satchel is "a demo, not an MVP".
`satchel-pay-mcp` lets **any user's own AI agent** — in any MCP client — pay for HTTP 402 (bch-sc402) APIs from a Satchel
vault, with the **agent key generated and kept on the user's machine**. The covenant keeps doing what it does: a per-period
cap and a payee allowlist enforced by Bitcoin Cash consensus.

Pitch line it enables: *"Others enforce agent budgets in code. Satchel enforces them in consensus — and the key that spends
the budget never leaves your machine."*

## Users

- Developers and power users of MCP clients: Claude Desktop / Claude Code, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI.
- Hackathon judges who want to try it (one install command + the existing web flow), and the demo video.

## Goals

1. `npx -y satchel-pay-mcp@<version>` runs a stdio MCP server in any of the clients above.
2. First run generates an agent key locally; the web app creates a vault for that key (owner signs with WizardConnect).
3. The agent can check its budget and pay for bch-sc402 endpoints; the covenant refuses anything over the cap or off the allowlist.
4. Works on BCH mainnet (default) and chipnet.

## Non-goals (this deadline)

- Remote / HTTP MCP and ChatGPT support (ChatGPT only accepts remote MCP servers).
- Human confirmation prompts (MCP elicitation), OS keychain storage, multiple vaults per agent, changing a vault's settings.
- Payees outside Satchel's catalog (the allowlist is still chosen from the catalog in the web app).
- An x402 (Base/USDC) compatible scheme.

## Anti-goals

- The agent private key leaving the user's machine (no upload, no logging, never in tool output).
- The MCP server paying anyone outside the vault allowlist, or more per call than the configured maximum.
- Writing anything but MCP protocol messages to stdout (it corrupts the stdio transport).

## Constraints

- Node ≥ 22 (AI SDK/Next already require it; the MCP SDK needs ≥ 18). `@bitauth/libauth` pinned to `3.1.0-next.8` (same as
  cashscript and WizardConnect), ESM only (top-level await).
- The covenant and its tests must not change.
- The hosted demo (Satchel's own agent, "Run agent", attack buttons) must keep working unchanged for judges.

## Approaches (decided)

Research summary: the closest prior art, Coinbase Payments MCP, is a local server installed with `npx @coinbase/payments-mcp`
(config in `~/.payments-mcp/`). Agent-payment MCP servers (PayAgents, ClawPay, AgentPay) enforce spend limits in software;
x402 and MCP have no spend-limit primitive. Generic MCP guidance prefers remote servers for distribution, but not when the
server must hold local secrets.

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | **Local stdio server, published to npm** | Non-custodial; works in every stdio client; needs Node and `npx`; no ChatGPT | **Chosen by the user**, published on npm |
| B | Remote MCP on Vercel | Zero install, ChatGPT works; but Satchel would hold agent keys while also owning every allowlisted payee, so a server compromise drains the cap each period | Rejected |
| C | A + B | Widest reach; double the work and two security stories before the deadline | Rejected |

## How it works

```
User's MCP client ──stdio── satchel-pay-mcp (Node, user's machine)
                               │  ~/.satchel/agent.json   (agent private key, 0600)
                               │  ~/.satchel/vault-<network>.json (connected vault, from the connect code)
                               ├── Electrum (Fulcrum) ── BCH network      (reads vault UTXO, broadcasts spends)
                               └── HTTPS ── bch-sc402 endpoints (Satchel /api/tools/* today; any provider tomorrow)
```

Setup flow:
1. User adds the server to their client. The agent calls `satchel_setup`: the server creates the key if missing and returns
   the agent public key and a link `https://<satchel-url>/?agent=<agentPk>`.
2. On that page the web app creates the vault with that `agentPk` instead of registering a hosted agent. The owner signs
   as today. The genesis recovery memo carries `agentPk` with agent index `0xFFFFFFFF` ("external agent").
3. The web app shows a **connect code**. The user pastes it into the chat; the agent calls `satchel_connect(code)`.
4. The agent uses `satchel_status`, `satchel_catalog`, `satchel_pay_fetch`.

### MCP tools (contract)

| Tool | Input | Output | Notes |
|---|---|---|---|
| `satchel_setup` | — | `agentPk`, `createVaultUrl`, `network`, connected vault (if any) | Idempotent; never returns the private key |
| `satchel_connect` | `code` | vault address, cap, period, allowlist, balance | Rejects codes for another network or another agent key; checks the vault exists on chain |
| `satchel_status` | — | balance, spent this period, remaining, resets at height, allowlist | Read-only |
| `satchel_catalog` | — | Satchel's paid tools: name, description, price, payTo, endpoint URL | From `<satchel-url>/api/config` |
| `satchel_pay_fetch` | `url`, `method` (default POST), `body` (object) | the endpoint's result, `txid`, explorer link, amount, fee, remaining | Calls the URL; on 402 validates the challenge and pays; retries with the payment header |

`satchel_pay_fetch` guards (layer 2, in addition to the covenant):
- only bch-sc402 challenges for the configured network;
- `payTo` must be in the connected vault's allowlist;
- `amount` ≤ `SATCHEL_MAX_PRICE_SATS` (default 5,000);
- payments are serialized per vault in-process (parallel tool calls cannot race on the vault UTXO).

Errors are returned as MCP tool errors (`isError: true`) with a plain sentence, distinguishing "the covenant refused this
payment (budget used up / payee not allowed)" from "network busy" and "endpoint error".

### Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `SATCHEL_NETWORK` | `mainnet` | `mainnet` or `chipnet` |
| `SATCHEL_URL` | the production deployment URL | web app + catalog base URL |
| `SATCHEL_HOME` | `~/.satchel` | key and vault files |
| `SATCHEL_MAX_PRICE_SATS` | `5000` | per-call ceiling |
| `SATCHEL_AGENT_KEY` | — | hex private key instead of the file (CI) |

### Code structure

- Extract the server's payment core into shared, isomorphic modules so the hosted agent and the MCP server run the same code:
  - `src/lib/spend.ts`: pay from a vault given `{ contract, params, signer, provider }` — current `payOnce` logic
    (stale-UTXO retries, successor cache, error classification). `agent-wallet.ts` becomes a thin wrapper.
  - `src/lib/x402-client.ts`: parse/validate a 402 challenge, build the payment memo and header, `retryPaidRequest`.
    `paid-client.ts` uses it.
- New package `agentvault/mcp/` (`package.json` name `satchel-pay-mcp`, `bin`), source in `mcp/src/`, bundled with esbuild
  into one ESM file (our modules inlined; `@modelcontextprotocol/sdk`, `cashscript`, `@bitauth/libauth`, `zod` as pinned
  runtime dependencies).
- Web app: `?agent=<pk>` on the create screen → "Use my own agent (MCP)" mode: no `/api/agent/register`; descriptor gets
  `external: true`, empty token, agent index `0xFFFFFFFF`; after creation show the connect code with a copy button.
  `openDescriptor(…, { requireToken: false })` skips the hosted-agent key check (status works for external vaults).
  Dashboard for an external vault: status + withdraw; the agent panel explains that the agent runs in the user's client.
- Connect code: `satchel1:` + base64url(JSON `{ v: 1, network, params, genesisTxid }`). It contains no secret.

## Verification

- Unit tests for the extracted core (existing hardening and covenant tests must keep passing), the connect code, and the
  MCP guards.
- An in-process MCP client test (SDK in-memory transport + MockNetworkProvider): setup → connect → pay_fetch → refusal.
- **Mainnet end-to-end** driven over real stdio by an MCP SDK client: create a vault for the MCP's agent key with the
  local test owner key, connect, `satchel_pay_fetch` a Satchel tool (txid), hit the cap (covenant refusal), owner withdraw.
- Manual smoke test in at least one non-Claude client (Cursor or Codex CLI) before publishing.
- Publish `satchel-pay-mcp@0.1.0` to npm with the user's account (asked right before publishing).

## Calls made after the builder check (Claude's calls, correct me if wrong)

1. **`SATCHEL_URL` default** is the production URL, filled in at deploy time before `0.1.0` is published (the MCP is
   published after the web app is live). A chipnet MCP needs `SATCHEL_URL` pointing at a chipnet deployment.
2. **One vault per network.** `satchel_connect` replaces a previously connected vault and says which one it replaced.
3. **Recovery of external vaults:** a recovered memo with agent index `0xFFFFFFFF` becomes a descriptor with
   `external: true`; the dashboard shows status and withdraw. Hosted-agent endpoints (`run`, `attack`) answer an external
   vault with "this vault's agent runs in your own MCP client".
4. **No demo attack tool in the MCP.** The covenant refusal shows naturally when `satchel_pay_fetch` hits the cap; the attack
   buttons stay in the hosted demo.
5. **Electrum servers:** CashScript's `ElectrumNetworkProvider` defaults, as on the server.
6. **Monorepo hygiene:** `mcp/` has its own `tsconfig`/build; the root `tsconfig`, ESLint and Next build exclude it.
7. **Mainnet by default is safe:** nothing moves until the owner signs the vault creation in their wallet.

## Left to the builder

Tool description wording, file layout inside `mcp/src`, esbuild options, test structure, README snippets per client.
