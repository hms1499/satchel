import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import type { ToolName } from "../tools";
import type { openDescriptor } from "./agent-wallet";
import { AGENT_MODEL, hasLlm } from "./llm";
import { paidCall, type Emit } from "./paid-client";

type Opened = ReturnType<typeof openDescriptor>;

function summarize(tool: ToolName, result: unknown): string {
  const r = result as Record<string, unknown>;
  if (tool === "crypto-price") {
    const change = r.change24hPct === null ? "n/a" : `${r.change24hPct}%`;
    return `${r.id}: $${r.priceUsd} (24h ${change})`;
  }
  if (tool === "web-reader") return `${r.title ?? r.url}: ${String(r.text ?? "").slice(0, 140)}…`;
  return String(r.analysis ?? "").slice(0, 400);
}

function makeTools(origin: string, opened: Opened, emit: Emit) {
  const call = async (name: ToolName, body: Record<string, string>) => {
    const res = await paidCall(origin, opened, name, body, emit);
    if (res.ok) emit({ type: "tool-result", tool: name, summary: summarize(name, res.result) });
    return res.ok ? res.result : { error: res.error };
  };
  return {
    crypto_price: tool({
      description: "Paid (1,000 sats): live USD price, 24h change and market cap for one cryptocurrency by CoinGecko id.",
      inputSchema: z.object({ id: z.string().describe("CoinGecko id, e.g. bitcoin-cash, ethereum, bitcoin") }),
      execute: ({ id }) => call("crypto-price", { id }),
    }),
    read_web_page: tool({
      description: "Paid (1,500 sats): fetch a public https web page and return its readable text.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: ({ url }) => call("web-reader", { url }),
    }),
    deep_analysis: tool({
      description: "Paid (3,000 sats): a premium analyst model writes a structured brief from the material you provide.",
      inputSchema: z.object({ question: z.string(), material: z.string().describe("All facts you gathered so far") }),
      execute: ({ question, material }) => call("deep-analysis", { question, material }),
    }),
  };
}

const INSTRUCTIONS = `You are a research agent with a Bitcoin Cash wallet. Your tools are paid APIs: each call is paid
automatically from your Satchel vault, which has an on-chain spending cap per period.
Be thorough: fetch the price of each coin you discuss separately, read at least one relevant web page
(for example https://en.wikipedia.org/wiki/Bitcoin_Cash), and use deep_analysis for the final brief.
If a payment is refused, do not retry it: explain that the vault's budget for this period is exhausted and
answer with what you already have. Keep the final answer under 120 words. Never give financial advice.`;

/** Scripted plan used when no LLM is configured, so the demo always works. */
async function runScripted(prompt: string, tools: ReturnType<typeof makeTools>, emit: Emit) {
  const exec = <T,>(t: { execute?: (input: T, opts: never) => unknown }, input: T) =>
    Promise.resolve(t.execute!(input, {} as never)) as Promise<Record<string, unknown>>;
  const facts: string[] = [];
  emit({ type: "thought", text: "Demo mode (no LLM configured): running a fixed research plan." });
  emit({ type: "thought", text: "First, live prices for BCH and ETH." });
  for (const id of ["bitcoin-cash", "ethereum"]) {
    const r = await exec(tools.crypto_price, { id });
    if (r.error) return finish(facts, emit, String(r.error));
    facts.push(`${id} price $${r.priceUsd}, 24h ${r.change24hPct}%`);
  }
  emit({ type: "thought", text: "Now some background reading." });
  const page = await exec(tools.read_web_page, { url: "https://en.wikipedia.org/wiki/Bitcoin_Cash" });
  if (page.error) return finish(facts, emit, String(page.error));
  facts.push(String(page.text ?? "").slice(0, 1500));
  emit({ type: "thought", text: "Asking the analyst for a brief, then an extended version." });
  for (const question of [prompt, `${prompt} (extended version with more detail)`]) {
    const r = await exec(tools.deep_analysis, { question, material: facts.join("\n") });
    if (r.error) return finish(facts, emit, String(r.error));
    facts.push(String(r.analysis ?? ""));
  }
  return finish(facts, emit);
}

function finish(facts: string[], emit: Emit, error?: string) {
  const prices = facts.filter((f) => f.includes(" price $")).join("; ");
  const bought = `What I bought so far: ${prices || "no data yet"}.`;
  emit({
    type: "final",
    text: !error
      ? `Done. ${prices}`
      : error.startsWith("Payment refused")
        ? `My vault refused the last payment: this period's budget is used up. ${bought}`
        : `I had to stop: ${error}. ${bought}`,
  });
}

export async function runAgent(origin: string, opened: Opened, prompt: string, emit: Emit) {
  const tools = makeTools(origin, opened, emit);
  if (!hasLlm()) return runScripted(prompt, tools, emit);

  const agent = new ToolLoopAgent({
    model: AGENT_MODEL,
    instructions: INSTRUCTIONS,
    tools,
    stopWhen: isStepCount(10),
  });
  const result = await agent.generate({ prompt });
  emit({ type: "final", text: result.text || "(no answer)" });
}
