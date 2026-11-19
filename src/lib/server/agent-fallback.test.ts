import { afterEach, describe, expect, it, vi } from "vitest";

// Real AI SDK + real Groq provider; only the network (global fetch) and the paid tool calls are stubbed.
const paidCall = vi.fn(async (_o: string, _d: unknown, tool: string, _b: unknown, emit: (e: unknown) => void) => {
  emit({ type: "paid", tool, txid: "t", url: "u", amount: "1000", fee: "700", spentInPeriod: "1700", remaining: "0", balance: "0" });
  return { ok: true, result: tool === "crypto-price" ? { id: "x", priceUsd: 1, change24hPct: 0 } : { text: "t", analysis: "a" } };
});
vi.mock("./paid-client", () => ({ paidCall: (...a: Parameters<typeof paidCall>) => paidCall(...a) }));

import { runAgent } from "./agent-runner";

describe("hosted agent on Groq fails fast and falls back", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    paidCall.mockClear();
  });

  it("a rate limit with a long retry-after switches to the scripted plan within seconds", async () => {
    vi.stubEnv("AGENT_MODE", "llm");
    vi.stubEnv("GROQ_API_KEY", "g");
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit reached on tokens per day", type: "tokens" } }), {
        status: 429,
        headers: { "retry-after": "600", "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const events: { type: string; text?: string }[] = [];
    const t0 = Date.now();
    await runAgent("http://x", {} as never, "BCH vs ETH?", (e) => events.push(e as { type: string; text?: string }));
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(fetch).toHaveBeenCalledTimes(1); // no SDK retry loop
    expect(events.some((e) => e.type === "status" && /falling back/i.test(e.text ?? ""))).toBe(true);
    expect(events.some((e) => e.type === "thought" && /instead/.test(e.text ?? ""))).toBe(true);
    expect(paidCall).toHaveBeenCalledTimes(5); // the scripted plan ran
    expect(events.at(-1)?.type).toBe("final");
  });
});
