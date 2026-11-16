/** Paid tools served by Satchel's pay-per-call (HTTP 402) API. Prices in sats. */
export const PAID_TOOLS = {
  "crypto-price": {
    title: "Crypto price feed",
    description: "Live USD price, 24h change and market cap for a cryptocurrency (CoinGecko id, e.g. bitcoin-cash).",
    price: 1_000n,
    provider: 0,
  },
  "web-reader": {
    title: "Web page reader",
    description: "Fetches a public web page and returns its readable text (first ~4000 characters).",
    price: 1_500n,
    provider: 1,
  },
  "deep-analysis": {
    title: "Deep analysis",
    description: "A premium analyst model that writes a concise, structured analysis of the provided material.",
    price: 3_000n,
    provider: 2,
  },
} as const;

export type ToolName = keyof typeof PAID_TOOLS;
export const TOOL_NAMES = Object.keys(PAID_TOOLS) as ToolName[];
export const PROVIDER_COUNT = 3;
