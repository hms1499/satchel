import { generateText } from "ai";
import { PAID_TOOLS, type ToolName } from "../tools";
import { TOOL_MODEL, toolUsesLlm } from "./llm";
import { InputError as ToolInputError } from "../../../provider-kit/src/index";
import { addressInfo, checkAddress, checkTxid, electrumRpc, fetchTransaction, txInfo, type Rpc } from "./chain-tools";

/** Bad input: answered 400 by the paywall, before payment from `validateToolInput`, after it from `runTool`. */
export { ToolInputError };

async function cryptoPrice(params: URLSearchParams) {
  const id = (params.get("id") ?? "bitcoin-cash").toLowerCase();
  if (!COIN_ID.test(id)) throw new ToolInputError("id must be a CoinGecko coin id, e.g. bitcoin-cash");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`price source returned ${res.status}`);
  const data = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number; usd_market_cap?: number }>;
  const row = data[id];
  if (!row?.usd) throw new ToolInputError(`unknown coin id: ${id}`);
  return {
    id,
    priceUsd: row.usd,
    change24hPct: row.usd_24h_change !== undefined ? Number(row.usd_24h_change.toFixed(2)) : null,
    marketCapUsd: row.usd_market_cap ?? null,
    source: "CoinGecko",
  };
}

function isPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolInputError("url must be a valid absolute URL");
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    url.protocol !== "https:" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    !host.includes(".");
  if (blocked) throw new ToolInputError("only public https:// URLs with a domain name are allowed");
  return url;
}

const MAX_REDIRECTS = 3;

async function webReader(params: URLSearchParams) {
  let url = isPublicHttpsUrl(params.get("url") ?? "");
  let res: Response;
  // Follow redirects by hand so every hop passes the public-URL guard (no redirect into private networks).
  for (let hop = 0; ; hop++) {
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: { "user-agent": "SatchelReader/0.1 (+hackathon demo)", accept: "text/html,text/plain" },
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    await res.body?.cancel(); // release the redirect response before the next hop
    if (hop >= MAX_REDIRECTS) throw new ToolInputError("too many redirects");
    url = isPublicHttpsUrl(new URL(location, url).toString());
  }
  if (!res.ok) throw new Error(`page returned ${res.status}`);
  const html = (await res.text()).slice(0, 400_000);
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  return { url: url.toString(), title, text };
}

async function deepAnalysis(params: URLSearchParams) {
  const question = (params.get("question") ?? "").slice(0, 500);
  const material = (params.get("material") ?? "").slice(0, 6000);
  if (!question) throw new ToolInputError("question is required");
  if (!toolUsesLlm()) {
    return {
      analysis: `Demo mode (no live model configured): received ${material.length} characters of material for the question "${question}".`,
      model: "none",
    };
  }
  const { text } = await generateText({
    model: TOOL_MODEL,
    system:
      "You are a concise research analyst. Answer in at most 120 words with 3-5 bullet points. Use only the provided material; say what is uncertain. Never give financial advice.",
    prompt: `Question: ${question}\n\nMaterial:\n${material}`,
  });
  return { analysis: text, model: TOOL_MODEL };
}

const COIN_ID = /^[a-z0-9-]{2,60}$/;

/**
 * Checks a request before any payment is asked for, so a caller never pays for a call that can only fail:
 * unknown parameter names (an agent guessing names), missing or invalid required values, an unknown txid.
 * `deps.rpc` is the Electrum client (stubbed in tests).
 */
export async function validateToolInput(
  name: ToolName,
  params: URLSearchParams,
  deps: { rpc: Rpc } = { rpc: electrumRpc },
): Promise<void> {
  const expected = Object.keys(PAID_TOOLS[name].params);
  for (const key of params.keys()) {
    if (!expected.includes(key)) throw new ToolInputError(`unknown parameter "${key}"; expected: ${expected.join(", ")}`);
  }
  if (name === "crypto-price") {
    const id = params.get("id");
    if (id !== null && !COIN_ID.test(id.toLowerCase())) throw new ToolInputError("id must be a CoinGecko coin id, e.g. bitcoin-cash");
  } else if (name === "web-reader") {
    isPublicHttpsUrl(params.get("url") ?? "");
  } else if (name === "bch-address") {
    checkAddress(params.get("address"));
  } else if (name === "bch-tx") {
    await fetchTransaction(checkTxid(params.get("txid")), deps.rpc);
  } else if (!params.get("question")) {
    throw new ToolInputError("question is required");
  }
}

export async function runTool(name: ToolName, params: URLSearchParams): Promise<unknown> {
  switch (name) {
    case "crypto-price":
      return cryptoPrice(params);
    case "web-reader":
      return webReader(params);
    case "deep-analysis":
      return deepAnalysis(params);
    case "bch-address":
      return addressInfo(params.get("address") ?? "", electrumRpc);
    case "bch-tx":
      return txInfo(params.get("txid") ?? "", electrumRpc);
  }
}
