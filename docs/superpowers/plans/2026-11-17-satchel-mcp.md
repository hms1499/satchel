# satchel-pay-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `satchel-pay-mcp`, a local stdio MCP server that lets any MCP client's agent pay bch-sc402 endpoints from a Satchel vault with a locally held agent key, plus the web-app support for vaults with an external agent.

**Architecture:** The server's payment logic moves into isomorphic modules (`src/lib/spend.ts`, `src/lib/x402-client.ts`) used by both the hosted agent and the MCP server. The MCP package lives in `mcp/`, keeps tool logic in injectable handlers (`mcp/src/tools.ts`), and is bundled by esbuild into one ESM file. The web app gains an "external agent" mode (`?agent=<pk>`) and shows a connect code.

**Tech Stack:** TypeScript (ESM), CashScript 0.14, `@bitauth/libauth@3.1.0-next.8`, `@modelcontextprotocol/sdk@1.32.x`, zod 4, esbuild, vitest 5, Next.js 16.

**Spec:** `docs/superpowers/specs/2026-11-17-satchel-mcp-design.md`

## Global Constraints

- Node ≥ 22. ESM only. `@bitauth/libauth` pinned to exactly `3.1.0-next.8`.
- The covenant (`contracts/Satchel.cash`) and its tests do not change. The hosted demo ("Run agent", attack buttons) keeps working.
- Satoshi amounts are `bigint` everywhere; never JS `number` for sats (CLAUDE.md).
- The agent private key never leaves the machine: not in tool output, logs, or network requests.
- The MCP server writes only protocol messages to stdout; diagnostics go to stderr.
- npm package name `satchel-pay-mcp`; binary name `satchel-pay-mcp`; first version `0.1.0`.
- Tool names: `satchel_setup`, `satchel_connect`, `satchel_status`, `satchel_catalog`, `satchel_pay_fetch`.
- Env defaults: `SATCHEL_NETWORK=mainnet`, `SATCHEL_HOME=~/.satchel`, `SATCHEL_MAX_PRICE_SATS=5000`, `SATCHEL_URL` = production URL (constant `DEFAULT_SATCHEL_URL`, set at deploy), `SATCHEL_AGENT_KEY` optional hex.
- Files: `$SATCHEL_HOME` mode 0700; `agent.json` and `vault-<network>.json` mode 0600.
- Connect code: `satchel1:` + base64url(JSON `{ v: 1, network, params, genesisTxid }`), params as in `VaultDescriptor["params"]`.
- External agent index: `EXTERNAL_AGENT_INDEX = 0xffffffff` (4294967295).
- UI copy in English.
- Publishing to npm is a separate step that needs the user's go-ahead and the production URL.

## Review Focus

1. A 402 whose challenge is for another network or another scheme (not `bch-sc402`) → refuse, pay nothing. Test in Task 6.
2. The endpoint keeps failing after the payment went out (5xx) → tool error that includes the txid, so the user knows they paid. Test in Task 6.
3. A connect code made for another agent key (pasted someone else's code) → reject, store nothing. Test in Task 6.
4. The owner withdrew the vault while the MCP is connected → `satchel_status`/`satchel_pay_fetch` say the vault is closed. Test in Task 6.
5. A corrupted or unreadable `agent.json` → clear error; never overwrite an existing key file. Test in Task 5.

---

### Task 1: Shared payment core

**Files:**
- Create: `src/lib/spend.ts`, `src/lib/x402-client.ts`, `src/lib/spend.test.ts`
- Modify: `src/lib/server/agent-wallet.ts` (payFromVault, currentVaultUtxo, classifyBroadcastError become thin wrappers/re-exports), `src/lib/server/paid-client.ts` (use x402-client), `src/lib/server/x402.ts` (import MEMO_PREFIX_HEX, memoForChallenge, encodePaymentHeader, Challenge from x402-client and re-export them)

**Interfaces:**
- Produces (`src/lib/spend.ts`, no imports from `server/` or `config`):
  - `type PaymentOutcome` (moved unchanged from agent-wallet)
  - `classifyBroadcastError(nodeError: string, failingRequire: string | undefined): "covenant" | "stale" | "other"` (moved)
  - `interface SpendTarget { contract: VaultContract; params: VaultParams; agentSigner: SignatureTemplate; provider: NetworkProvider }`
  - `class VaultSpender { currentVaultUtxo(t: SpendTarget, skip?: ReadonlySet<string>): Promise<SpendableUtxo | undefined>; pay(t: SpendTarget, to: string, amount: bigint, memo?: string, tamper?: { overrideRecipientIndex?: number }): Promise<PaymentOutcome> }` — owns its successor cache and per-vault lock (instance state, keyed by contract address); same algorithm as today's `payOnce`.
- Produces (`src/lib/x402-client.ts`, no secrets): `interface Challenge` (moved), `MEMO_PREFIX_HEX`, `memoForChallenge(c)`, `encodePaymentHeader(c, txid)`, `retryPaidRequest(doFetch)` (moved from paid-client), and
  `parseChallenge(body: unknown, network: string): { ok: true; challenge: Challenge } | { ok: false; error: string }` — takes the 402 JSON; requires `accepts[0].scheme === "bch-sc402"` and `network` match.
- Server keeps: `payFromVault(o, to, amount, memo?, tamper?)` (adds `logEvent("payment")`), `currentVaultUtxo(o, skip?)`, re-export `classifyBroadcastError`.

- [ ] **Step 1: Write the failing tests** in `src/lib/spend.test.ts`:
  - `"two VaultSpender instances do not share their successor cache"`: spender A pays once on a NodeLikeProvider (copy the class from `server/hardening.test.ts`); spender B on a lagging view gets a stale-retry (not A's cached successor).
  - `"parseChallenge accepts a bch-sc402 challenge for the network"` → `ok: true`.
  - `"parseChallenge refuses another scheme"` (`scheme: "exact"`) → `{ ok: false, error: "unsupported payment scheme" }`.
  - `"parseChallenge refuses another network"` (`network: "chipnet"` vs `"mainnet"`) → `{ ok: false, error: "challenge is for chipnet, expected mainnet" }`.
- [ ] **Step 2: Run** `npx vitest run src/lib/spend.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the two modules by moving code; rewire agent-wallet, paid-client, x402.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` — Expected: all pass (existing 53 + new).
- [ ] **Step 5: Commit** `refactor: extract isomorphic payment core (spend, x402-client)`.

### Task 2: External-agent vaults in the shared and server code

**Files:**
- Modify: `src/lib/descriptor.ts`, `src/lib/recovery.ts`, `src/lib/server/agent-wallet.ts` (openDescriptor), `src/lib/server/hardening.test.ts` or new `src/lib/server/external.test.ts`

**Interfaces:**
- Consumes: Task 1 server wrappers.
- Produces:
  - `EXTERNAL_AGENT_INDEX = 0xffffffff` exported from `src/lib/descriptor.ts`; `DescriptorSchema` gains `external: z.boolean().optional()`; `agentIndex` allows up to `0xffffffff`.
  - `descriptorFromRecovered(v: RecoveredVault, network: BchNetwork): VaultDescriptor` in `recovery.ts` (token `""`, `recovered: true`, `external: v.agentIndex === EXTERNAL_AGENT_INDEX`); `wallet.findOwnedVaults` uses it.
  - `openDescriptor(raw, { requireToken: false })` skips the hosted-agent key check (returns `key: null` when the descriptor is external); with `requireToken: true` an external descriptor throws `AgentAuthError("This vault's agent runs in your own MCP client, not on Satchel.")`.

- [ ] **Step 1: Write the failing tests:**
  - `"status opens an external-agent descriptor without a token"` → `openDescriptor({...external, token: ""}, { requireToken: false })` does not throw; `vaultStatus` returns the balance.
  - `"hosted endpoints refuse an external-agent descriptor"` → throws with message containing `"own MCP client"`.
  - `"recovered memo with the external index becomes an external descriptor"` → `descriptorFromRecovered({agentIndex: 0xffffffff, ...}).external === true`.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement.** `encodeRecoveryMemo(params, EXTERNAL_AGENT_INDEX, payees)` must round-trip (u32 max).
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: support vaults whose agent key is external`.

### Task 3: Connect code

**Files:**
- Create: `src/lib/connect-code.ts`, `src/lib/connect-code.test.ts`

**Interfaces:**
- Produces: `interface ConnectInfo { v: 1; network: BchNetwork; params: VaultDescriptor["params"]; genesisTxid?: string }`;
  `encodeConnectCode(info: ConnectInfo): string` (prefix `satchel1:`, base64url, no padding);
  `decodeConnectCode(code: string): { ok: true; info: ConnectInfo } | { ok: false; error: string }` (trims whitespace and surrounding quotes/backticks; zod-validates; errors: `"not a Satchel connect code"`, `"malformed connect code"`).

- [ ] **Step 1: Write the failing tests:** round-trip equality; code survives being wrapped in backticks and newlines; `"satchel2:..."` → `not a Satchel connect code`; truncated payload → `malformed connect code`; code has no `token` field even if a descriptor with a token is passed in.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (Buffer-free: use `btoa`/`atob` + URL-safe alphabet so the browser can encode). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: connect code for external agents`.

### Task 4: Web app external-agent mode

**Files:**
- Modify: `src/lib/client/wallet.ts` (createVault), `src/components/SatchelApp.tsx`, `src/components/CreateVault.tsx`, `src/components/Dashboard.tsx`

**Interfaces:**
- Consumes: Task 2 (`EXTERNAL_AGENT_INDEX`, `external`), Task 3 (`encodeConnectCode`).
- Produces: `createVault(manager, input, knownPayees, onStep, externalAgentPk?: string)`: when `externalAgentPk` is set, skip `/api/agent/register`, use that key, memo index `EXTERNAL_AGENT_INDEX`, descriptor `{ external: true, token: "", agentIndex: EXTERNAL_AGENT_INDEX }`.
- UI: `?agent=<pk>` (validated `/^0[23][0-9a-f]{64}$/`; invalid → visible error, hosted mode) shows a banner on the create screen: "Creating a vault for your own agent (MCP): `<short pk>`". Dashboard for `external` vaults: status, withdraw, and a "Connect your agent" card with the connect code, a Copy button, and the line "Paste this into your agent's chat; it calls `satchel_connect`." No Run agent / attack panels.

- [ ] **Step 1:** Implement. **Step 2: Run** `npm run typecheck && npm run lint && npm run build` — PASS.
- [ ] **Step 3: Verify in a separate Playwright browser** (never the user's tab): `/?agent=<valid pk>` → Launch app shows the banner text; `/?agent=zz` shows the invalid-key error. Seed `localStorage["satchel:vault"]` with an external descriptor (mainnet vault from Task 8, or any params) → the dashboard shows the connect-code card and no "Run agent".
- [ ] **Step 4: Commit** `feat(web): create and manage vaults for external (MCP) agents`.

### Task 5: MCP package scaffold, config and key store

**Files:**
- Create: `mcp/package.json`, `mcp/tsconfig.json`, `mcp/build.mjs`, `mcp/src/config.ts`, `mcp/src/keystore.ts`, `mcp/src/vault-store.ts`, `mcp/src/keystore.test.ts`
- Modify: root `tsconfig.json` (`exclude` `mcp`), `eslint.config.mjs` (ignore `mcp/dist/**`), `.gitignore` (`mcp/dist`, `mcp/node_modules`)

**Interfaces:**
- `mcp/package.json`: `"name": "satchel-pay-mcp"`, `"version": "0.1.0"`, `"type": "module"`, `"bin": { "satchel-pay-mcp": "dist/index.js" }`, `"files": ["dist", "README.md"]`, `"engines": { "node": ">=22" }`, dependencies `@modelcontextprotocol/sdk` `^1.32.2`, `cashscript` `^0.14.0`, `@bitauth/libauth` `3.1.0-next.8`, `zod` `^4.6.7`; devDependency `esbuild`; scripts `build`, `typecheck`.
- `loadConfig(env = process.env): McpConfig` with `{ network: BchNetwork; satchelUrl: string; home: string; maxPriceSats: bigint; agentKeyHex?: string }`; invalid `SATCHEL_NETWORK` or non-integer `SATCHEL_MAX_PRICE_SATS` throws a readable Error.
- `loadOrCreateAgentKey(cfg): { signer: SignatureTemplate; pubHex: string; created: boolean }` — env key wins; creates `agent.json` `{ v: 1, privateKey }` with 0600 in a 0700 dir only when absent; corrupted file → `Error("~/.satchel/agent.json is unreadable: …; fix or move it, Satchel will not overwrite it")`.
- `saveVault(cfg, info: ConnectInfo)` / `loadVault(cfg): ConnectInfo | null` (`vault-<network>.json`, 0600).
- `build.mjs`: esbuild `src/index.ts` → `dist/index.js`, `platform: "node"`, `format: "esm"`, `target: "node22"`, `bundle: true`, externals = the four runtime deps, banner `#!/usr/bin/env node`, JSON loader.

- [ ] **Step 1: Write the failing tests** (`SATCHEL_HOME` = a fresh `fs.mkdtemp` dir): creates the key once (second call `created: false`, same pubkey); file mode `0o600`, dir `0o700`; `SATCHEL_AGENT_KEY` used without writing a file; corrupted `agent.json` throws the message above and the file is unchanged; `loadConfig({ SATCHEL_NETWORK: "testnet" })` throws; vault save/load round-trip per network.
- [ ] **Step 2: Run** `npx vitest run mcp/src` — FAIL. **Step 3: Implement**; `cd mcp && npm install`. **Step 4: Run** — PASS; `npm run typecheck` (root) still passes.
- [ ] **Step 5: Commit** `feat(mcp): package scaffold, config and local key store`.

### Task 6: MCP tool handlers

**Files:**
- Create: `mcp/src/tools.ts`, `mcp/src/tools.test.ts`

**Interfaces:**
- Consumes: Task 1 (`VaultSpender`, `parseChallenge`, `memoForChallenge`, `encodePaymentHeader`, `retryPaidRequest`), Task 3 (`decodeConnectCode`), Task 5 (config, keystore, vault-store), `getVaultContract`, `findVaultUtxo`, `remainingBudget`, `decodeState` from `src/lib/vault.ts`.
- Produces: `createHandlers(deps: { cfg: McpConfig; provider: NetworkProvider; fetch: typeof fetch; spender: VaultSpender })` returning
  `{ setup(): Promise<ToolResult>; connect(code: string): Promise<ToolResult>; status(): Promise<ToolResult>; catalog(): Promise<ToolResult>; payFetch(a: { url: string; method?: "GET" | "POST"; body?: Record<string, unknown> }): Promise<ToolResult> }`
  where `ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean }` and `text` is pretty JSON (bigints as strings). `setup` returns `{ agentPk, network, createVaultUrl: `${satchelUrl}/?agent=${agentPk}`, connectedVault }`.
- Guards in `payFetch` (in order): vault connected; challenge parses (Task 1); `payTo ∈ params.allowlist` else `"payee … is not in this vault's allowlist; not paying"`; `amount ≤ maxPriceSats` else `"price … sats exceeds SATCHEL_MAX_PRICE_SATS (…)"`; pay via `spender.pay`; covenant refusal → `isError` text starting `"The vault's covenant refused this payment"`; after payment use `retryPaidRequest`; failure after payment → `isError` text containing the txid.

- [ ] **Step 1: Write the failing tests** with MockNetworkProvider (NodeLikeProvider from Task 1's test), a vault created by a local owner for the keystore's agent key, and a fake `fetch` implementing one bch-sc402 endpoint (first call 402 with a challenge for `payTo`; with `x-payment`, decode, check the tx in the provider pays `payTo` with the memo, return 200 `{ result }`):
  - `setup` returns `agentPk` and `createVaultUrl` ending in `?agent=<agentPk>`; output never contains the private key hex.
  - `connect` with a code for another agent key → `isError`, nothing saved (Review Focus 3); with a code for another network → `isError`; valid code → saved, balance in text.
  - `connect` a second valid vault on the same network → saved, and the text names the replaced vault address (one vault per network).
  - `payFetch` happy path → result + txid; vault balance dropped by amount + fee.
  - payee not in allowlist → `isError`, no tx broadcast.
  - amount > max price → `isError`, no tx.
  - challenge for another network / scheme → `isError`, no tx (Review Focus 1).
  - hitting the cap → `isError` starting with the covenant sentence.
  - endpoint 502 forever after payment → `isError` containing the txid (Review Focus 2).
  - vault withdrawn by the owner → `status` and `payFetch` say `"vault is closed"` (Review Focus 4).
  - two `payFetch` calls in parallel both succeed (serialized spends).
- [ ] **Step 2: Run** `npx vitest run mcp/src/tools.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mcp): tool handlers with layered spend guards`.

### Task 7: MCP server wiring and build

**Files:**
- Create: `mcp/src/index.ts`, `mcp/src/server.test.ts`

**Interfaces:**
- Consumes: Task 6 `createHandlers`, Task 5 `loadConfig`.
- Produces: `createSatchelServer(handlers): McpServer` (exported for tests) registering the five tools with zod input schemas and one-sentence descriptions that state each paid call spends real BCH from the vault; `index.ts` runs `loadConfig`, `ElectrumNetworkProvider(cfg.network)`, `new VaultSpender()`, stdio transport; startup/config errors go to stderr and exit 1.

- [ ] **Step 1: Write the failing test** using the SDK `Client` + `InMemoryTransport.createLinkedPair()`: `listTools()` returns exactly the five names; `callTool("satchel_setup")` returns text with `agentPk`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** tests — PASS; `cd mcp && npm run build` produces `dist/index.js` starting with `#!/usr/bin/env node`; `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | SATCHEL_HOME=$(mktemp -d) node mcp/dist/index.js` prints one JSON-RPC response on stdout and nothing else.
- [ ] **Step 5: Commit** `feat(mcp): stdio server and bundle`.

### Task 8: Mainnet end-to-end over real stdio

**Files:**
- Create: `scripts/mcp-e2e.mts`

**Interfaces:**
- Consumes: built `mcp/dist/index.js`; `buildGenesis`, `encodeRecoveryMemo`, `EXTERNAL_AGENT_INDEX`, `encodeConnectCode`, `buildWithdraw`; the local test owner key logic from `scripts/e2e.mts` (`MAINNET_OWNER_SEED`, guard `E2E_ALLOW_MAINNET=1`).
- Flow: spawn the server with `StdioClientTransport` (temp `SATCHEL_HOME`, `SATCHEL_URL=http://localhost:3000`) → `satchel_setup` → owner creates a vault for that `agentPk` (deposit `E2E_DEPOSIT`, cap `E2E_CAP`, memo with external index) → `satchel_connect(encodeConnectCode(...))` → `satchel_pay_fetch` `crypto-price` until a covenant refusal → owner withdraw → print every txid with explorer links.

- [ ] **Step 1:** Implement. **Step 2: Run** (dev server on mainnet) `NEXT_PUBLIC_BCH_NETWORK=mainnet E2E_ALLOW_MAINNET=1 E2E_DEPOSIT=6000 E2E_CAP=2500 npx tsx scripts/mcp-e2e.mts` — Expected: genesis txid, ≥1 paid call with a result, a covenant refusal, withdraw txid; all txids found on mainnet afterwards.
- [ ] **Step 3: Commit** `test(mcp): mainnet end-to-end over stdio`.

### Task 9: Docs, client snippets and release readiness

**Files:**
- Create: `mcp/README.md`
- Modify: `README.md` (section "Use Satchel from your own agent"), `CLAUDE.md` (layout + commands for `mcp/`)

- [ ] **Step 1:** Write `mcp/README.md`: what it does, the security model (covenant + local key + guards), install snippets for Claude Desktop (JSON), Claude Code (`claude mcp add satchel -- npx -y satchel-pay-mcp@0.1.0`), Cursor (`mcp.json`), VS Code, Codex CLI (`[mcp_servers.satchel]` TOML, note the underscore), Gemini CLI (`mcpServers`), env table, the five tools, and the bch-sc402 protocol in brief.
- [ ] **Step 2: Manual smoke test** in one non-Claude client available on this machine (Codex CLI or Cursor) with `node mcp/dist/index.js`: `satchel_setup` and `satchel_status` answer. If none is installed, say so in the report.
- [ ] **Step 3: Run** `cd mcp && npm pack --dry-run` — Expected: only `dist/index.js`, `README.md`, `package.json`.
- [ ] **Step 4: Commit** `docs(mcp): README and client setup snippets`.
- [ ] **Step 5 (after the web app is deployed):** set `DEFAULT_SATCHEL_URL`, rebuild, **ask the user**, then `cd mcp && npm publish --access public`; verify `npx -y satchel-pay-mcp@0.1.0` starts.
