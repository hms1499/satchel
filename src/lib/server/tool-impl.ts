import { generateText } from "ai";
import type { ToolName } from "../tools";
import { AGENT_MODEL, hasLlm } from "./llm";

export class ToolInputError extends Error {}

async function cryptoPrice(params: URLSearchParams) {
  const id = (params.get("id") ?? "bitcoin-cash").toLowerCase();
  if (!/^[a-z0-9-]{2,60}$/.test(id)) throw new ToolInputError("id must be a CoinGecko coin id, e.g. bitcoin-cash");
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

async function webReader(params: URLSearchParams) {
  const url = isPublicHttpsUrl(params.get("url") ?? "");
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
    headers: { "user-agent": "SatchelReader/0.1 (+hackathon demo)", accept: "text/html,text/plain" },
  });
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
  if (!hasLlm()) {
    return {
      analysis: `Demo mode (no LLM configured): received ${material.length} characters of material for the question "${question}".`,
      model: "none",
    };
  }
  const { text } = await generateText({
    model: AGENT_MODEL,
    system:
      "You are a concise research analyst. Answer in at most 120 words with 3-5 bullet points. Use only the provided material; say what is uncertain. Never give financial advice.",
    prompt: `Question: ${question}\n\nMaterial:\n${material}`,
  });
  return { analysis: text, model: AGENT_MODEL };
}

export async function runTool(name: ToolName, params: URLSearchParams): Promise<unknown> {
  switch (name) {
    case "crypto-price":
      return cryptoPrice(params);
    case "web-reader":
      return webReader(params);
    case "deep-analysis":
      return deepAnalysis(params);
  }
}
