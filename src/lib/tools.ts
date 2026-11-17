/** Paid tools served by Satchel's pay-per-call (HTTP 402) API. Prices in sats. */
export const PAID_TOOLS = {
  "crypto-price": {
    title: "Crypto price feed",
    description: "Live USD price, 24h change and market cap for a cryptocurrency (CoinGecko id, e.g. bitcoin-cash).",
    price: 1_000n,
    provider: 0,
    params: { id: "CoinGecko coin id, e.g. bitcoin-cash (default), ethereum, bitcoin" },
  },
  "web-reader": {
    title: "Web page reader",
    description: "Fetches a public web page and returns its readable text (first ~4000 characters).",
    price: 1_500n,
    provider: 1,
    params: { url: "A public https:// URL" },
  },
  "deep-analysis": {
    title: "Deep analysis",
    description: "A premium analyst model that writes a concise, structured analysis of the provided material.",
    price: 3_000n,
    provider: 2,
    params: { question: "What to analyse (required)", material: "The facts or text to analyse" },
  },
  // Append only: a tool's provider index fixes its payout address, so existing indexes must never move.
  "bch-address": {
    title: "BCH address lookup",
    description:
      "Balance (confirmed and unconfirmed), UTXO count, CashTokens held by category and the last 10 transactions of a BCH address.",
    price: 800n,
    provider: 3,
    params: { address: "A BCH address (CashAddr)" },
  },
  "bch-tx": {
    title: "BCH transaction decoder",
    description:
      "Decodes a BCH transaction: confirmations, inputs, outputs (address, value, token data), OP_RETURN data, size and fee.",
    price: 500n,
    provider: 4,
    params: { txid: "A transaction id (64 hex chars)" },
  },
} as const;

/**
 * Miner fee of one agent payment, shown to users because it counts toward the cap. Measured: a payment from the
 * covenant is ~689 bytes at 1 sat/byte (redeem script 310 B, 3-payee allowlist 96 B, outputs 156 B).
 */
export const EST_FEE_PER_CALL = 700n;

export type ToolName = keyof typeof PAID_TOOLS;
export const TOOL_NAMES = Object.keys(PAID_TOOLS) as ToolName[];
export const PROVIDER_COUNT = 5;

/** The tools Satchel's hosted agent calls (`agent-runner.ts`). The chain tools are for MCP agents. */
export const HOSTED_AGENT_TOOLS = ["crypto-price", "web-reader", "deep-analysis"] as const satisfies readonly ToolName[];
export type HostedToolName = (typeof HOSTED_AGENT_TOOLS)[number];

/**
 * Whether a tool's payee is ticked by default when creating a vault. A hosted vault only needs the hosted agent's
 * tools (each extra payee makes every payment bigger); an external (MCP) vault may call any tool.
 */
export const defaultAllowed = (name: ToolName, external: boolean): boolean =>
  external || (HOSTED_AGENT_TOOLS as readonly ToolName[]).includes(name);
